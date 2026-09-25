import type { PoolClient } from "pg";
import { config } from "./config";
import { pool } from "./db";
import { buildDigestMessage, buildInstantMessage } from "./geofence-message";

const RECOMPUTE_BATCH = 10;
const DIGEST_BATCH = 20;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function insertNotificationWithEmail(
  client: PoolClient,
  input: { userId: string; email: string; type: string; title: string; body: string; link: string }
): Promise<void> {
  await client.query(
    `INSERT INTO notifications(user_id, type, title, body, link) VALUES ($1, $2, $3, $4, $5)`,
    [input.userId, input.type, input.title, input.body, input.link]
  );
  const link = `${config.APP_ORIGIN}${input.link}`;
  await client.query(
    `INSERT INTO outbox_events(event_type, aggregate_type, aggregate_id, payload)
     VALUES ('email.notification', 'user', $1, $2::jsonb)`,
    [
      input.userId,
      JSON.stringify({
        to: input.email,
        subject: input.title,
        text: `${input.body}\n\n${link}`,
        html: `<p>${escapeHtml(input.body)}</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`
      })
    ]
  );
}

type MatchPair = { subscriptionId: string; featureId: string };

/**
 * 为本事务内新插入的匹配发送即时提醒。
 * 可见权限在发送前再次校验：只有当前 published 且未删除的内容才会产生通知，
 * 账号被停用（非 active）的用户不会收到任何消息。
 */
async function dispatchInstantNotifications(client: PoolClient, pairs: MatchPair[]): Promise<void> {
  if (!pairs.length) return;
  const subscriptionIds = [...new Set(pairs.map((pair) => pair.subscriptionId))];
  const featureIds = [...new Set(pairs.map((pair) => pair.featureId))];
  const matched = await client.query<{
    subscription_id: string;
    feature_id: string;
    subscription_name: string;
    user_id: string;
    email: string;
    category_name: string;
    feature_title: string;
  }>(
    `SELECT m.subscription_id, m.feature_id, s.name AS subscription_name,
            s.user_id, u.email, c.name AS category_name,
            fr.payload->>'title' AS feature_title
     FROM geofence_matches m
     JOIN geofence_subscriptions s ON s.id = m.subscription_id AND s.frequency = 'instant'
     JOIN users u ON u.id = s.user_id AND u.status = 'active'
     JOIN map_features f ON f.id = m.feature_id AND f.status = 'published' AND f.deleted_at IS NULL
     JOIN categories c ON c.key = f.category_key
     JOIN feature_revisions fr ON fr.id = f.current_revision_id
     WHERE m.notified_at IS NULL
       AND m.subscription_id = ANY($1::uuid[])
       AND m.feature_id = ANY($2::uuid[])`,
    [subscriptionIds, featureIds]
  );

  for (const row of matched.rows) {
    const { title, body } = buildInstantMessage({
      subscriptionName: row.subscription_name,
      featureTitle: row.feature_title,
      categoryName: row.category_name
    });
    await insertNotificationWithEmail(client, {
      userId: row.user_id,
      email: row.email,
      type: "geofence_match",
      title,
      body,
      link: `/features/${row.feature_id}`
    });
    await client.query(
      "UPDATE geofence_matches SET notified_at = now() WHERE subscription_id = $1 AND feature_id = $2",
      [row.subscription_id, row.feature_id]
    );
  }
}

/** 新发布内容 → 匹配所有启用中的订阅。幂等：重复处理不会产生重复匹配或通知。 */
export async function processFeatureScan(featureId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const feature = await client.query(
      `SELECT id FROM map_features WHERE id = $1 AND status = 'published' AND deleted_at IS NULL`,
      [featureId]
    );
    if (feature.rows[0]) {
      const inserted = await client.query<{ subscription_id: string }>(
        `INSERT INTO geofence_matches(subscription_id, feature_id, scope_version)
         SELECT s.id, f.id, s.scope_version
         FROM geofence_subscriptions s, map_features f
         WHERE f.id = $1
           AND s.deleted_at IS NULL AND s.is_active
           AND ST_DWithin(s.center, f.geom, s.radius_m)
           AND (cardinality(s.category_keys) = 0 OR f.category_key = ANY(s.category_keys))
           AND s.user_id <> f.owner_id
         ON CONFLICT DO NOTHING
         RETURNING subscription_id`,
        [featureId]
      );
      await dispatchInstantNotifications(
        client,
        inserted.rows.map((row) => ({ subscriptionId: row.subscription_id, featureId }))
      );
    }
    await client.query(
      "UPDATE geofence_scan_events SET status = 'done', processed_at = now() WHERE feature_id = $1 AND status = 'pending'",
      [featureId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** 兜底扫描：处理队列遗漏的发布事件（数据库是事实源）。 */
export async function processPendingGeofenceScans(limit = 20): Promise<void> {
  const pending = await pool.query<{ feature_id: string }>(
    `SELECT feature_id FROM geofence_scan_events
     WHERE status = 'pending'
     GROUP BY feature_id
     ORDER BY min(created_at)
     LIMIT $1`,
    [limit]
  );
  for (const row of pending.rows) {
    try {
      await processFeatureScan(row.feature_id);
    } catch (error) {
      console.error({ featureId: row.feature_id, error }, "geofence scan failed");
    }
  }
}

/**
 * 范围变更后的重算：
 * 1. 删除已不在新范围内、且尚未通知的匹配（已通知的保留，作为去重记忆）；
 * 2. 补插当前可见且落入新范围的存量内容；
 * 3. 只把游标推进到事务开始时捕获的 scope_version，并发变更留待下一轮。
 */
export async function recomputeSubscription(subscriptionId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const subscription = await client.query<{ scope_version: number }>(
      `SELECT scope_version FROM geofence_subscriptions
       WHERE id = $1 AND deleted_at IS NULL AND is_active
       FOR UPDATE`,
      [subscriptionId]
    );
    const row = subscription.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return;
    }
    const version = row.scope_version;

    await client.query(
      `DELETE FROM geofence_matches m
       USING geofence_subscriptions s, map_features f
       WHERE m.subscription_id = s.id AND m.feature_id = f.id
         AND m.subscription_id = $1
         AND m.notified_at IS NULL
         AND (NOT ST_DWithin(s.center, f.geom, s.radius_m)
              OR (cardinality(s.category_keys) > 0 AND NOT (f.category_key = ANY(s.category_keys))))`,
      [subscriptionId]
    );

    const inserted = await client.query<{ feature_id: string }>(
      `INSERT INTO geofence_matches(subscription_id, feature_id, scope_version)
       SELECT s.id, f.id, s.scope_version
       FROM geofence_subscriptions s, map_features f
       WHERE s.id = $1
         AND f.status = 'published' AND f.deleted_at IS NULL
         AND ST_DWithin(s.center, f.geom, s.radius_m)
         AND (cardinality(s.category_keys) = 0 OR f.category_key = ANY(s.category_keys))
         AND f.owner_id <> s.user_id
       ON CONFLICT DO NOTHING
       RETURNING feature_id`,
      [subscriptionId]
    );
    await dispatchInstantNotifications(
      client,
      inserted.rows.map((feature) => ({ subscriptionId, featureId: feature.feature_id }))
    );

    await client.query(
      "UPDATE geofence_subscriptions SET recomputed_version = $2 WHERE id = $1",
      [subscriptionId, version]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** 兜底扫描：重算所有 scope_version 领先的订阅。 */
export async function recomputeSubscriptions(): Promise<void> {
  const due = await pool.query<{ id: string }>(
    `SELECT id FROM geofence_subscriptions
     WHERE deleted_at IS NULL AND is_active AND recomputed_version < scope_version
     ORDER BY updated_at ASC
     LIMIT $1`,
    [RECOMPUTE_BATCH]
  );
  for (const row of due.rows) {
    try {
      await recomputeSubscription(row.id);
    } catch (error) {
      console.error({ subscriptionId: row.id, error }, "subscription recompute failed");
    }
  }
}

async function sendDigest(subscriptionId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const subscription = await client.query<{ name: string; user_id: string; email: string }>(
      `SELECT s.name, s.user_id, u.email
       FROM geofence_subscriptions s
       JOIN users u ON u.id = s.user_id AND u.status = 'active'
       WHERE s.id = $1 AND s.deleted_at IS NULL AND s.is_active
       FOR UPDATE OF s`,
      [subscriptionId]
    );
    const row = subscription.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return;
    }

    // 认领待通知匹配：可见性在发送时再次校验，隐藏/删除的内容不会进入摘要
    const claimed = await client.query<{ feature_id: string; title: string; category_name: string }>(
      `UPDATE geofence_matches m
       SET notified_at = now()
       FROM map_features f
       JOIN categories c ON c.key = f.category_key
       JOIN feature_revisions fr ON fr.id = f.current_revision_id
       WHERE m.feature_id = f.id
         AND m.subscription_id = $1
         AND m.notified_at IS NULL
         AND f.status = 'published' AND f.deleted_at IS NULL
       RETURNING m.feature_id, fr.payload->>'title' AS title, c.name AS category_name`,
      [subscriptionId]
    );

    if (claimed.rows.length) {
      const { title, body } = buildDigestMessage({
        subscriptionName: row.name,
        items: claimed.rows.map((item) => ({ title: item.title, categoryName: item.category_name })),
        totalCount: claimed.rows.length
      });
      await insertNotificationWithEmail(client, {
        userId: row.user_id,
        email: row.email,
        type: "geofence_digest",
        title,
        body,
        link: "/me/subscriptions"
      });
      await client.query("UPDATE geofence_subscriptions SET last_digest_at = now() WHERE id = $1", [subscriptionId]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** 到期的 daily/weekly 订阅发送聚合摘要；没有可见新动态时不发送。 */
export async function sendSubscriptionDigests(): Promise<void> {
  const due = await pool.query<{ id: string }>(
    `SELECT s.id FROM geofence_subscriptions s
     JOIN users u ON u.id = s.user_id AND u.status = 'active'
     WHERE s.deleted_at IS NULL AND s.is_active
       AND s.frequency IN ('daily', 'weekly')
       AND (s.last_digest_at IS NULL
            OR s.last_digest_at + CASE s.frequency
                 WHEN 'daily' THEN interval '1 day'
                 ELSE interval '7 days' END <= now())
       AND EXISTS (
         SELECT 1 FROM geofence_matches m
         JOIN map_features f ON f.id = m.feature_id
         WHERE m.subscription_id = s.id
           AND m.notified_at IS NULL
           AND f.status = 'published' AND f.deleted_at IS NULL
       )
     ORDER BY s.last_digest_at ASC NULLS FIRST
     LIMIT $1`,
    [DIGEST_BATCH]
  );
  for (const row of due.rows) {
    try {
      await sendDigest(row.id);
    } catch (error) {
      console.error({ subscriptionId: row.id, error }, "subscription digest failed");
    }
  }
}

/** 清理不再可见内容的未通知匹配，保证摘要永远不会越过可见权限。 */
export async function purgeInvisibleMatches(): Promise<void> {
  await pool.query(
    `DELETE FROM geofence_matches m
     USING map_features f
     WHERE m.feature_id = f.id
       AND m.notified_at IS NULL
       AND (f.status <> 'published' OR f.deleted_at IS NOT NULL)`
  );
}

export async function purgeOldGeofenceScanEvents(): Promise<void> {
  await pool.query(
    "DELETE FROM geofence_scan_events WHERE status = 'done' AND processed_at < now() - interval '7 days'"
  );
}

import { buildGeofenceDigestText, digestIntervalText } from "@map/shared/geofence";
import { config } from "./config";
import { pool } from "./db";

type DueSubscription = {
  id: string;
  user_id: string;
  name: string;
  frequency: "daily" | "weekly";
  email: string;
};

/**
 * 每日/每周摘要任务：由 maintenance tick 周期调用。
 * 对每个到期的订阅，把 notified_at IS NULL 的匹配聚合成一条通知 + 一封邮件。
 * 发送前重新校验要素可见性（status='published' 且未删除），匹配后被隐藏的
 * 要素不会进入通知，保持待发送状态直到恢复可见，绝不越过可见权限。
 */
export async function processGeofenceDigests(): Promise<void> {
  const due = await pool.query<{ id: string }>(
    `SELECT s.id
     FROM geofence_subscriptions s
     JOIN users u ON u.id = s.user_id AND u.status = 'active' AND u.deleted_at IS NULL
     WHERE s.is_active
       AND s.frequency IN ('daily', 'weekly')
       AND s.next_digest_at IS NOT NULL
       AND s.next_digest_at <= now()
     ORDER BY s.next_digest_at
     LIMIT 20`
  );
  for (const row of due.rows) {
    try {
      await processOneDigest(row.id);
    } catch (error) {
      console.error({ error, subscriptionId: row.id }, "geofence digest failed");
    }
  }
}

async function processOneDigest(subscriptionId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // 行锁 + 到期条件复查，保证多实例 worker 不会重复发送同一期摘要
    const locked = await client.query<DueSubscription>(
      `SELECT s.id, s.user_id, s.name, s.frequency, u.email
       FROM geofence_subscriptions s
       JOIN users u ON u.id = s.user_id AND u.status = 'active' AND u.deleted_at IS NULL
       WHERE s.id = $1
         AND s.is_active
         AND s.frequency IN ('daily', 'weekly')
         AND s.next_digest_at IS NOT NULL
         AND s.next_digest_at <= now()
       FOR UPDATE OF s`,
      [subscriptionId]
    );
    const sub = locked.rows[0];
    if (!sub) {
      await client.query("ROLLBACK");
      return;
    }

    const pending = await client.query<{ feature_id: string; title: string | null }>(
      `SELECT m.feature_id, fr.payload->>'title' AS title
       FROM geofence_subscription_matches m
       JOIN map_features mf ON mf.id = m.feature_id
       LEFT JOIN feature_revisions fr ON fr.id = mf.current_revision_id
       WHERE m.subscription_id = $1 AND m.notified_at IS NULL
         AND mf.status = 'published' AND mf.deleted_at IS NULL
       ORDER BY m.matched_at
       LIMIT 50`,
      [subscriptionId]
    );

    if (pending.rowCount) {
      const digest = buildGeofenceDigestText(
        sub.name,
        pending.rows.map((match) => match.title ?? "未命名地点"),
        pending.rowCount
      );
      const link = pending.rowCount === 1 ? `/features/${pending.rows[0]!.feature_id}` : "/map";
      await client.query(
        `INSERT INTO notifications(user_id, type, title, body, link)
         VALUES ($1, 'geofence_digest', $2, $3, $4)`,
        [sub.user_id, digest.title, digest.body, link]
      );
      const url = `${config.APP_ORIGIN}${link}`;
      await client.query(
        `INSERT INTO outbox_events(event_type, aggregate_type, aggregate_id, payload)
         VALUES ('email.notification', 'user', $1, $2::jsonb)`,
        [
          sub.user_id,
          JSON.stringify({
            to: sub.email,
            subject: digest.title,
            text: `${digest.body}\n\n${url}`,
            html: `<p>${escapeHtml(digest.body)}</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`
          })
        ]
      );
      await client.query(
        `UPDATE geofence_subscription_matches SET notified_at = now()
         WHERE subscription_id = $1 AND notified_at IS NULL AND feature_id = ANY($2::uuid[])`,
        [subscriptionId, pending.rows.map((match) => match.feature_id)]
      );
    }

    // 无论本期是否有内容都推进日程，避免空转追赶
    await client.query(
      `UPDATE geofence_subscriptions
       SET next_digest_at = now() + $2::interval, updated_at = now()
       WHERE id = $1`,
      [subscriptionId, digestIntervalText(sub.frequency)]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

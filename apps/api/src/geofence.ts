import type { PoolClient } from "pg";
import type { GeofenceFrequency } from "@map/shared/contracts";
import { buildGeofenceDigestText } from "@map/shared/geofence";
import { notifyUser } from "./notifications";

export { computeNextDigestAt, isScopeChange } from "@map/shared/geofence";

type SubscriptionRow = {
  id: string;
  user_id: string;
  name: string;
  radius_m: number;
  category_keys: string[];
  frequency: GeofenceFrequency;
  is_active: boolean;
  scope_version: number;
  longitude: number;
  latitude: number;
};

const SUBSCRIPTION_SELECT = `
  SELECT s.id, s.user_id, s.name, s.radius_m, s.category_keys, s.frequency, s.is_active, s.scope_version,
         ST_X(s.center::geometry) AS longitude, ST_Y(s.center::geometry) AS latitude
  FROM geofence_subscriptions s`;

/**
 * 单个已发布要素对所有启用订阅做增量匹配。
 * 可见性边界：只匹配 status='published' 且未删除的要素；不给要素作者本人
 * 推送自己的内容；不通知已停用/已删除账号。去重由匹配表主键保证，
 * 同一 (subscription, feature) 无论重算多少次都只通知一次。
 */
export async function matchSubscriptionsForFeature(client: PoolClient, featureId: string): Promise<void> {
  const feature = await client.query<{ owner_id: string; title: string | null }>(
    `SELECT mf.owner_id, fr.payload->>'title' AS title
     FROM map_features mf
     LEFT JOIN feature_revisions fr ON fr.id = mf.current_revision_id
     WHERE mf.id = $1 AND mf.status = 'published' AND mf.deleted_at IS NULL`,
    [featureId]
  );
  const row = feature.rows[0];
  if (!row) return;

  const inserted = await client.query<{ subscription_id: string }>(
    `INSERT INTO geofence_subscription_matches (subscription_id, feature_id, scope_version)
     SELECT s.id, mf.id, s.scope_version
     FROM geofence_subscriptions s
     JOIN users u ON u.id = s.user_id AND u.status = 'active' AND u.deleted_at IS NULL
     JOIN map_features mf ON mf.id = $1
     WHERE s.is_active
       AND s.user_id <> $2
       AND ST_DWithin(s.center, mf.geom, s.radius_m)
       AND (s.category_keys = '{}' OR mf.category_key = ANY(s.category_keys))
     ON CONFLICT (subscription_id, feature_id) DO NOTHING
     RETURNING subscription_id`,
    [featureId, row.owner_id]
  );
  if (!inserted.rowCount) return;

  // 即时频率立即通知并标记；daily/weekly 保持 notified_at IS NULL，由摘要任务结清。
  const instant = await client.query<{ user_id: string; name: string }>(
    `UPDATE geofence_subscription_matches m
     SET notified_at = now()
     FROM geofence_subscriptions s
     WHERE m.subscription_id = s.id
       AND m.feature_id = $1
       AND m.subscription_id = ANY($2::uuid[])
       AND s.frequency = 'instant'
     RETURNING s.user_id, s.name`,
    [featureId, inserted.rows.map((match) => match.subscription_id)]
  );
  for (const match of instant.rows) {
    await notifyUser(client, {
      userId: match.user_id,
      type: "geofence_match",
      title: `订阅「${match.name}」附近有新地点`,
      body: `新地点：${row.title ?? "未命名地点"}。`,
      link: `/features/${featureId}`
    });
  }
}

/**
 * 订阅创建或范围变更后的全量重算：把当前范围内所有可见要素写入匹配表。
 * 已存在的 (subscription, feature) 行被 ON CONFLICT 跳过，因此缩小范围再
 * 扩大不会重复通知。即时频率合并为一条汇总通知；摘要频率留待摘要任务。
 * 返回本次新增匹配数。
 */
export async function recomputeSubscription(client: PoolClient, subscriptionId: string): Promise<number> {
  const result = await client.query<SubscriptionRow>(`${SUBSCRIPTION_SELECT} WHERE s.id = $1 FOR UPDATE`, [subscriptionId]);
  const sub = result.rows[0];
  if (!sub || !sub.is_active) return 0;

  const inserted = await client.query<{ feature_id: string }>(
    `INSERT INTO geofence_subscription_matches (subscription_id, feature_id, scope_version)
     SELECT $1, mf.id, $2
     FROM map_features mf
     WHERE mf.status = 'published' AND mf.deleted_at IS NULL
       AND mf.owner_id <> $3
       AND ST_DWithin(mf.geom, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6)
       AND ($7::text[] = '{}' OR mf.category_key = ANY($7::text[]))
     ON CONFLICT (subscription_id, feature_id) DO NOTHING
     RETURNING feature_id`,
    [subscriptionId, sub.scope_version, sub.user_id, sub.longitude, sub.latitude, sub.radius_m, sub.category_keys]
  );
  if (!inserted.rowCount) return 0;

  if (sub.frequency === "instant") {
    const featureIds = inserted.rows.map((match) => match.feature_id);
    const titles = await client.query<{ title: string | null }>(
      `SELECT fr.payload->>'title' AS title
       FROM map_features mf
       LEFT JOIN feature_revisions fr ON fr.id = mf.current_revision_id
       WHERE mf.id = ANY($1::uuid[])`,
      [featureIds]
    );
    const digest = buildGeofenceDigestText(
      sub.name,
      titles.rows.map((item) => item.title ?? "未命名地点"),
      titles.rows.length
    );
    await notifyUser(client, {
      userId: sub.user_id,
      type: "geofence_match",
      title: digest.title,
      body: digest.body,
      link: featureIds.length === 1 ? `/features/${featureIds[0]!}` : "/map"
    });
    await client.query(
      `UPDATE geofence_subscription_matches SET notified_at = now()
       WHERE subscription_id = $1 AND feature_id = ANY($2::uuid[])`,
      [subscriptionId, featureIds]
    );
  }
  return inserted.rowCount;
}

/**
 * 结清订阅下所有待摘要匹配（频率切回即时、或 worker 发送每日/每周摘要时调用）。
 * 发送前重新校验要素可见性：匹配后被隐藏/删除的要素不会出现在通知里，
 * 保持未通知状态，若之后恢复可见则进入下一次摘要。
 */
export async function flushPendingDigest(client: PoolClient, subscriptionId: string): Promise<number> {
  const subResult = await client.query<{ user_id: string; name: string }>(
    "SELECT user_id, name FROM geofence_subscriptions WHERE id = $1",
    [subscriptionId]
  );
  const sub = subResult.rows[0];
  if (!sub) return 0;

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
  if (!pending.rowCount) return 0;

  const digest = buildGeofenceDigestText(
    sub.name,
    pending.rows.map((match) => match.title ?? "未命名地点"),
    pending.rowCount
  );
  await notifyUser(client, {
    userId: sub.user_id,
    type: "geofence_digest",
    title: digest.title,
    body: digest.body,
    link: pending.rowCount === 1 ? `/features/${pending.rows[0]!.feature_id}` : "/map"
  });
  await client.query(
    `UPDATE geofence_subscription_matches SET notified_at = now()
     WHERE subscription_id = $1 AND notified_at IS NULL AND feature_id = ANY($2::uuid[])`,
    [subscriptionId, pending.rows.map((match) => match.feature_id)]
  );
  return pending.rowCount;
}

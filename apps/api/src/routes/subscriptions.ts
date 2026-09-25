import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  GEOFENCE_LIMITS,
  geofenceSubscriptionSchema,
  updateGeofenceSubscriptionSchema
} from "@map/shared/contracts";
import { query, transaction } from "../db";
import { AppError, conflict, notFound } from "../errors";
import { requireAuth, requireVerifiedContributor } from "../auth";
import { recordAudit } from "../audit";
import { enqueueSubscriptionRecompute } from "../queue";

type SubscriptionRow = {
  id: string;
  name: string;
  longitude: number;
  latitude: number;
  radius_m: number;
  category_keys: string[];
  frequency: string;
  is_active: boolean;
  scope_version: number;
  recomputed_version: number;
  last_digest_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const subscriptionSelect = `
  SELECT id, name,
         ST_X(center::geometry) AS longitude,
         ST_Y(center::geometry) AS latitude,
         radius_m, category_keys, frequency, is_active,
         scope_version, recomputed_version, last_digest_at, created_at, updated_at
  FROM geofence_subscriptions`;

function serializeSubscription(row: SubscriptionRow) {
  return {
    id: row.id,
    name: row.name,
    longitude: Number(row.longitude),
    latitude: Number(row.latitude),
    radiusM: row.radius_m,
    categoryKeys: row.category_keys,
    frequency: row.frequency,
    isActive: row.is_active,
    scopeVersion: row.scope_version,
    // 范围变更后 worker 会重算旧订阅；未完成时前端可以提示“同步中”
    recomputePending: row.recomputed_version < row.scope_version,
    lastDigestAt: row.last_digest_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function assertCategoriesActive(categoryKeys: string[]) {
  if (!categoryKeys.length) return;
  const result = await query<{ key: string }>(
    "SELECT key FROM categories WHERE key = ANY($1::text[]) AND is_active = true",
    [categoryKeys]
  );
  if (result.rowCount !== categoryKeys.length) {
    throw new AppError(400, "VALIDATION_FAILED", "One or more categories are unknown or inactive");
  }
}

function sameCategoryKeys(left: string[], right: string[]) {
  return left.length === right.length && [...left].sort().join("") === [...right].sort().join("");
}

export async function subscriptionRoutes(app: FastifyInstance) {
  app.post("/subscriptions", { preHandler: requireVerifiedContributor }, async (request, reply) => {
    const input = geofenceSubscriptionSchema.parse(request.body);
    const userId = request.user!.id;
    await assertCategoriesActive(input.categoryKeys);

    const created = await transaction(async (client) => {
      const count = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM geofence_subscriptions WHERE user_id = $1 AND deleted_at IS NULL",
        [userId]
      );
      if (count.rows[0]!.count >= GEOFENCE_LIMITS.maxActivePerUser) {
        throw conflict(`At most ${GEOFENCE_LIMITS.maxActivePerUser} subscriptions per account`);
      }
      const result = await client.query<SubscriptionRow>(
        `INSERT INTO geofence_subscriptions(user_id, name, center, radius_m, category_keys, frequency)
         VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6::text[], $7)
         RETURNING id, name, ST_X(center::geometry) AS longitude, ST_Y(center::geometry) AS latitude,
                   radius_m, category_keys, frequency, is_active, scope_version, recomputed_version,
                   last_digest_at, created_at, updated_at`,
        [userId, input.name, input.longitude, input.latitude, input.radiusM, input.categoryKeys, input.frequency]
      );
      await recordAudit(client, {
        actorId: userId,
        action: "subscription.created",
        resourceType: "geofence_subscription",
        resourceId: result.rows[0]!.id,
        metadata: { radiusM: input.radiusM, categoryKeys: input.categoryKeys, frequency: input.frequency }
      });
      return result.rows[0]!;
    });

    // 新建订阅需要重算存量已发布内容；队列失败时由 worker 维护节拍兜底
    await enqueueSubscriptionRecompute(created.id);
    return reply.code(201).send(serializeSubscription(created));
  });

  app.get("/subscriptions", { preHandler: requireAuth }, async (request) => {
    const result = await query<SubscriptionRow>(
      `${subscriptionSelect} WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
      [request.user!.id]
    );
    return result.rows.map(serializeSubscription);
  });

  app.patch("/subscriptions/:id", { preHandler: requireVerifiedContributor }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = updateGeofenceSubscriptionSchema.parse(request.body);
    const userId = request.user!.id;
    if (input.categoryKeys) await assertCategoriesActive(input.categoryKeys);

    const updated = await transaction(async (client) => {
      const existing = await client.query<SubscriptionRow & { user_id: string }>(
        `SELECT id, user_id, name,
                ST_X(center::geometry) AS longitude,
                ST_Y(center::geometry) AS latitude,
                radius_m, category_keys, frequency, is_active,
                scope_version, recomputed_version, last_digest_at, created_at, updated_at
         FROM geofence_subscriptions
         WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [params.id]
      );
      const row = existing.rows[0];
      if (!row) throw notFound("Subscription not found");
      if (row.user_id !== userId) throw notFound("Subscription not found");

      const nextLongitude = input.longitude ?? Number(row.longitude);
      const nextLatitude = input.latitude ?? Number(row.latitude);
      const nextRadiusM = input.radiusM ?? row.radius_m;
      const nextCategoryKeys = input.categoryKeys ?? row.category_keys;
      const reactivated = input.isActive === true && !row.is_active;
      // 范围（中心/半径/分类）变化或重新启用时，必须重算旧订阅
      const scopeChanged =
        nextLongitude !== Number(row.longitude) ||
        nextLatitude !== Number(row.latitude) ||
        nextRadiusM !== row.radius_m ||
        !sameCategoryKeys(nextCategoryKeys, row.category_keys) ||
        reactivated;

      const result = await client.query<SubscriptionRow>(
        `UPDATE geofence_subscriptions
         SET name = $2,
             center = ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography,
             radius_m = $5,
             category_keys = $6::text[],
             frequency = $7,
             is_active = $8,
             scope_version = scope_version + $9::int,
             updated_at = now()
         WHERE id = $1
         RETURNING id, name, ST_X(center::geometry) AS longitude, ST_Y(center::geometry) AS latitude,
                   radius_m, category_keys, frequency, is_active, scope_version, recomputed_version,
                   last_digest_at, created_at, updated_at`,
        [
          params.id,
          input.name ?? row.name,
          nextLongitude,
          nextLatitude,
          nextRadiusM,
          nextCategoryKeys,
          input.frequency ?? row.frequency,
          input.isActive ?? row.is_active,
          scopeChanged ? 1 : 0
        ]
      );
      await recordAudit(client, {
        actorId: userId,
        action: "subscription.updated",
        resourceType: "geofence_subscription",
        resourceId: params.id,
        metadata: { scopeChanged, scopeVersion: result.rows[0]!.scope_version }
      });
      return { row: result.rows[0]!, scopeChanged };
    });

    if (updated.scopeChanged) await enqueueSubscriptionRecompute(updated.row.id);
    return serializeSubscription(updated.row);
  });

  app.delete("/subscriptions/:id", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await transaction(async (client) => {
      const result = await client.query(
        `UPDATE geofence_subscriptions SET deleted_at = now(), updated_at = now()
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         RETURNING id`,
        [params.id, request.user!.id]
      );
      if (!result.rowCount) throw notFound("Subscription not found");
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "subscription.deleted",
        resourceType: "geofence_subscription",
        resourceId: params.id
      });
    });
    return { status: "deleted" };
  });

  app.get("/subscriptions/:id/matches", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const owner = await query<{ user_id: string }>(
      "SELECT user_id FROM geofence_subscriptions WHERE id = $1 AND deleted_at IS NULL",
      [params.id]
    );
    if (!owner.rows[0] || owner.rows[0].user_id !== request.user!.id) throw notFound("Subscription not found");

    // 只返回当前公开可见的内容，与地图查询的可见性规则保持一致
    const result = await query(
      `SELECT mf.id, mf.category_key, c.name AS category_name,
              fr.payload->>'title' AS title,
              ST_X(mf.geom::geometry) AS longitude,
              ST_Y(mf.geom::geometry) AS latitude,
              m.matched_at, m.notified_at
       FROM geofence_matches m
       JOIN map_features mf ON mf.id = m.feature_id
       JOIN categories c ON c.key = mf.category_key
       JOIN feature_revisions fr ON fr.id = mf.current_revision_id
       WHERE m.subscription_id = $1
         AND mf.status = 'published' AND mf.deleted_at IS NULL
       ORDER BY m.matched_at DESC
       LIMIT 100`,
      [params.id]
    );
    return result.rows.map((row) => ({
      featureId: row.id,
      categoryKey: row.category_key,
      categoryName: row.category_name,
      title: row.title,
      longitude: Number(row.longitude),
      latitude: Number(row.latitude),
      matchedAt: row.matched_at,
      notifiedAt: row.notified_at
    }));
  });
}

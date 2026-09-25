import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  GEOFENCE_MAX_PER_USER,
  geofenceSubscriptionSchema,
  geofenceSubscriptionUpdateSchema,
  type GeofenceFrequency
} from "@map/shared/contracts";
import { query, transaction } from "../db";
import { conflict, notFound } from "../errors";
import { requireAuth, requireVerifiedContributor } from "../auth";
import { recordAudit } from "../audit";
import { computeNextDigestAt, flushPendingDigest, isScopeChange, recomputeSubscription } from "../geofence";

type SubscriptionRow = {
  id: string;
  name: string;
  radius_m: number;
  category_keys: string[];
  frequency: GeofenceFrequency;
  is_active: boolean;
  scope_version: number;
  longitude: number;
  latitude: number;
  created_at: Date;
  updated_at: Date;
};

const SUBSCRIPTION_SELECT = `
  SELECT id, name, radius_m, category_keys, frequency, is_active, scope_version,
         ST_X(center::geometry) AS longitude, ST_Y(center::geometry) AS latitude,
         created_at, updated_at
  FROM geofence_subscriptions`;

function serialize(row: SubscriptionRow) {
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
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function subscriptionRoutes(app: FastifyInstance) {
  app.post("/me/subscriptions", { preHandler: requireVerifiedContributor }, async (request, reply) => {
    const input = geofenceSubscriptionSchema.parse(request.body);
    const userId = request.user!.id;
    const created = await transaction(async (client) => {
      const count = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM geofence_subscriptions WHERE user_id = $1",
        [userId]
      );
      if (count.rows[0]!.count >= GEOFENCE_MAX_PER_USER) {
        throw conflict("Subscription limit reached");
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO geofence_subscriptions(user_id, name, center, radius_m, category_keys, frequency, is_active, next_digest_at)
         VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6::text[], $7, $8, $9)
         RETURNING id`,
        [
          userId,
          input.name,
          input.longitude,
          input.latitude,
          input.radiusM,
          input.categoryKeys,
          input.frequency,
          input.isActive,
          computeNextDigestAt(input.frequency)
        ]
      );
      const id = inserted.rows[0]!.id;
      // 创建即对存量已发布要素重算，去重由匹配表主键保证
      if (input.isActive) await recomputeSubscription(client, id);
      await recordAudit(client, {
        actorId: userId,
        action: "geofence.created",
        resourceType: "geofence_subscription",
        resourceId: id,
        metadata: { radiusM: input.radiusM, frequency: input.frequency, categoryKeys: input.categoryKeys }
      });
      const row = await client.query<SubscriptionRow>(`${SUBSCRIPTION_SELECT} WHERE id = $1`, [id]);
      return row.rows[0]!;
    });
    return reply.code(201).send(serialize(created));
  });

  app.get("/me/subscriptions", { preHandler: requireAuth }, async (request) => {
    const result = await query<SubscriptionRow>(
      `${SUBSCRIPTION_SELECT} WHERE user_id = $1 ORDER BY created_at DESC`,
      [request.user!.id]
    );
    return result.rows.map(serialize);
  });

  app.patch("/me/subscriptions/:id", { preHandler: requireVerifiedContributor }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = geofenceSubscriptionUpdateSchema.parse(request.body);
    const userId = request.user!.id;

    const updated = await transaction(async (client) => {
      const existing = await client.query<SubscriptionRow>(
        `${SUBSCRIPTION_SELECT} WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [params.id, userId]
      );
      const row = existing.rows[0];
      if (!row) throw notFound("Subscription not found");

      const next = {
        name: input.name ?? row.name,
        longitude: input.longitude ?? Number(row.longitude),
        latitude: input.latitude ?? Number(row.latitude),
        radiusM: input.radiusM ?? row.radius_m,
        categoryKeys: input.categoryKeys ?? row.category_keys,
        frequency: input.frequency ?? row.frequency,
        isActive: input.isActive ?? row.is_active
      };
      const scopeChanged = isScopeChange(
        { longitude: Number(row.longitude), latitude: Number(row.latitude), radiusM: row.radius_m, categoryKeys: row.category_keys },
        { longitude: next.longitude, latitude: next.latitude, radiusM: next.radiusM, categoryKeys: next.categoryKeys }
      );
      const frequencyChanged = next.frequency !== row.frequency;

      await client.query(
        `UPDATE geofence_subscriptions
         SET name = $2,
             center = ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography,
             radius_m = $5,
             category_keys = $6::text[],
             frequency = $7,
             is_active = $8,
             scope_version = scope_version + $9::int,
             next_digest_at = $10,
             updated_at = now()
         WHERE id = $1`,
        [
          params.id,
          next.name,
          next.longitude,
          next.latitude,
          next.radiusM,
          next.categoryKeys,
          next.frequency,
          next.isActive,
          scopeChanged ? 1 : 0,
          computeNextDigestAt(next.frequency)
        ]
      );
      // 频率切回即时：先结清积压的待摘要匹配，避免永远滞留
      if (frequencyChanged && next.frequency === "instant") {
        await flushPendingDigest(client, params.id);
      }
      // 范围变更或重新启用时重算旧订阅；历史匹配保留，重复地点不会重复通知
      if (next.isActive && (scopeChanged || !row.is_active)) {
        await recomputeSubscription(client, params.id);
      }
      await recordAudit(client, {
        actorId: userId,
        action: "geofence.updated",
        resourceType: "geofence_subscription",
        resourceId: params.id,
        metadata: { scopeChanged, frequencyChanged, isActive: next.isActive }
      });
      const fresh = await client.query<SubscriptionRow>(`${SUBSCRIPTION_SELECT} WHERE id = $1`, [params.id]);
      return fresh.rows[0]!;
    });
    return serialize(updated);
  });

  app.delete("/me/subscriptions/:id", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await transaction(async (client) => {
      const result = await client.query(
        "DELETE FROM geofence_subscriptions WHERE id = $1 AND user_id = $2 RETURNING id",
        [params.id, request.user!.id]
      );
      if (!result.rowCount) throw notFound("Subscription not found");
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "geofence.deleted",
        resourceType: "geofence_subscription",
        resourceId: params.id
      });
    });
    return { status: "deleted" };
  });
}

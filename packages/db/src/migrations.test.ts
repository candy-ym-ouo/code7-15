import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../migrations/0001_init.sql"),
  "utf8"
);

describe("initial migration", () => {
  it("contains the core audited entities", () => {
    for (const table of [
      "users", "sessions", "auth_tokens", "categories", "map_features",
      "feature_revisions", "media_assets", "comments", "reports",
      "moderation_actions", "outbox_events", "audit_logs", "notifications"
    ]) {
      expect(migration).toContain(`CREATE TABLE ${table}`);
    }
  });

  it("adds public thumbnail and outbox recovery fields in migration 0002", () => {
    const followup = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../migrations/0002_media_public_thumb.sql"),
      "utf8"
    );
    expect(followup).toContain("public_thumbnail_object_key");
    expect(followup).toContain("updated_at timestamptz");
  });

  it("uses PostGIS geography points and spatial indexes", () => {
    expect(migration).toContain("geography(Point, 4326)");
    expect(migration).toContain("USING gist (geom)");
  });

  it("adds geofence subscription tables in migration 0003", () => {
    const followup = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../migrations/0003_geofence_subscriptions.sql"),
      "utf8"
    );
    for (const table of ["geofence_subscriptions", "geofence_matches", "geofence_scan_events"]) {
      expect(followup).toContain(`CREATE TABLE ${table}`);
    }
    // 去重根基：同一订阅对同一内容只保留一条匹配
    expect(followup).toContain("PRIMARY KEY (subscription_id, feature_id)");
    // 重算游标与频率
    expect(followup).toContain("scope_version");
    expect(followup).toContain("recomputed_version");
    expect(followup).toContain("'instant', 'daily', 'weekly'");
  });
});

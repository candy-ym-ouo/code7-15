import type { PoolClient } from "pg";

/**
 * Records that a feature became publicly visible. The row is written inside the
 * same transaction as the status change so the database stays the source of
 * truth; the geofence worker matches it against subscriptions asynchronously.
 */
export async function recordFeaturePublishedScan(client: PoolClient, featureId: string): Promise<void> {
  await client.query("INSERT INTO geofence_scan_events(feature_id) VALUES ($1)", [featureId]);
}

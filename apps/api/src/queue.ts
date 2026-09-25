import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "./config";

const redisOptions = { maxRetriesPerRequest: null } as const;
export const mediaRedis = new IORedis(config.REDIS_URL, redisOptions);
export const outboxRedis = new IORedis(config.REDIS_URL, redisOptions);
export const geofenceRedis = new IORedis(config.REDIS_URL, redisOptions);
mediaRedis.on("error", (error) => console.error({ error }, "media Redis connection error"));
outboxRedis.on("error", (error) => console.error({ error }, "outbox Redis connection error"));
geofenceRedis.on("error", (error) => console.error({ error }, "geofence Redis connection error"));

export const mediaQueue = new Queue("media", { connection: mediaRedis });
export const outboxQueue = new Queue("outbox", { connection: outboxRedis });
export const geofenceQueue = new Queue("geofence", { connection: geofenceRedis });

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`Redis queue operation timed out after ${timeoutMs}ms`)), timeoutMs).unref();
    })
  ]);
}

export async function enqueueMediaProcessing(mediaId: string, jobId: string): Promise<void> {
  await withTimeout(
    mediaQueue.add("process", { mediaId }, {
      jobId,
      removeOnComplete: 1000,
      removeOnFail: 1000
    }),
    3_000
  );
}

export async function enqueueOutbox(eventId: string): Promise<void> {
  try {
    await withTimeout(
      outboxQueue.add("dispatch", { eventId }, { removeOnComplete: 1000, removeOnFail: 1000 }),
      3_000
    );
  } catch (error) {
    // The database outbox remains the source of truth. A worker maintenance tick retries pending rows.
    console.error({ eventId, error }, "failed to enqueue outbox event");
  }
}

export async function enqueueGeofenceScan(featureId: string): Promise<void> {
  try {
    await withTimeout(
      geofenceQueue.add("scan-feature", { featureId }, {
        jobId: `scan-${featureId}`,
        removeOnComplete: 1000,
        removeOnFail: 1000
      }),
      3_000
    );
  } catch (error) {
    // geofence_scan_events remains the source of truth. A worker maintenance tick retries pending rows.
    console.error({ featureId, error }, "failed to enqueue geofence scan");
  }
}

export async function enqueueSubscriptionRecompute(subscriptionId: string): Promise<void> {
  try {
    await withTimeout(
      geofenceQueue.add("recompute-subscription", { subscriptionId }, {
        jobId: `recompute-${subscriptionId}`,
        removeOnComplete: 1000,
        removeOnFail: 1000
      }),
      3_000
    );
  } catch (error) {
    // recomputed_version < scope_version remains the source of truth. A worker maintenance tick retries it.
    console.error({ subscriptionId, error }, "failed to enqueue subscription recompute");
  }
}

export async function closeQueues(): Promise<void> {
  await Promise.all([mediaQueue.close(), outboxQueue.close(), geofenceQueue.close()]);
  if (mediaRedis.status !== "end") mediaRedis.disconnect();
  if (outboxRedis.status !== "end") outboxRedis.disconnect();
  if (geofenceRedis.status !== "end") geofenceRedis.disconnect();
}

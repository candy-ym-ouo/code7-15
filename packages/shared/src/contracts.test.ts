import { describe, expect, it } from "vitest";
import {
  featurePayloadSchema,
  geofenceSubscriptionSchema,
  privacyRegionSchema,
  updateGeofenceSubscriptionSchema
} from "./contracts";

describe("featurePayloadSchema", () => {
  it("accepts a valid bench", () => {
    const result = featurePayloadSchema.safeParse({
      categoryKey: "bench",
      title: "公园南侧长椅",
      description: "靠近入口，有两张长椅和靠背。",
      longitude: 116.39,
      latitude: 39.9,
      locationAccuracyM: 5,
      observedAt: new Date().toISOString(),
      condition: "good",
      tags: ["休息"],
      details: { seatCount: 2, hasBackrest: true },
      mediaIds: []
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown detail fields for the selected category", () => {
    const result = featurePayloadSchema.safeParse({
      categoryKey: "bench",
      title: "公园长椅",
      description: "这是一条足够长的说明文字。",
      longitude: 116.39,
      latitude: 39.9,
      locationAccuracyM: 5,
      observedAt: new Date().toISOString(),
      condition: "good",
      tags: [],
      details: { potable: "yes", seatCount: "many" },
      mediaIds: []
    });
    expect(result.success).toBe(false);
  });
});

describe("privacyRegionSchema", () => {
  it("rejects regions outside the image", () => {
    expect(privacyRegionSchema.safeParse({ x: 0.9, y: 0.2, width: 0.2, height: 0.2 }).success).toBe(false);
  });
});

describe("feature media ids", () => {
  it("rejects duplicate media attachments", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const result = featurePayloadSchema.safeParse({
      categoryKey: "bench",
      title: "公园长椅",
      description: "这是一条足够长的说明文字。",
      longitude: 116.39,
      latitude: 39.9,
      locationAccuracyM: 5,
      observedAt: new Date().toISOString(),
      condition: "good",
      tags: [],
      details: { seatCount: 1 },
      mediaIds: [id, id]
    });
    expect(result.success).toBe(false);
  });
});

describe("geofenceSubscriptionSchema", () => {
  const valid = {
    name: "家附近",
    longitude: 116.39,
    latitude: 39.9,
    radiusM: 2000,
    categoryKeys: ["bench", "drinking_water"],
    frequency: "daily"
  };

  it("accepts a valid subscription and defaults", () => {
    const result = geofenceSubscriptionSchema.safeParse({ name: "公司周边", longitude: 121.47, latitude: 31.23, radiusM: 500 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.categoryKeys).toEqual([]);
      expect(result.data.frequency).toBe("daily");
    }
  });

  it("rejects radius outside the allowed range", () => {
    expect(geofenceSubscriptionSchema.safeParse({ ...valid, radiusM: 50 }).success).toBe(false);
    expect(geofenceSubscriptionSchema.safeParse({ ...valid, radiusM: 100_000 }).success).toBe(false);
  });

  it("rejects duplicate or unknown category keys", () => {
    expect(geofenceSubscriptionSchema.safeParse({ ...valid, categoryKeys: ["bench", "bench"] }).success).toBe(false);
    expect(geofenceSubscriptionSchema.safeParse({ ...valid, categoryKeys: ["bench", "spaceship"] }).success).toBe(false);
  });

  it("rejects unknown frequency", () => {
    expect(geofenceSubscriptionSchema.safeParse({ ...valid, frequency: "hourly" }).success).toBe(false);
  });
});

describe("updateGeofenceSubscriptionSchema", () => {
  it("requires longitude and latitude to be updated together", () => {
    expect(updateGeofenceSubscriptionSchema.safeParse({ longitude: 116.4 }).success).toBe(false);
    expect(updateGeofenceSubscriptionSchema.safeParse({ longitude: 116.4, latitude: 39.9 }).success).toBe(true);
  });

  it("allows partial non-scope updates", () => {
    const result = updateGeofenceSubscriptionSchema.safeParse({ frequency: "weekly", isActive: false });
    expect(result.success).toBe(true);
  });
});

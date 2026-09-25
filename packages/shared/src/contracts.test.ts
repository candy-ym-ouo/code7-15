import { describe, expect, it } from "vitest";
import { featurePayloadSchema, geofenceSubscriptionSchema, geofenceSubscriptionUpdateSchema, privacyRegionSchema } from "./contracts";

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
    name: "公司附近",
    longitude: 116.397,
    latitude: 39.908,
    radiusM: 1000,
    categoryKeys: ["bench", "drinking_water"],
    frequency: "daily",
    isActive: true
  };

  it("accepts a valid subscription and applies defaults", () => {
    const result = geofenceSubscriptionSchema.safeParse(valid);
    expect(result.success).toBe(true);
    const withDefaults = geofenceSubscriptionSchema.safeParse({
      name: "家门口",
      longitude: 116.3,
      latitude: 39.9,
      radiusM: 500
    });
    expect(withDefaults.success).toBe(true);
    if (withDefaults.success) {
      expect(withDefaults.data.categoryKeys).toEqual([]);
      expect(withDefaults.data.frequency).toBe("instant");
      expect(withDefaults.data.isActive).toBe(true);
    }
  });

  it("rejects out-of-range radius and unknown categories", () => {
    expect(geofenceSubscriptionSchema.safeParse({ ...valid, radiusM: 50 }).success).toBe(false);
    expect(geofenceSubscriptionSchema.safeParse({ ...valid, radiusM: 50_000 }).success).toBe(false);
    expect(geofenceSubscriptionSchema.safeParse({ ...valid, categoryKeys: ["parking"] }).success).toBe(false);
    expect(geofenceSubscriptionSchema.safeParse({ ...valid, frequency: "hourly" }).success).toBe(false);
  });

  it("rejects duplicate category keys", () => {
    expect(geofenceSubscriptionSchema.safeParse({ ...valid, categoryKeys: ["bench", "bench"] }).success).toBe(false);
  });

  it("update schema allows partial payloads but still validates values", () => {
    expect(geofenceSubscriptionUpdateSchema.safeParse({ name: "新名字" }).success).toBe(true);
    expect(geofenceSubscriptionUpdateSchema.safeParse({ radiusM: 10 }).success).toBe(false);
    expect(geofenceSubscriptionUpdateSchema.safeParse({ categoryKeys: ["bench", "bench"] }).success).toBe(false);
  });
});

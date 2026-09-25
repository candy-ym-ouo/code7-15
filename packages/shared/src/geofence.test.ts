import { describe, expect, it } from "vitest";
import { buildGeofenceDigestText, computeNextDigestAt, digestIntervalText, isScopeChange } from "./geofence";

const baseScope = {
  longitude: 116.397,
  latitude: 39.908,
  radiusM: 1000,
  categoryKeys: ["bench", "drinking_water"]
};

describe("isScopeChange", () => {
  it("returns false when nothing changed", () => {
    expect(isScopeChange(baseScope, { ...baseScope })).toBe(false);
  });

  it("detects center and radius changes", () => {
    expect(isScopeChange(baseScope, { ...baseScope, longitude: 116.4 })).toBe(true);
    expect(isScopeChange(baseScope, { ...baseScope, latitude: 39.9 })).toBe(true);
    expect(isScopeChange(baseScope, { ...baseScope, radiusM: 2000 })).toBe(true);
  });

  it("detects category set changes regardless of order", () => {
    expect(isScopeChange(baseScope, { ...baseScope, categoryKeys: ["drinking_water", "bench"] })).toBe(false);
    expect(isScopeChange(baseScope, { ...baseScope, categoryKeys: ["bench"] })).toBe(true);
    expect(isScopeChange(baseScope, { ...baseScope, categoryKeys: ["bench", "quiet_corner"] })).toBe(true);
    expect(isScopeChange(baseScope, { ...baseScope, categoryKeys: [] })).toBe(true);
  });
});

describe("computeNextDigestAt", () => {
  const from = new Date("2026-09-25T08:00:00.000Z");

  it("returns null for instant frequency", () => {
    expect(computeNextDigestAt("instant", from)).toBeNull();
  });

  it("schedules daily digests one day out and weekly seven days out", () => {
    expect(computeNextDigestAt("daily", from)?.toISOString()).toBe("2026-09-26T08:00:00.000Z");
    expect(computeNextDigestAt("weekly", from)?.toISOString()).toBe("2026-10-02T08:00:00.000Z");
  });
});

describe("digestIntervalText", () => {
  it("maps frequencies to PostgreSQL intervals", () => {
    expect(digestIntervalText("daily")).toBe("1 day");
    expect(digestIntervalText("weekly")).toBe("7 days");
  });
});

describe("buildGeofenceDigestText", () => {
  it("lists up to five titles and folds the rest into a count", () => {
    const few = buildGeofenceDigestText("公司附近", ["长椅A", "饮水处B"], 2);
    expect(few.title).toBe("订阅「公司附近」新增 2 个地点");
    expect(few.body).toContain("长椅A、饮水处B");
    expect(few.body).not.toContain("等");

    const many = buildGeofenceDigestText("公司附近", ["一", "二", "三", "四", "五", "六", "七"], 7);
    expect(many.body).toContain("一、二、三、四、五 等 7 个");
  });
});

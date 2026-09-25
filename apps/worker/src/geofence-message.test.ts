import { describe, expect, it } from "vitest";
import { buildDigestMessage, buildInstantMessage } from "./geofence-message";

describe("buildInstantMessage", () => {
  it("names the subscription, category and feature", () => {
    const message = buildInstantMessage({
      subscriptionName: "家附近",
      featureTitle: "公园南侧长椅",
      categoryName: "长椅"
    });
    expect(message.title).toContain("家附近");
    expect(message.title).toContain("长椅");
    expect(message.body).toContain("公园南侧长椅");
  });
});

describe("buildDigestMessage", () => {
  const items = Array.from({ length: 7 }, (_, index) => ({
    title: `地点 ${index + 1}`,
    categoryName: "长椅"
  }));

  it("lists up to five items and summarizes the rest", () => {
    const message = buildDigestMessage({ subscriptionName: "公司周边", items, totalCount: 7 });
    expect(message.title).toBe("你订阅的「公司周边」有 7 条新动态");
    expect(message.body).toContain("地点 5");
    expect(message.body).not.toContain("地点 6");
    expect(message.body).toContain("另外 2 条");
  });

  it("omits the remainder suffix when everything fits", () => {
    const message = buildDigestMessage({ subscriptionName: "公司周边", items: items.slice(0, 2), totalCount: 2 });
    expect(message.body).not.toContain("另外");
    expect(message.title).toContain("2 条新动态");
  });
});

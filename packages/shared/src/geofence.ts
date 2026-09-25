import type { GeofenceFrequency } from "./contracts";

export type GeofenceScope = {
  longitude: number;
  latitude: number;
  radiusM: number;
  categoryKeys: string[];
};

/**
 * 判断两次订阅配置之间的“范围”是否发生变化（圆心、半径或分类集合）。
 * 只有范围变化才需要重算旧订阅；名称、频率等元数据变化不触发。
 */
export function isScopeChange(previous: GeofenceScope, next: GeofenceScope): boolean {
  if (previous.longitude !== next.longitude) return true;
  if (previous.latitude !== next.latitude) return true;
  if (previous.radiusM !== next.radiusM) return true;
  if (previous.categoryKeys.length !== next.categoryKeys.length) return true;
  const keys = new Set(previous.categoryKeys);
  return next.categoryKeys.some((key) => !keys.has(key));
}

/** 每日/每周摘要的下次发送时间；即时频率没有摘要时刻。 */
export function computeNextDigestAt(frequency: GeofenceFrequency, from: Date = new Date()): Date | null {
  if (frequency === "instant") return null;
  const next = new Date(from.getTime());
  next.setUTCDate(next.getUTCDate() + (frequency === "daily" ? 1 : 7));
  return next;
}

/** 摘要周期对应的 PostgreSQL interval 文本，供 worker 推进日程使用。 */
export function digestIntervalText(frequency: "daily" | "weekly"): string {
  return frequency === "daily" ? "1 day" : "7 days";
}

/** 汇总通知文案：最多列出 5 个标题，其余折叠为数量。 */
export function buildGeofenceDigestText(
  subscriptionName: string,
  titles: string[],
  total: number
): { title: string; body: string } {
  const listed = titles.slice(0, 5).join("、");
  const extra = total > 5 ? ` 等 ${total} 个` : "";
  return {
    title: `订阅「${subscriptionName}」新增 ${total} 个地点`,
    body: `新地点：${listed}${extra}。`
  };
}

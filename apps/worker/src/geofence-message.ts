const DIGEST_LIST_LIMIT = 5;

export type DigestItem = { title: string; categoryName: string };

// 纯函数，便于单测：即时提醒与周期摘要的文案
export function buildInstantMessage(input: { subscriptionName: string; featureTitle: string; categoryName: string }) {
  return {
    title: `「${input.subscriptionName}」附近有新的${input.categoryName}`,
    body: `《${input.featureTitle}》已发布在你订阅的区域内。`
  };
}

export function buildDigestMessage(input: { subscriptionName: string; items: DigestItem[]; totalCount: number }) {
  const lines = input.items.slice(0, DIGEST_LIST_LIMIT).map((item) => `· ${item.title}（${item.categoryName}）`);
  const remaining = input.totalCount - Math.min(input.items.length, DIGEST_LIST_LIMIT);
  const suffix = remaining > 0 ? `\n…以及另外 ${remaining} 条新动态。` : "";
  return {
    title: `你订阅的「${input.subscriptionName}」有 ${input.totalCount} 条新动态`,
    body: `${lines.join("\n")}${suffix}`
  };
}

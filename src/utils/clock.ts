export function nowShanghaiTime(): string {
  return formatShanghaiTime(new Date());
}

export function formatShanghaiTime(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error("无效的时间值。");
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace("T", " ").replace("Z", "");
}

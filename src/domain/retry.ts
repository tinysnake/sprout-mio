/**
 * 系统提醒投递的渐进重试间隔；租约超时与运行注意力提醒共用这一条时间表。
 * 超出数组长度即表示重试预算耗尽，调用方转入人工关注。
 */
export const RETRY_DELAY_SECONDS = [5, 10, 30, 60, 120] as const;

export function retryDelay(attempt: number): number | null {
  const seconds = RETRY_DELAY_SECONDS[attempt - 1];
  return seconds === undefined ? null : seconds * 1000;
}

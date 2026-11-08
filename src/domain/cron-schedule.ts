import { CronExpressionParser } from "cron-parser";

export type CronSchedule = Readonly<{ expression: string; timezone: string }>;

/** Product syntax is deliberately narrower than cron-parser's extensions. */
export function nextCronOccurrence(schedule: CronSchedule, strictlyAfter: Date): Date {
  const fields = schedule.expression.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => !/^[\d*,/\-]+$/.test(field)))
    throw new Error("Cron 仅支持五个数字字段（*、逗号、范围和步长）");
  if (!schedule.timezone || /^[+\-]/.test(schedule.timezone))
    throw new Error("Cron 需要显式 IANA timezone");
  new Intl.DateTimeFormat("en", { timeZone: schedule.timezone }).format(strictlyAfter);
  const endDate = new Date(strictlyAfter);
  endDate.setUTCFullYear(endDate.getUTCFullYear() + 12);
  return CronExpressionParser.parse(fields.join(" "), {
    tz: schedule.timezone,
    currentDate: strictlyAfter,
    endDate,
  })
    .next()
    .toDate();
}

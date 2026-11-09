export const MIN_UTC_OFFSET = -12 * 60;
export const MAX_UTC_OFFSET = 14 * 60;

export function formatUtcOffset(minutes: number): string {
  const absolute = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

export function parseUtcOffset(timezone: string): number | null {
  const match = /^([+-])(\d{2}):([0-5]\d)$/.exec(timezone);
  if (!match) return null;
  const minutes = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === "-" ? -1 : 1);
  return minutes >= MIN_UTC_OFFSET && minutes <= MAX_UTC_OFFSET ? minutes : null;
}

import { timingSafeEqual } from "node:crypto";

export function formatTimestamp(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}`;
}

/**
 * Get today's date as YYYY-MM-DD in the given timezone.
 * Due dates are date-only strings, so comparing them as strings
 * in the user's timezone avoids off-by-one errors at midnight.
 */
export function todayInTimezone(tz: string, now?: Date): string {
  const d = now ?? new Date();
  return d.toLocaleDateString("en-CA", { timeZone: tz }); // en-CA gives YYYY-MM-DD
}

/**
 * Add days to a YYYY-MM-DD date string and return a new YYYY-MM-DD string.
 * Operates in the given timezone to handle DST transitions correctly.
 */
export function addDaysToDate(dateStr: string, days: number, tz: string): string {
  // Parse as noon UTC to avoid DST edge cases when adding days
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: tz });
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return timingSafeEqual(bufA, bufB);
}

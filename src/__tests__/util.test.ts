import { test, expect, describe } from "bun:test";
import { todayInTimezone, addDaysToDate } from "../util.ts";

describe("todayInTimezone", () => {
  test("returns YYYY-MM-DD format", () => {
    const result = todayInTimezone("UTC");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("UTC at midnight gives expected date", () => {
    const result = todayInTimezone("UTC", new Date("2026-03-15T00:00:00Z"));
    expect(result).toBe("2026-03-15");
  });

  test("late UTC is still previous day in US Pacific", () => {
    // 2026-03-15T03:00:00Z = 2026-03-14T20:00:00 in America/Los_Angeles (PDT)
    const result = todayInTimezone("America/Los_Angeles", new Date("2026-03-15T03:00:00Z"));
    expect(result).toBe("2026-03-14");
  });

  test("early UTC is already next day in Asia/Tokyo", () => {
    // 2026-03-15T16:00:00Z = 2026-03-16T01:00:00 in Asia/Tokyo
    const result = todayInTimezone("Asia/Tokyo", new Date("2026-03-15T16:00:00Z"));
    expect(result).toBe("2026-03-16");
  });

  test("handles Europe/Berlin correctly", () => {
    // 2026-03-15T23:30:00Z = 2026-03-16T00:30:00 in Europe/Berlin (CET+1)
    const result = todayInTimezone("Europe/Berlin", new Date("2026-03-15T23:30:00Z"));
    expect(result).toBe("2026-03-16");
  });
});

describe("addDaysToDate", () => {
  test("adds positive days", () => {
    expect(addDaysToDate("2026-03-15", 3, "UTC")).toBe("2026-03-18");
  });

  test("subtracts with negative days", () => {
    expect(addDaysToDate("2026-03-15", -5, "UTC")).toBe("2026-03-10");
  });

  test("crosses month boundary", () => {
    expect(addDaysToDate("2026-03-30", 5, "UTC")).toBe("2026-04-04");
  });

  test("crosses year boundary", () => {
    expect(addDaysToDate("2026-12-30", 5, "UTC")).toBe("2027-01-04");
  });

  test("works with non-UTC timezone", () => {
    expect(addDaysToDate("2026-03-15", 1, "America/New_York")).toBe("2026-03-16");
  });
});

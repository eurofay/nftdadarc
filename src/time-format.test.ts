import { describe, it, expect } from "vitest";
import { istTimeToDate, toIST } from "./time-format";

describe("toIST", () => {
  it("shifts a UTC midnight to 5:30 AM IST the same day", () => {
    expect(toIST(new Date("2024-01-01T00:00:00Z"))).toBe("1/1/2024, 5:30:00 AM");
  });

  it("rolls over to the next IST day when UTC time is late enough", () => {
    // 19:00 UTC + 5:30 = 00:30 the next day
    expect(toIST(new Date("2024-01-01T19:00:00Z"))).toBe("2/1/2024, 12:30:00 AM");
  });

  it("formats a PM time with 12-hour clock correctly", () => {
    expect(toIST(new Date("2024-06-15T08:45:00Z"))).toBe("15/6/2024, 2:15:00 PM");
  });

  it("renders noon as 12 PM, not 0 PM", () => {
    expect(toIST(new Date("2024-06-15T06:30:00Z"))).toBe("15/6/2024, 12:00:00 PM");
  });
});

describe("istTimeToDate", () => {
  it("round-trips through toIST for a time later today", () => {
    const d = istTimeToDate("21:05");
    expect(toIST(d)).toMatch(/, 9:05:00 PM$/);
  });

  it("round-trips a midnight time", () => {
    const d = istTimeToDate("00:00");
    expect(toIST(d)).toMatch(/, 12:00:00 AM$/);
  });

  it("throws on a malformed time string", () => {
    expect(() => istTimeToDate("not-a-time")).toThrow();
    expect(() => istTimeToDate("9pm")).toThrow();
  });

  it("throws on an out-of-range hour or minute", () => {
    expect(() => istTimeToDate("24:00")).toThrow();
    expect(() => istTimeToDate("12:60")).toThrow();
  });

  it("accepts a single-digit hour", () => {
    const d = istTimeToDate("9:30");
    expect(toIST(d)).toMatch(/, 9:30:00 AM$/);
  });
});

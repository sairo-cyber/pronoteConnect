import { TIME_ZONE } from "../config.js";

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/u;

function offsetMilliseconds(date: Date): number {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    timeZoneName: "longOffset",
  }).formatToParts(date).find((value) => value.type === "timeZoneName")?.value;
  const match = part?.match(/^GMT([+-])(\d{2}):(\d{2})$/u);
  if (!match) return 0;
  const sign = match[1] === "+" ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
}

export function parisDateToUtc(value: string, endOfDay = false): Date {
  if (!dateOnlyPattern.test(value)) throw new Error("INVALID_DATE");
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const hour = endOfDay ? 23 : 0;
  const minute = endOfDay ? 59 : 0;
  const second = endOfDay ? 59 : 0;
  const millisecond = endOfDay ? 999 : 0;
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  let candidate = new Date(wallClockAsUtc);
  candidate = new Date(wallClockAsUtc - offsetMilliseconds(candidate));
  candidate = new Date(wallClockAsUtc - offsetMilliseconds(candidate));
  return candidate;
}

export function toParisIso(input: Date | string): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) throw new Error("INVALID_DATE");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const zone = get("timeZoneName").replace("GMT", "") || "+00:00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${zone}`;
}

export function dateRangeFromInput(from: string, to: string): { from: Date; to: Date } {
  const range = { from: parisDateToUtc(from), to: parisDateToUtc(to, true) };
  if (range.to.getTime() < range.from.getTime()) throw new Error("INVALID_DATE_RANGE");
  const days = (range.to.getTime() - range.from.getTime()) / 86_400_000;
  if (days > 62) throw new Error("DATE_RANGE_TOO_LARGE");
  return range;
}

export function todayInParis(): string {
  return toParisIso(new Date()).slice(0, 10);
}

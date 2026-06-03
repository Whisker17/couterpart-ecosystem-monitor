function getLocalDateParts(
  timezone: string,
  date: Date,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);

  const get = (type: string): number =>
    parseInt(parts.find((p) => p.type === type)!.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

// Returns UTC milliseconds for 00:00:00 of (year, month, day) in the given timezone.
// Uses the probe-and-offset technique: probes at the "naive UTC" equivalent, then
// subtracts the observed UTC offset at that probe time.
function localMidnightToUTC(timezone: string, year: number, month: number, day: number): number {
  const probe = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  }).formatToParts(probe);

  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part ? parseInt(part.value) : 0;
  };

  // Represent observed local time as if it were UTC to compute the offset
  const localMs = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24, // some impls return 24 for midnight
    get("minute"),
    get("second"),
  );
  const offset = localMs - probe.getTime();
  return probe.getTime() - offset;
}

export function getYesterdayPeriod(
  timezone: string,
  now: Date = new Date(),
): { startUnix: number; endUnix: number } {
  const { year, month, day } = getLocalDateParts(timezone, now);

  // Date.UTC correctly handles day=0 (→ last day of prev month) and similar boundary cases
  const yesterday = new Date(Date.UTC(year, month - 1, day - 1));
  const yYear = yesterday.getUTCFullYear();
  const yMonth = yesterday.getUTCMonth() + 1;
  const yDay = yesterday.getUTCDate();

  const startMs = localMidnightToUTC(timezone, yYear, yMonth, yDay);
  const endMs = startMs + 24 * 3600 * 1000 - 1000; // + 23:59:59

  return {
    startUnix: Math.floor(startMs / 1000),
    endUnix: Math.floor(endMs / 1000),
  };
}

export function getWeekPeriod(
  timezone: string,
  now: Date = new Date(),
): { startUnix: number; endUnix: number } {
  const { year, month, day } = getLocalDateParts(timezone, now);

  const yesterday = new Date(Date.UTC(year, month - 1, day - 1));
  const yYear = yesterday.getUTCFullYear();
  const yMonth = yesterday.getUTCMonth() + 1;
  const yDay = yesterday.getUTCDate();

  // Week start = 6 days before yesterday → 7 days total (weekStart…yesterday inclusive)
  const weekStart = new Date(Date.UTC(yYear, yMonth - 1, yDay - 6));
  const wsYear = weekStart.getUTCFullYear();
  const wsMonth = weekStart.getUTCMonth() + 1;
  const wsDay = weekStart.getUTCDate();

  const startMs = localMidnightToUTC(timezone, wsYear, wsMonth, wsDay);
  const endMs = localMidnightToUTC(timezone, yYear, yMonth, yDay) + 24 * 3600 * 1000 - 1000;

  return {
    startUnix: Math.floor(startMs / 1000),
    endUnix: Math.floor(endMs / 1000),
  };
}

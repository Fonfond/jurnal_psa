/** Pure schedule helpers (REP-05), kept free of Nest imports. */

/** Next UTC occurrence of HH:MM strictly after `now`. */
export function nextScheduledRun(
  now: Date,
  hourUtc: number,
  minuteUtc: number,
): Date {
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hourUtc,
      minuteUtc,
      0,
      0,
    ),
  );
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

export function parseScheduleUtc(value: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    throw new Error(`Некорректное расписание RETENTION_SCHEDULE_UTC: ${value}`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

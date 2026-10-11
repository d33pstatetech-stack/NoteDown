/** All persisted timestamps are UTC ISO-8601 with milliseconds. */
export function nowIso(date: Date = new Date()): string {
  return date.toISOString();
}

/** Compact, filename-safe local timestamp used for conflict copy titles. */
export function stampForTitle(date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}`
  );
}

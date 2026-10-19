export function todayStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Legacy date-only values keep their day; event timestamps use the local day. */
export function itemDateDay(value: string | number | null): string | null {
  return typeof value === "number" ? todayStr(new Date(value)) : value;
}

/** Interpret legacy days as local midnight, never as UTC midnight. */
export function itemDateTime(value: string | number): number {
  if (typeof value === "number") return value;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day).getTime();
}

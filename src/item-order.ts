import type { Task } from "./types";
import { itemDateTime } from "./utils";

export type ItemSortField = "date_created" | "date_modified" | "date_completed" | "name";
export type ItemSortDirection = "asc" | "desc";

/** Shared default ordering for views and non-visual item projections. */
export function sortItems(tasks: Task[], field: ItemSortField, direction: ItemSortDirection): Task[] {
  return [...tasks].sort((a, b) => {
    if (field !== "name") {
      const left = a[field] === null ? Number.NEGATIVE_INFINITY : itemDateTime(a[field]!);
      const right = b[field] === null ? Number.NEGATIVE_INFINITY : itemDateTime(b[field]!);
      if (left < right) return direction === "asc" ? -1 : 1;
      if (left > right) return direction === "asc" ? 1 : -1;
      return 0;
    }
    const left = a.text;
    const right = b.text;
    if (left < right) return direction === "asc" ? -1 : 1;
    if (left > right) return direction === "asc" ? 1 : -1;
    return 0;
  });
}

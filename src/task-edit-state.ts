import type { Task } from "./types";

export type TaskEditCloseIntent = "implicit" | "saving" | "saved" | "discard";

export function taskHasChanges(initial: Task, current: Task): boolean {
  return JSON.stringify(initial) !== JSON.stringify(current);
}

export function shouldAutoSaveTask(
  initial: Task,
  current: Task,
  intent: TaskEditCloseIntent,
): boolean {
  return intent === "implicit" && taskHasChanges(initial, current);
}

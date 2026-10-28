import type { App } from "obsidian";
import type { ProposedMutation, TaskRegistry } from "./types";
import { loadRegistry, saveRegistry } from "./task-registry";
import { setProjectNextAction } from "./project-state";
import { todayStr } from "./utils";
import { selectFocusTasks } from "./selectors";

export function validateMutation(mutation: ProposedMutation, tasks: TaskRegistry): string | null {
  if (mutation.type === "set-project-next-action") return mutation.project.trim() ? null : "Project name is required";
  const task = tasks.find(item => item._id === mutation.task_id && !item.is_deleted);
  if (!task) return `Unknown task: ${mutation.task_id}`;
  if (mutation.type === "set-focus" && (mutation.order < 1 || mutation.order > 3)) return "Focus order must be 1–3";
  if (mutation.type === "set-task-metadata" && mutation.effort_minutes !== undefined && mutation.effort_minutes !== null && mutation.effort_minutes < 0) return "Effort cannot be negative";
  return null;
}

export async function applyMutations(app: App, mutations: ProposedMutation[]): Promise<void> {
  const tasks = await loadRegistry(app);
  for (const mutation of mutations) {
    const error = validateMutation(mutation, tasks);
    if (error) throw new Error(error);
    if (mutation.type === "set-project-next-action") {
      await setProjectNextAction(app, mutation.project, mutation.next_action);
      continue;
    }
    const task = tasks.find(item => item._id === mutation.task_id)!;
    if (mutation.type === "set-focus") {
      for (const item of tasks) if (item.focus_order === mutation.order) item.focus_order = null;
      task.planned_date = todayStr(); task.is_today = true; task.execution_state = "ready"; task.focus_order = mutation.order;
    } else if (mutation.type === "move-to-today") {
      task.planned_date = todayStr(); task.is_today = true;
    } else if (mutation.type === "move-to-backlog") {
      task.planned_date = null; task.is_today = false; task.focus_order = null;
    } else if (mutation.type === "set-execution-state") {
      task.execution_state = mutation.state; if (mutation.state !== "ready") task.focus_order = null;
    } else if (mutation.type === "set-task-metadata") {
      if (mutation.effort_minutes !== undefined) task.effort_minutes = mutation.effort_minutes;
      if (mutation.context !== undefined) task.context = mutation.context;
    }
    task.date_modified = todayStr();
  }
  await saveRegistry(app, tasks);
}

export async function moveFocusTask(app: App, taskId: string, direction: -1 | 1): Promise<void> {
  const tasks = await loadRegistry(app);
  const focus = selectFocusTasks(tasks);
  const index = focus.findIndex(task => task._id === taskId);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= focus.length) return;
  const current = focus[index];
  const target = focus[targetIndex];
  const currentOrder = current.focus_order;
  current.focus_order = target.focus_order;
  target.focus_order = currentOrder;
  current.date_modified = todayStr();
  target.date_modified = todayStr();
  await saveRegistry(app, tasks);
}

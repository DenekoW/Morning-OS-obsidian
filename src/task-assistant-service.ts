import type { App } from "obsidian";
import type { MorningOSSettings } from "./settings";
import type { ActivityState, ProjectState, Task, TaskRegistry } from "./types";
import { parseJsonObject } from "./agent/json";
import { applyMutations } from "./mutation-service";
import { createTask, generateId, loadRegistry, saveRegistry, setTaskStatus, updateTask } from "./task-registry";
import { todayStr } from "./utils";

const ACTIVITY_PATH = "_generated/ai-task-activity.json";
const WRITE_ACTIONS = new Set(["create_task", "update_task", "complete_task", "set_deadline", "set_status", "set_project", "move_to_today", "move_to_backlog", "add_to_focus", "remove_from_focus"]);
const CONFIRM_ACTIONS = new Set(["create_task", "update_task", "set_deadline", "set_project"]);

export type TaskAssistantActionType = "search_tasks" | "create_task" | "update_task" | "complete_task" | "set_deadline" | "set_status" | "set_project" | "move_to_today" | "move_to_backlog" | "add_to_focus" | "remove_from_focus";
export interface TaskAssistantAction {
  type: TaskAssistantActionType;
  task_id?: string;
  query?: string;
  title?: string;
  project?: string;
  deadline?: string | null;
  planned_date?: string | null;
  effort_minutes?: number | null;
  priority?: Task["eisenhower_priority"];
  status?: Task["execution_state"];
  notes?: string;
}
export interface TaskAssistantPlan {
  message: string;
  actions: TaskAssistantAction[];
  ambiguity?: { actionIndex: number; candidates: Pick<Task, "_id" | "text" | "project">[] };
  requiresConfirmation: boolean;
}
export interface TaskAssistantActivity {
  id: string;
  timestamp: string;
  summary: string;
  changes: { taskId: string; before: Task | null; after: Task | null }[];
  undoneAt?: string;
}

const SYSTEM = `You are a task command parser. Return one JSON object only: {"message":"short response","actions":[...]}. Do not directly edit data.
Allowed action types: search_tasks, create_task, update_task, complete_task, set_deadline, set_status, set_project, move_to_today, move_to_backlog, add_to_focus, remove_from_focus.
For existing tasks use task_id only when the supplied context clearly identifies exactly one task; otherwise use query with the user's own words. Never invent IDs.
create_task fields: title, optional project, deadline (YYYY-MM-DD), planned_date (YYYY-MM-DD), effort_minutes, priority.
update_task fields: task_id/query plus only explicitly requested title, notes, effort_minutes, priority.
set_deadline uses deadline YYYY-MM-DD or null. set_status uses ready, waiting, or blocked. Never invent dates, projects, estimates, priorities, or notes. Use the provided current date to resolve explicit relative dates such as tomorrow or Wednesday. search_tasks is read-only.`;

function normalize(value: string): string { return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }

export function resolveTaskQuery(tasks: TaskRegistry, query: string): Task[] {
  const available = tasks.filter(task => !task.is_deleted);
  const needle = normalize(query);
  if (!needle) return [];
  const exact = available.filter(task => normalize(task.text) === needle);
  if (exact.length) return exact;
  const needleTokens = new Set(needle.split(" ").filter(Boolean));
  return available.map(task => {
    const text = normalize(task.text); const tokens = new Set(text.split(" ").filter(Boolean));
    const overlap = [...needleTokens].filter(token => tokens.has(token)).length;
    const score = text.includes(needle) || needle.includes(text) ? 1 : overlap / Math.max(needleTokens.size, 1);
    return { task, score };
  }).filter(item => item.score >= 0.5).sort((left, right) => right.score - left.score || left.task.text.localeCompare(right.task.text)).map(item => item.task);
}

function validateAction(action: TaskAssistantAction): void {
  if (!WRITE_ACTIONS.has(action.type) && action.type !== "search_tasks") throw new Error(`Unsupported task action: ${action.type}`);
  if (action.type === "create_task" && !action.title?.trim()) throw new Error("Create task requires a title");
  if (action.type === "search_tasks" && !action.query?.trim()) throw new Error("Search requires a task query");
  if (action.type === "set_status" && !action.status) throw new Error("Set status requires ready, waiting, or blocked");
  if (action.deadline !== undefined && action.deadline !== null && !/^\d{4}-\d{2}-\d{2}$/.test(action.deadline)) throw new Error("Deadline must be YYYY-MM-DD");
  if (action.planned_date !== undefined && action.planned_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(action.planned_date)) throw new Error("Planned date must be YYYY-MM-DD");
  if (action.effort_minutes !== undefined && action.effort_minutes !== null && (!Number.isFinite(action.effort_minutes) || action.effort_minutes < 0)) throw new Error("Estimate must be zero or greater");
  if (action.status !== undefined && !["ready", "waiting", "blocked"].includes(action.status)) throw new Error("Invalid task status");
}

export function prepareTaskAssistantPlan(raw: unknown, tasks: TaskRegistry): TaskAssistantPlan {
  if (!raw || typeof raw !== "object") throw new Error("AI returned an invalid task plan");
  const value = raw as { message?: unknown; actions?: unknown };
  if (!Array.isArray(value.actions) || value.actions.length > 10) throw new Error("AI returned an invalid action list");
  const actions = value.actions.map(item => ({ ...(item as TaskAssistantAction) }));
  let ambiguity: TaskAssistantPlan["ambiguity"];
  actions.forEach((action, index) => {
    validateAction(action);
    if (action.type === "create_task") return;
    if (action.task_id) {
      if (!tasks.some(task => task._id === action.task_id && !task.is_deleted)) throw new Error("AI referenced an unavailable task");
      return;
    }
    const matches = resolveTaskQuery(tasks, action.query ?? "");
    if (action.type === "search_tasks") return;
    if (matches.length === 1) action.task_id = matches[0]._id;
    else if (matches.length > 1 && !ambiguity) ambiguity = { actionIndex: index, candidates: matches.slice(0, 8).map(task => ({ _id: task._id, text: task.text, project: task.project })) };
    else if (!matches.length) throw new Error(`No task matched “${action.query ?? ""}”`);
  });
  return { message: typeof value.message === "string" ? value.message : "", actions, ambiguity, requiresConfirmation: actions.some(action => CONFIRM_ACTIONS.has(action.type)) };
}

export async function requestTaskAssistant(command: string, tasks: TaskRegistry, projects: ProjectState[], routines: ActivityState["routines"], settings: MorningOSSettings): Promise<TaskAssistantPlan> {
  // Keep the Obsidian-dependent provider client out of the pure service/test import path.
  const { callLLM } = await import("./agent/llm");
  const context = { date: todayStr(), command, tasks: tasks.filter(task => !task.is_deleted).map(({ _id, text, project, planned_date, date_remind, execution_state, status_completion, focus_order, effort_minutes, eisenhower_priority }) => ({ _id, text, project, planned_date, date_remind, execution_state, status_completion, focus_order, effort_minutes, eisenhower_priority })), projects, routines: routines.filter(routine => routine.enabled) };
  const raw = await callLLM(SYSTEM, JSON.stringify(context), settings);
  return prepareTaskAssistantPlan(parseJsonObject(raw), tasks);
}

async function loadActivities(app: App): Promise<TaskAssistantActivity[]> {
  if (!(await app.vault.adapter.exists(ACTIVITY_PATH))) return [];
  try { const parsed = JSON.parse(await app.vault.adapter.read(ACTIVITY_PATH)); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
export async function loadTaskAssistantActivities(app: App): Promise<TaskAssistantActivity[]> { return loadActivities(app); }
async function saveActivities(app: App, activities: TaskAssistantActivity[]): Promise<void> {
  if (!(await app.vault.adapter.exists("_generated"))) await app.vault.adapter.mkdir("_generated");
  await app.vault.adapter.write(ACTIVITY_PATH, JSON.stringify(activities, null, 2));
}

function changedTasks(before: TaskRegistry, after: TaskRegistry): TaskAssistantActivity["changes"] {
  const ids = new Set([...before.map(task => task._id), ...after.map(task => task._id)]);
  return [...ids].flatMap(taskId => {
    const oldTask = before.find(task => task._id === taskId) ?? null; const newTask = after.find(task => task._id === taskId) ?? null;
    return JSON.stringify(oldTask) === JSON.stringify(newTask) ? [] : [{ taskId, before: oldTask, after: newTask }];
  });
}

export function describeTaskAssistantAction(action: TaskAssistantAction, tasks: TaskRegistry): string {
  const task = tasks.find(item => item._id === action.task_id); const label = task?.text ?? action.title ?? action.query ?? "task";
  const verbs: Record<TaskAssistantActionType, string> = { search_tasks: "Found", create_task: "Created", update_task: "Updated", complete_task: "Completed", set_deadline: "Set deadline for", set_status: "Changed status of", set_project: "Changed project for", move_to_today: "Moved to Today", move_to_backlog: "Moved to backlog", add_to_focus: "Added to Focus", remove_from_focus: "Removed from Focus" };
  return `${verbs[action.type]}: ${label}`;
}

export async function executeTaskAssistantAction(app: App, action: TaskAssistantAction): Promise<TaskAssistantActivity | null> {
  validateAction(action);
  if (action.type === "search_tasks") return null;
  if (action.type !== "create_task" && !action.task_id) throw new Error("Choose a task before running this action");
  const before = await loadRegistry(app);
  if (action.type === "create_task") {
    const task = createTask(action.title!, { project: action.project?.trim() ?? "", date_remind: action.deadline ?? null, planned_date: action.planned_date ?? null, effort_minutes: action.effort_minutes ?? null, eisenhower_priority: action.priority ?? "", status_priority: action.priority === "urgent_important" ? "red" : "regular" });
    await saveRegistry(app, [...before, task]); action.task_id = task._id;
  } else if (action.type === "complete_task") await setTaskStatus(app, action.task_id!, "done");
  else if (action.type === "set_deadline") await updateTask(app, action.task_id!, { date_remind: action.deadline ?? null });
  else if (action.type === "set_status") await applyMutations(app, [{ type: "set-execution-state", task_id: action.task_id!, state: action.status! }]);
  else if (action.type === "set_project") await updateTask(app, action.task_id!, { project: action.project?.trim() ?? "" });
  else if (action.type === "move_to_today") await applyMutations(app, [{ type: "move-to-today", task_id: action.task_id! }]);
  else if (action.type === "move_to_backlog") await applyMutations(app, [{ type: "move-to-backlog", task_id: action.task_id! }]);
  else if (action.type === "remove_from_focus") await updateTask(app, action.task_id!, { focus_order: null });
  else if (action.type === "add_to_focus") {
    const focus = before.filter(task => task.focus_order !== null && task.status_completion === "open" && !task.is_deleted);
    const used = new Set(focus.map(task => task.focus_order)); const order = ([1, 2, 3] as const).find(value => !used.has(value));
    if (!order) throw new Error("Focus is full");
    await applyMutations(app, [{ type: "set-focus", task_id: action.task_id!, order }]);
  } else if (action.type === "update_task") {
    const patch: Partial<Task> = {};
    if (action.title !== undefined) patch.text = action.title.trim();
    if (action.notes !== undefined) patch.notes = action.notes;
    if (action.effort_minutes !== undefined) patch.effort_minutes = action.effort_minutes;
    if (action.priority !== undefined) { patch.eisenhower_priority = action.priority; patch.status_priority = action.priority === "urgent_important" ? "red" : "regular"; }
    await updateTask(app, action.task_id!, patch);
  }
  const after = await loadRegistry(app); const summary = describeTaskAssistantAction(action, after);
  const activity: TaskAssistantActivity = { id: `ai-task-${generateId()}`, timestamp: new Date().toISOString(), summary, changes: changedTasks(before, after) };
  const activities = await loadActivities(app); activities.push(activity); await saveActivities(app, activities); return activity;
}

export async function undoTaskAssistantActivity(app: App, activityId: string): Promise<void> {
  const activities = await loadActivities(app); const activity = activities.find(item => item.id === activityId);
  if (!activity || activity.undoneAt) throw new Error("This AI action is no longer available to undo");
  let tasks = await loadRegistry(app);
  for (const change of activity.changes) {
    const index = tasks.findIndex(task => task._id === change.taskId);
    if (change.before === null) { if (index !== -1) tasks.splice(index, 1); }
    else if (index === -1) tasks.push(change.before); else tasks[index] = change.before;
  }
  await saveRegistry(app, tasks); activity.undoneAt = new Date().toISOString(); await saveActivities(app, activities);
}

import type { ActivityState, FocusSession, ProjectState, ProjectSummary, Routine, SuggestedProjectAction, Task, TaskRegistry, WeeklyActivitySummary, WorkloadSummary } from "./types";
import { todayStr } from "./utils";

function projectTaskPriority(task: Task): number {
  if (task.eisenhower_priority === "urgent_important") return 0;
  if (task.status_priority === "red") return 1;
  if (task.eisenhower_priority === "important_not_urgent") return 2;
  if (task.eisenhower_priority === "urgent_not_important") return 3;
  return 4;
}

function compareProjectTasks(left: Task, right: Task): number {
  return projectTaskPriority(left) - projectTaskPriority(right)
    || left.date_created.localeCompare(right.date_created)
    || left.text.localeCompare(right.text);
}

export function selectTodayTasks(tasks: TaskRegistry, date = todayStr()): Task[] {
  return tasks.filter(task => !task.is_deleted && task.status_completion === "open" && task.planned_date === date);
}

export function selectFocusTasks(tasks: TaskRegistry, date = todayStr()): Task[] {
  return selectTodayTasks(tasks, date)
    .filter(task => task.execution_state === "ready" && task.focus_order !== null)
    .sort((left, right) => (left.focus_order ?? 99) - (right.focus_order ?? 99))
    .slice(0, 3);
}

export function selectUnfinishedTasks(tasks: TaskRegistry, date = todayStr()): Task[] {
  return tasks.filter(task => {
    if (task.is_deleted || task.status_completion !== "open" || task.planned_date === null || task.planned_date >= date) return false;
    const daily = task.daily_progress_target;
    const reachedDailyTarget = Boolean(task.progress && daily && daily.date === task.planned_date && task.progress.current - daily.startingValue >= daily.target);
    return !reachedDailyTarget;
  });
}

export function selectContinuableProgressTasks(tasks: TaskRegistry, date = todayStr()): Task[] {
  return tasks.filter(task => !task.is_deleted && task.status_completion === "open" && task.progress && task.planned_date !== null && task.planned_date < date && !selectUnfinishedTasks([task], date).length);
}

export function selectWorkload(tasks: TaskRegistry, date = todayStr()): WorkloadSummary {
  const today = selectTodayTasks(tasks, date);
  const isDeepWork = (context: string) => ["deep-work", "deep work", "deep_work"].includes(context.trim().toLowerCase());
  return {
    task_count: today.length,
    known_minutes: today.reduce((sum, task) => sum + (task.effort_minutes ?? 0), 0),
    unknown_count: today.filter(task => task.effort_minutes === null).length,
    deep_work_minutes: today.filter(task => isDeepWork(task.context)).reduce((sum, task) => sum + (task.effort_minutes ?? 0), 0),
  };
}

export function selectSuggestedProjectActions(tasks: TaskRegistry, projectStates: ProjectState[], date = todayStr()): SuggestedProjectAction[] {
  const projects = new Set(tasks.filter(task => !task.is_deleted && task.status_completion === "open" && task.project.trim()).map(task => task.project.trim()));
  return [...projects].sort((left, right) => left.localeCompare(right)).flatMap(project => {
    const eligible = tasks.filter(task => !task.is_deleted && task.status_completion === "open" && task.project === project && task.execution_state === "ready" && task.planned_date === null && !task.is_today);
    if (!eligible.length) return [];
    const state = projectStates.find(item => item.name === project);
    const next = state?.next_action_task_id
      ? eligible.find(task => task._id === state.next_action_task_id)
      : eligible.find(task => task.text.trim().toLocaleLowerCase() === state?.next_action.trim().toLocaleLowerCase());
    return [{ project, task: next ?? [...eligible].sort(compareProjectTasks)[0], source: next ? "next" as const : "ready" as const }];
  });
}

export function selectProjectPlanningTasks(tasks: TaskRegistry, project: string, state?: ProjectState, date = todayStr()): Task[] {
  const isNext = (task: Task) => state?.next_action_task_id
    ? task._id === state.next_action_task_id
    : Boolean(state?.next_action.trim() && task.text.trim().toLocaleLowerCase() === state.next_action.trim().toLocaleLowerCase());
  const executionRank = (task: Task) => task.execution_state === "ready" ? 0 : task.execution_state === "waiting" ? 1 : 2;
  return tasks
    .filter(task => !task.is_deleted && task.status_completion === "open" && task.project === project)
    .sort((left, right) => Number(isNext(right)) - Number(isNext(left))
      || executionRank(left) - executionRank(right)
      || Number(left.planned_date === date) - Number(right.planned_date === date)
      || compareProjectTasks(left, right));
}

export function getRemainingDailyRoutineMinutes(state: ActivityState, date = todayStr()): number {
  return state.routines
    .filter(routine => routine.enabled && routine.cadence === "daily" && routine.metric === "duration")
    .reduce((sum, routine) => sum + Math.max(0, routine.target - getRoutineProgress(state, routine, date)), 0);
}

export function formatCombinedWorkloadSummary(workload: WorkloadSummary, routineMinutes: number): string {
  const parts = [`${workload.task_count} ${workload.task_count === 1 ? "task" : "tasks"}`];
  if (workload.known_minutes > 0) parts.push(`~${formatDuration(workload.known_minutes)} tasks`);
  if (routineMinutes > 0) parts.push(`~${formatDuration(routineMinutes)} routines`);
  if (workload.unknown_count > 0) parts.push(`${workload.unknown_count} unestimated`);
  return parts.join(" · ");
}

export function formatWorkloadSummary(workload: WorkloadSummary): string {
  const tasks = `${workload.task_count} ${workload.task_count === 1 ? "task" : "tasks"}`;
  if (workload.task_count === 0) return tasks;
  if (workload.unknown_count === workload.task_count) return `${tasks} · all unestimated`;
  if (workload.unknown_count === 0) return `${tasks} · ~${formatDuration(workload.known_minutes)} planned`;
  return `${tasks} · ~${formatDuration(workload.known_minutes)} known · ${workload.unknown_count} unestimated`;
}

function daysBetween(date: string, now: string): number {
  return Math.max(0, Math.floor((new Date(`${now}T12:00:00`).getTime() - new Date(`${date}T12:00:00`).getTime()) / 86400000));
}

export function selectProjectSummaries(tasks: TaskRegistry, projectStates: ProjectState[], date = todayStr()): ProjectSummary[] {
  const names = new Set([...tasks.map(task => task.project.trim()).filter(Boolean), ...projectStates.map(project => project.name.trim()).filter(Boolean)]);
  return [...names].map(name => {
    const projectTasks = tasks.filter(task => !task.is_deleted && task.project === name);
    const open = projectTasks.filter(task => task.status_completion === "open");
    const state = projectStates.find(project => project.name === name);
    const fallback = open
      .filter(task => task.execution_state === "ready")
      .sort((left, right) => {
        const focus = (left.focus_order ?? 99) - (right.focus_order ?? 99);
        if (focus !== 0) return focus;
        if (left.planned_date === date && right.planned_date !== date) return -1;
        if (right.planned_date === date && left.planned_date !== date) return 1;
        return left.date_created.localeCompare(right.date_created);
      })[0];
    const touched = [state?.date_modified, ...projectTasks.map(task => task.date_modified), ...projectTasks.map(task => task.date_completed)].filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
    return {
      name,
      open_count: open.length,
      today_count: open.filter(task => task.planned_date === date).length,
      blocked_count: open.filter(task => task.execution_state === "blocked").length,
      next_action: state?.next_action.trim() || fallback?.text || "",
      last_touched: touched,
      days_since_activity: touched ? daysBetween(touched, date) : null,
    };
  }).sort((left, right) => (left.days_since_activity ?? 999) - (right.days_since_activity ?? 999) || left.name.localeCompare(right.name));
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function formatRecency(days: number | null, staleDays: number): string {
  if (days === null) return "No activity yet";
  if (days === 0) return "Touched today";
  return days >= staleDays ? `Stale · ${days}d` : `Touched ${days}d ago`;
}

function localDate(timestamp: string): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function weekStart(date: string): string {
  const value = new Date(`${date}T12:00:00`);
  const offset = (value.getDay() + 6) % 7;
  value.setDate(value.getDate() - offset);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function completedInRange(sessions: FocusSession[], start: string, end: string): FocusSession[] {
  return sessions.filter(session => session.status === "completed" && localDate(session.endedAt ?? session.startedAt) >= start && localDate(session.endedAt ?? session.startedAt) <= end);
}

export function getTodayFocusMinutes(state: ActivityState, date = todayStr()): number {
  return completedInRange(state.focusSessions, date, date).reduce((sum, session) => sum + (session.durationMinutes ?? 0), 0);
}

export function getWeeklyFocusMinutes(state: ActivityState, date = todayStr()): number {
  return completedInRange(state.focusSessions, weekStart(date), date).reduce((sum, session) => sum + (session.durationMinutes ?? 0), 0);
}

export function getSessionCount(state: ActivityState, cadence: "today" | "week", date = todayStr()): number {
  return completedInRange(state.focusSessions, cadence === "today" ? date : weekStart(date), date).length;
}

export function getProjectFocusMinutes(state: ActivityState, date = todayStr()): Record<string, number> {
  return completedInRange(state.focusSessions, weekStart(date), date).reduce<Record<string, number>>((result, session) => {
    if (session.projectId) result[session.projectId] = (result[session.projectId] ?? 0) + (session.durationMinutes ?? 0);
    return result;
  }, {});
}

export function getRoutineProgress(state: ActivityState, routine: Routine, date = todayStr()): number {
  const start = routine.cadence === "daily" ? date : weekStart(date);
  const manual = state.routineLogs.filter(log => log.routineId === routine.id && log.date >= start && log.date <= date).reduce((sum, log) => sum + log.value, 0);
  const focused = routine.metric === "duration"
    ? completedInRange(state.focusSessions, start, date).filter(session => session.routineId === routine.id).reduce((sum, session) => sum + (session.durationMinutes ?? 0), 0)
    : 0;
  if (routine.metric === "count" && /read/i.test(routine.name)) return getWeeklyReadingCount(state, date);
  return Math.max(0, manual + focused);
}

export function getWeeklyReadingCount(state: ActivityState, date = todayStr()): number {
  const start = weekStart(date);
  return state.readingEntries.filter(entry => entry.level === "read" && entry.date >= start && entry.date <= date).length;
}

export function getWeeklyActivitySummary(state: ActivityState, date = todayStr()): WeeklyActivitySummary {
  return {
    focusedMinutes: getWeeklyFocusMinutes(state, date),
    sessions: getSessionCount(state, "week", date),
    projectFocusMinutes: getProjectFocusMinutes(state, date),
    routineProgress: Object.fromEntries(state.routines.filter(routine => routine.enabled).map(routine => [routine.name, { value: getRoutineProgress(state, routine, date), target: routine.target, unit: routine.unit ?? (routine.metric === "duration" ? "min" : routine.metric === "count" ? "times" : "done") }])),
    papersRead: getWeeklyReadingCount(state, date),
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import type { Task } from "../src/types";
import { formatCombinedWorkloadSummary, formatWorkloadSummary, getRemainingDailyRoutineMinutes, selectContinuableProgressTasks, selectFocusTasks, selectProjectPlanningTasks, selectProjectSummaries, selectSuggestedProjectActions, selectUnfinishedTasks, selectWorkload } from "../src/selectors";
import { defaultActivityState } from "../src/activity-service";
import { shouldAutoSaveTask, taskHasChanges } from "../src/task-edit-state";

const task = (id: string, patch: Partial<Task> = {}): Task => ({
  _id: id, text: id, notes: "", areas: [], tags: {}, status_completion: "open", status_priority: "regular",
  status_urgency: "none", is_today: true, is_deleted: false, date_created: "2026-09-01", date_modified: "2026-09-06",
  date_completed: null, date_remind: null, parent_id: null, project: "Paper", eisenhower_priority: "", planned_date: "2026-09-06",
  effort_minutes: null, context: "", execution_state: "ready", focus_order: null, ...patch,
});

test("Focus is an ordered ready subset of Today and limited to three", () => {
  const tasks = [
    task("third", { focus_order: 3 }), task("first", { focus_order: 1 }), task("blocked", { focus_order: 2, execution_state: "blocked" }),
    task("second", { focus_order: 2 }), task("fourth", { focus_order: 4 }), task("backlog", { planned_date: null, is_today: false, focus_order: 1 }),
  ];
  assert.deepEqual(selectFocusTasks(tasks, "2026-09-06").map(item => item._id), ["first", "second", "third"]);
});

test("workload uses deterministic known effort and reports unknowns", () => {
  const result = selectWorkload([
    task("deep", { effort_minutes: 120, context: "deep work" }), task("admin", { effort_minutes: 30, context: "admin" }), task("unknown"),
  ], "2026-09-06");
  assert.deepEqual(result, { task_count: 3, known_minutes: 150, unknown_count: 1, deep_work_minutes: 120 });
});

test("workload summary uses human-readable estimation states", () => {
  assert.equal(formatWorkloadSummary({ task_count: 3, known_minutes: 0, unknown_count: 3, deep_work_minutes: 0 }), "3 tasks · all unestimated");
  assert.equal(formatWorkloadSummary({ task_count: 3, known_minutes: 120, unknown_count: 1, deep_work_minutes: 120 }), "3 tasks · ~2h known · 1 unestimated");
  assert.equal(formatWorkloadSummary({ task_count: 3, known_minutes: 180, unknown_count: 0, deep_work_minutes: 120 }), "3 tasks · ~3h planned");
  assert.equal(formatWorkloadSummary({ task_count: 0, known_minutes: 0, unknown_count: 0, deep_work_minutes: 0 }), "0 tasks");
});

test("project summary counts state and prefers explicit next action", () => {
  const result = selectProjectSummaries([
    task("ready", { text: "Fallback", project: "Paper" }), task("blocked", { project: "Paper", execution_state: "blocked" }),
  ], [{ name: "Paper", next_action: "Revise section 2", date_modified: "2026-09-05" }], "2026-09-06")[0];
  assert.equal(result.open_count, 2);
  assert.equal(result.today_count, 2);
  assert.equal(result.blocked_count, 1);
  assert.equal(result.next_action, "Revise section 2");
  assert.equal(result.days_since_activity, 0);
});

test("task editor auto-saves implicit close but honors explicit discard", () => {
  const original = task("draft", { text: "Before" });
  const edited = { ...original, text: "After" };
  assert.equal(taskHasChanges(original, original), false);
  assert.equal(taskHasChanges(original, edited), true);
  assert.equal(shouldAutoSaveTask(original, edited, "implicit"), true);
  assert.equal(shouldAutoSaveTask(original, edited, "discard"), false);
  assert.equal(shouldAutoSaveTask(original, edited, "saved"), false);
});

test("a reached daily progress target is continuable, not unfinished rollover", () => {
  const reached = task("progress", { planned_date: "2026-09-05", is_today: false, progress: { type: "count", current: 820, target: 2000, unit: "objects" }, daily_progress_target: { date: "2026-09-05", target: 300, startingValue: 520 } });
  assert.equal(selectUnfinishedTasks([reached], "2026-09-06").length, 0);
  assert.equal(selectContinuableProgressTasks([reached], "2026-09-06").length, 1);
});

test("Morning Planning suggests at most one ready backlog task per project and prefers Next", () => {
  const next = task("next", { text: "Inspect residuals", project: "Survey", planned_date: null, is_today: false });
  const other = task("other", { text: "Run model", project: "Survey", planned_date: null, is_today: false });
  const blocked = task("blocked-backlog", { project: "Paper", planned_date: null, is_today: false, execution_state: "blocked" });
  const today = task("today", { project: "Other" });
  const result = selectSuggestedProjectActions([other, next, blocked, today], [{ name: "Survey", next_action: next.text, next_action_task_id: next._id, date_modified: "2026-09-06" }], "2026-09-06");
  assert.deepEqual(result.map(item => [item.project, item.task._id, item.source]), [["Survey", "next", "next"]]);
});

test("View project exposes every open task while keeping Next and ready backlog tasks first", () => {
  const next = task("next", { text: "Preferred next", project: "Survey", planned_date: null, is_today: false });
  const alternative = task("alternative", { text: "Alternative", project: "Survey", planned_date: null, is_today: false });
  const today = task("today-project", { project: "Survey" });
  const waiting = task("waiting-project", { project: "Survey", planned_date: null, is_today: false, execution_state: "waiting" });
  const blocked = task("blocked-project", { project: "Survey", planned_date: null, is_today: false, execution_state: "blocked" });
  const done = task("done-project", { project: "Survey", status_completion: "done" });
  const result = selectProjectPlanningTasks([today, waiting, blocked, alternative, done, next], "Survey", { name: "Survey", next_action: next.text, next_action_task_id: next._id, date_modified: "2026-09-06" }, "2026-09-06");
  assert.deepEqual(result.map(item => item._id), ["next", "alternative", "today-project", "waiting-project", "blocked-project"]);
});

test("daily duration routines contribute only their remaining minutes", () => {
  const state = defaultActivityState();
  state.routines = [
    { id: "daily", name: "Write", cadence: "daily", metric: "duration", target: 50, unit: "min", enabled: true },
    { id: "weekly", name: "Read", cadence: "weekly", metric: "count", target: 5, unit: "papers", enabled: true },
  ];
  state.routineLogs = [{ id: "log", routineId: "daily", date: "2026-09-06", value: 20, createdAt: "2026-09-06T08:00:00Z" }];
  assert.equal(getRemainingDailyRoutineMinutes(state, "2026-09-06"), 30);
  assert.equal(formatCombinedWorkloadSummary({ task_count: 3, known_minutes: 165, unknown_count: 1, deep_work_minutes: 0 }, 50), "3 tasks · ~2h 45m tasks · ~50m routines · 1 unestimated");
});

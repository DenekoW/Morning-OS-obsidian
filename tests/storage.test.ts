import test from "node:test";
import assert from "node:assert/strict";
import { createTask, createProjectTask, migrateTask, parseTaskMarkdown, serializeTaskMarkdown, saveRegistry, loadRegistry, setTaskStatus, updateTask } from "../src/task-registry";
import { todayStr } from "../src/utils";

test("legacy tasks receive optional metadata defaults", () => {
  const restored = migrateTask({ _id: "old", text: "Legacy", is_today: true });
  assert.equal(restored.execution_state, "ready");
  assert.equal(restored.effort_minutes, null);
  assert.equal(restored.context, "");
  assert.equal(restored.project, "");
  assert.equal(restored.routine_id, null);
  assert.equal(restored.progress, null);
});

test("progress metadata round-trips without affecting binary tasks", () => {
  const original = createTask("Inspect", { progress: { type: "count", current: 720, target: 2000, unit: "galaxies" }, daily_progress_target: { date: "2026-09-06", target: 300, startingValue: 520 } });
  const restored = parseTaskMarkdown(serializeTaskMarkdown([original]))[0];
  assert.deepEqual(restored.progress, original.progress);
  assert.deepEqual(restored.daily_progress_target, original.daily_progress_target);
});

test("Markdown registry round-trips research planning metadata", () => {
  const original = createTask("Run fit", { project: "research", planned_date: todayStr(), effort_minutes: 90, context: "server", focus_order: 1, routine_id: "routine-writing" });
  const restored = parseTaskMarkdown(serializeTaskMarkdown([original]))[0];
  assert.equal(restored.project, "research");
  assert.equal(restored.effort_minutes, 90);
  assert.equal(restored.context, "server");
  assert.equal(restored.focus_order, 1);
  assert.equal(restored.routine_id, "routine-writing");
});

test("blocked Focus is normalized out", () => {
  const blocked = createTask("Waiting", { planned_date: todayStr(), execution_state: "blocked", focus_order: 1 });
  assert.equal(parseTaskMarkdown(serializeTaskMarkdown([blocked]))[0].focus_order, null);
});

test("Focus normalization preserves explicit rank instead of Markdown order", () => {
  const second = createTask("Second", { planned_date: todayStr(), focus_order: 2 });
  const first = createTask("First", { planned_date: todayStr(), focus_order: 1 });
  const restored = parseTaskMarkdown(serializeTaskMarkdown([second, first]));
  assert.equal(restored.find(task => task.text === "First")?.focus_order, 1);
  assert.equal(restored.find(task => task.text === "Second")?.focus_order, 2);
});

test("project task creation keeps backlog separate from Today and maps priority", () => {
  const backlog = createProjectTask("Run baseline", "  research  ", "important_not_urgent", "backlog");
  assert.equal(backlog.project, "research");
  assert.equal(backlog.is_today, false);
  assert.equal(backlog.planned_date, null);
  assert.equal(backlog.eisenhower_priority, "important_not_urgent");
  assert.equal(backlog.status_priority, "regular");

  const today = createProjectTask("Inspect failure", "research", "urgent_important", "today");
  assert.equal(today.is_today, true);
  assert.equal(today.status_priority, "red");
  assert.throws(() => createProjectTask("", "research", "", "backlog"), /Task text/);
  assert.throws(() => createProjectTask("Run", "", "", "backlog"), /Project/);
});

test("legacy is_today mutation can remove a task from Today", async () => {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const app = { vault: { adapter: {
    exists: async (path: string) => files.has(path) || folders.has(path),
    read: async (path: string) => files.get(path) ?? "",
    write: async (path: string, value: string) => { files.set(path, value); },
    mkdir: async (path: string) => { folders.add(path); },
    remove: async (path: string) => { files.delete(path); },
  } } } as never;
  const today = createTask("Today", { is_today: true, focus_order: 1 });
  await saveRegistry(app, [today]);
  await updateTask(app, today._id, { is_today: false });
  const restored = (await loadRegistry(app))[0];
  assert.equal(restored.planned_date, null);
  assert.equal(restored.is_today, false);
  assert.equal(restored.focus_order, null);
});

test("removing or completing a Focus task preserves the Focus/Today invariants", async () => {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const app = { vault: { adapter: {
    exists: async (path: string) => files.has(path) || folders.has(path),
    read: async (path: string) => files.get(path) ?? "",
    write: async (path: string, value: string) => { files.set(path, value); },
    mkdir: async (path: string) => { folders.add(path); },
    remove: async (path: string) => { files.delete(path); },
  } } } as never;
  const focused = createTask("Focused", { is_today: true, focus_order: 1 });
  await saveRegistry(app, [focused]);
  await updateTask(app, focused._id, { focus_order: null });
  let restored = (await loadRegistry(app))[0];
  assert.equal(restored.is_today, true);
  assert.equal(restored.focus_order, null);

  await updateTask(app, focused._id, { focus_order: 1 });
  await setTaskStatus(app, focused._id, "done");
  restored = (await loadRegistry(app))[0];
  assert.equal(restored.status_completion, "done");
  assert.equal(restored.focus_order, null);
});

test("a progress task cannot complete before its overall target", async () => {
  const files = new Map<string, string>(); const folders = new Set<string>();
  const app = { vault: { adapter: { exists: async (path: string) => files.has(path) || folders.has(path), read: async (path: string) => files.get(path) ?? "", write: async (path: string, value: string) => { files.set(path, value); }, mkdir: async (path: string) => { folders.add(path); }, remove: async (path: string) => { files.delete(path); } } } } as never;
  const progress = createTask("Inspect", { progress: { type: "count", current: 9, target: 10, unit: "objects" } });
  await saveRegistry(app, [progress]);
  await assert.rejects(() => setTaskStatus(app, progress._id, "done"), /must reach/);
  assert.equal((await loadRegistry(app))[0].status_completion, "open");
});

test("pipeline stage round-trips through the Markdown registry", () => {
  const original = createTask("Reduce catalogs", { is_today: true, pipeline_stage: "collecting" });
  const restored = parseTaskMarkdown(serializeTaskMarkdown([original]))[0];
  assert.equal(restored.pipeline_stage, "collecting");
});

test("pipeline stage defaults safely for legacy and invalid values", () => {
  assert.equal(migrateTask({ _id: "a", text: "Legacy" }).pipeline_stage, null);
  assert.equal(migrateTask({ _id: "b", text: "Bogus", pipeline_stage: "halfway" }).pipeline_stage, null);
  assert.equal(migrateTask({ _id: "c", text: "Done", status_completion: "done" }).pipeline_stage, "complete");
});

test("completing or reopening a task keeps the pipeline stage in sync", async () => {
  const files = new Map<string, string>(); const folders = new Set<string>();
  const app = { vault: { adapter: { exists: async (path: string) => files.has(path) || folders.has(path), read: async (path: string) => files.get(path) ?? "", write: async (path: string, value: string) => { files.set(path, value); }, mkdir: async (path: string) => { folders.add(path); }, remove: async (path: string) => { files.delete(path); } } } } as never;
  const task = createTask("Write section", { is_today: true, pipeline_stage: "working" });
  await saveRegistry(app, [task]);

  await setTaskStatus(app, task._id, "done");
  let restored = (await loadRegistry(app))[0];
  assert.equal(restored.status_completion, "done");
  assert.equal(restored.pipeline_stage, "complete");

  await setTaskStatus(app, task._id, "open");
  restored = (await loadRegistry(app))[0];
  assert.equal(restored.status_completion, "open");
  assert.equal(restored.pipeline_stage, "working");
});

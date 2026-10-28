import test from "node:test";
import assert from "node:assert/strict";
import { createProject, deleteProject, ensureProjectNextTask, loadProjectStates, renameProject, setProjectNextAction } from "../src/project-state";
import { loadWorkflowState, saveWorkflowState } from "../src/workflow-state";
import { moveFocusTask } from "../src/mutation-service";
import { createTask, loadRegistry, saveRegistry } from "../src/task-registry";
import { defaultActivityState, loadActivityState, saveActivityState } from "../src/activity-service";

function mockApp() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  return {
    files,
    app: { vault: { adapter: {
      exists: async (path: string) => files.has(path) || folders.has(path),
      read: async (path: string) => files.get(path) ?? "",
      write: async (path: string, value: string) => { files.set(path, value); },
      mkdir: async (path: string) => { folders.add(path); },
      remove: async (path: string) => { files.delete(path); },
    } } } as never,
  };
}

test("workflow service persists planning and shutdown independently per day", async () => {
  const { app } = mockApp();
  const state = await loadWorkflowState(app, "2026-09-06");
  state.planning_completed_at = "2026-09-06T08:00:00Z";
  state.still_on_mind = "Check the fit";
  state.tomorrow_first_task_id = "task-1";
  state.closed_at = "2026-09-06T18:00:00Z";
  await saveWorkflowState(app, state);
  assert.deepEqual(await loadWorkflowState(app, "2026-09-06"), state);
  assert.equal((await loadWorkflowState(app, "2026-09-07")).dismissed_last_night_task_id, null);
  assert.equal((await loadWorkflowState(app, "2026-09-07")).closed_at, null);
});

test("project service updates one explicit next action without duplicating the project", async () => {
  const { app } = mockApp();
  await setProjectNextAction(app, "research", "Run baseline");
  await setProjectNextAction(app, "research", "Inspect residuals");
  const states = await loadProjectStates(app);
  assert.equal(states.length, 1);
  assert.equal(states[0].next_action, "Inspect residuals");
});

test("project next action is linked to an editable task without duplicating legacy tasks", async () => {
  const { app } = mockApp();
  const existing = createTask("Inspect residuals", { project: "research", is_today: false });
  await saveRegistry(app, [existing]);
  await setProjectNextAction(app, "research", "Inspect residuals");
  const linked = await ensureProjectNextTask(app, "research", "Inspect residuals");
  assert.equal(linked?._id, existing._id);
  assert.equal((await loadRegistry(app)).length, 1);
  assert.equal((await loadProjectStates(app))[0].next_action_task_id, existing._id);
});

test("editing linked Next text renames the same task instead of creating a title-only action", async () => {
  const { app } = mockApp();
  const created = await ensureProjectNextTask(app, "research", "Run baseline");
  const renamed = await ensureProjectNextTask(app, "research", "Inspect residuals");
  const registry = await loadRegistry(app);
  assert.equal(registry.length, 1);
  assert.equal(renamed?._id, created?._id);
  assert.equal(registry[0].text, "Inspect residuals");
  assert.equal((await loadProjectStates(app))[0].next_action, "Inspect residuals");
});

test("project service creates an empty project and rejects blank or duplicate names", async () => {
  const { app } = mockApp();
  const created = await createProject(app, "  New Survey  ", "Define sample");
  assert.equal(created.name, "New Survey");
  assert.equal(created.next_action, "Define sample");
  assert.equal((await loadProjectStates(app)).length, 1);
  await assert.rejects(() => createProject(app, "new survey"), /already exists/);
  await assert.rejects(() => createProject(app, "   "), /name is required/);
});

test("renaming a project updates its state, tasks, and routines without changing task identity", async () => {
  const { app } = mockApp();
  await createProject(app, "research");
  const next = createTask("Inspect residuals", { project: "research", is_today: false });
  const completed = createTask("Build sample", { project: "research", status_completion: "done" });
  await saveRegistry(app, [next, completed]);
  await setProjectNextAction(app, "research", next.text, next._id);
  const activity = defaultActivityState();
  activity.routines[0].projectId = "research";
  await saveActivityState(app, activity);

  const result = await renameProject(app, "research", "Research QA");
  assert.deepEqual(result, { tasksUpdated: 2, routinesUpdated: 1 });
  assert.equal((await loadProjectStates(app))[0].name, "Research QA");
  assert.equal((await loadProjectStates(app))[0].next_action_task_id, next._id);
  assert.deepEqual((await loadRegistry(app)).map(task => [task._id, task.project]), [[next._id, "Research QA"], [completed._id, "Research QA"]]);
  assert.equal((await loadActivityState(app)).routines[0].projectId, "Research QA");
});

test("deleting a project keeps its tasks and routines but removes their project assignment", async () => {
  const { app } = mockApp();
  await createProject(app, "Temporary project");
  const task = createTask("Keep this task", { project: "Temporary project", is_today: true, focus_order: 1 });
  await saveRegistry(app, [task]);
  const activity = defaultActivityState();
  activity.routines[0].projectId = "Temporary project";
  await saveActivityState(app, activity);

  const result = await deleteProject(app, "Temporary project");
  assert.deepEqual(result, { tasksUpdated: 1, routinesUpdated: 1 });
  assert.equal((await loadProjectStates(app)).length, 0);
  const kept = (await loadRegistry(app))[0];
  assert.equal(kept._id, task._id);
  assert.equal(kept.project, "");
  assert.equal(kept.is_today, true);
  assert.equal(kept.focus_order, 1);
  assert.equal((await loadActivityState(app)).routines[0].projectId, null);
});

test("Focus reorder service swaps ranks without changing Today membership", async () => {
  const { app } = mockApp();
  const first = createTask("First", { is_today: true, focus_order: 1 });
  const second = createTask("Second", { is_today: true, focus_order: 2 });
  await saveRegistry(app, [first, second]);
  await moveFocusTask(app, second._id, -1);
  const reordered = await loadRegistry(app);
  assert.equal(reordered.find(task => task._id === second._id)?.focus_order, 1);
  assert.equal(reordered.find(task => task._id === first._id)?.focus_order, 2);
  assert.equal(reordered.every(task => task.is_today), true);
});

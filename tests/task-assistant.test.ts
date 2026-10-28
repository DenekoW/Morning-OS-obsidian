import test from "node:test";
import assert from "node:assert/strict";
import { executeTaskAssistantAction, prepareTaskAssistantPlan, resolveTaskQuery, undoTaskAssistantActivity } from "../src/task-assistant-service";
import { createTask, loadRegistry, saveRegistry } from "../src/task-registry";

function mockApp() {
  const files = new Map<string, string>(); const folders = new Set<string>();
  return { files, app: { vault: { adapter: {
    exists: async (path: string) => files.has(path) || folders.has(path), read: async (path: string) => files.get(path) ?? "",
    write: async (path: string, value: string) => { files.set(path, value); }, mkdir: async (path: string) => { folders.add(path); }, remove: async (path: string) => { files.delete(path); },
  } } } as never };
}

test("task assistant asks for a choice when a query has multiple plausible matches", () => {
  const figure = createTask("Finish result figure"); const normalization = createTask("Investigate figure normalization");
  const plan = prepareTaskAssistantPlan({ message: "", actions: [{ type: "complete_task", query: "figure" }] }, [figure, normalization]);
  assert.equal(plan.ambiguity?.candidates.length, 2);
  assert.equal(plan.actions[0].task_id, undefined);
});

test("task assistant resolves one exact task and applies low-risk actions without confirmation", () => {
  const task = createTask("Review sample quality");
  assert.equal(resolveTaskQuery([task], "Review sample quality")[0]._id, task._id);
  const plan = prepareTaskAssistantPlan({ message: "", actions: [{ type: "move_to_today", query: "Review sample quality" }] }, [task]);
  assert.equal(plan.actions[0].task_id, task._id);
  assert.equal(plan.requiresConfirmation, false);
});

test("AI create operations are logged and undo restores the prior registry", async () => {
  const { app } = mockApp(); await saveRegistry(app, []);
  const action = { type: "create_task" as const, title: "Check figure labels", project: "research", deadline: "2026-09-16" };
  const plan = prepareTaskAssistantPlan({ message: "", actions: [action] }, []);
  assert.equal(plan.requiresConfirmation, true);
  const activity = await executeTaskAssistantAction(app, plan.actions[0]);
  assert.equal((await loadRegistry(app))[0].date_remind, "2026-09-16");
  await undoTaskAssistantActivity(app, activity!.id);
  assert.equal((await loadRegistry(app)).length, 0);
});

test("AI Focus operation uses existing focus invariants and undo restores displaced state", async () => {
  const { app } = mockApp(); const task = createTask("Inspect sample"); await saveRegistry(app, [task]);
  const activity = await executeTaskAssistantAction(app, { type: "add_to_focus", task_id: task._id });
  let saved = (await loadRegistry(app))[0]; assert.equal(saved.focus_order, 1); assert.equal(saved.is_today, true);
  await undoTaskAssistantActivity(app, activity!.id);
  saved = (await loadRegistry(app))[0]; assert.equal(saved.focus_order, null); assert.equal(saved.is_today, false);
});

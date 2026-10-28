import test from "node:test";
import assert from "node:assert/strict";
import type { MorningOSSettings } from "../src/settings";
import { completeTaskWithNote } from "../src/task-completion-service";
import { loadProjectStates, setProjectNextAction } from "../src/project-state";
import { createTask, loadRegistry, saveRegistry } from "../src/task-registry";

function mockApp() {
  const files = new Map<string, string>(); const folders = new Set<string>();
  return { files, app: { vault: { adapter: {
    exists: async (path: string) => files.has(path) || folders.has(path), read: async (path: string) => files.get(path) ?? "",
    write: async (path: string, value: string) => { files.set(path, value); }, mkdir: async (path: string) => { folders.add(path); }, remove: async (path: string) => { files.delete(path); },
  } } } as never };
}

const settings = { dailyNoteDir: "Daily", syncTasksToDailyNote: true, workLogHeading: "Work Log" } as MorningOSSettings;

test("completing a task preserves its notes and writes the completion note to Daily Note", async () => {
  const { app, files } = mockApp();
  const task = createTask("Inspect residuals", { project: "research" }); task.notes = "Initial finding";
  await saveRegistry(app, [task]);
  const result = await completeTaskWithNote(app, settings, task._id, "The stricter cut works.", new Date("2026-09-13T14:30:00+08:00"));
  const saved = (await loadRegistry(app))[0];
  assert.equal(saved.status_completion, "done");
  assert.match(saved.notes ?? "", /Initial finding/);
  assert.match(saved.notes ?? "", /The stricter cut works\./);
  assert.equal(result.dailyNoteWritten, true);
  const daily = files.get("Daily/2026-09-13.md") ?? "";
  assert.match(daily, /Task completed/);
  assert.match(daily, /The stricter cut works\./);
});

test("retrying the same completion does not duplicate task notes or Work Log entries", async () => {
  const { app, files } = mockApp();
  const task = createTask("Run tests"); await saveRegistry(app, [task]);
  const now = new Date("2026-09-13T15:00:00+08:00");
  await completeTaskWithNote(app, settings, task._id, "All green.", now);
  await completeTaskWithNote(app, settings, task._id, "All green.", now);
  assert.equal(((await loadRegistry(app))[0].notes ?? "").match(/All green\./g)?.length, 1);
  assert.equal((files.get("Daily/2026-09-13.md") ?? "").match(/morning-os:work-log:task-completed-/g)?.length, 1);
});

test("completing the linked Next task clears the stale explicit project Next action", async () => {
  const { app } = mockApp();
  const task = createTask("Inspect residuals", { project: "research" }); await saveRegistry(app, [task]);
  await setProjectNextAction(app, "research", task.text, task._id);
  await completeTaskWithNote(app, settings, task._id, "Done", new Date("2026-09-13T16:00:00+08:00"));
  const project = (await loadProjectStates(app))[0];
  assert.equal(project.next_action, "");
  assert.equal(project.next_action_task_id, null);
});

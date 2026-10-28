import test from "node:test";
import assert from "node:assert/strict";
import type { MorningOSSettings } from "../src/settings";
import { appendWorkLogEvent, writeDailyTargetChangeEvent, writeMorningPlanSnapshot } from "../src/daily-note-service";
import { getTaskProgressToday, loadProgressEvents, logTaskProgress, setTaskDailyProgressTarget, syncPendingProgressEvents } from "../src/progress-service";
import { createTask, loadRegistry, saveRegistry } from "../src/task-registry";
import { dateStrFromTimestamp } from "../src/utils";

function mockApp() {
  const files = new Map<string, string>(); const folders = new Set<string>();
  return { files, app: { vault: { adapter: {
    exists: async (path: string) => files.has(path) || folders.has(path), read: async (path: string) => files.get(path) ?? "",
    write: async (path: string, value: string) => { files.set(path, value); }, mkdir: async (path: string) => { folders.add(path); }, remove: async (path: string) => { files.delete(path); },
  } } } as never };
}

const settings = { dailyNoteDir: "Daily", syncTasksToDailyNote: true, dailyPlanHeading: "Today's Plan", workLogHeading: "Work Log", shutdownHeading: "Shutdown" } as MorningOSSettings;

test("timestamps are assigned to a Daily Note using the local calendar date", () => {
  assert.equal(dateStrFromTimestamp("2026-09-06T00:30:00+08:00"), "2026-09-06");
});

test("progress service updates current state, preserves event history, and writes one journal event", async () => {
  const { app, files } = mockApp();
  const task = createTask("Inspect sample", { progress: { type: "count", current: 520, target: 2000, unit: "galaxies" }, is_today: true });
  await saveRegistry(app, [task]);
  const input = { mode: "add" as const, value: 200, note: "Second batch", timestamp: "2026-09-06T14:32:00.000Z", eventId: "event-1" };
  await logTaskProgress(app, settings, task._id, input);
  await logTaskProgress(app, settings, task._id, input);
  assert.equal((await loadRegistry(app))[0].progress?.current, 720);
  assert.equal((await loadProgressEvents(app)).length, 1);
  const note = files.get("Daily/2026-09-06.md") ?? "";
  assert.equal(note.match(/morning-os:work-log:event-1/g)?.length, 1);
  assert.match(note, /Progress: \+200 galaxies → 720 \/ 2000 galaxies/);
});

test("daily target is separate from overall completion state", async () => {
  const { app } = mockApp();
  const task = createTask("Inspect", { progress: { type: "count", current: 500, target: 2000, unit: "objects" } });
  await saveRegistry(app, [task]); await setTaskDailyProgressTarget(app, task._id, 300, "2026-09-06");
  const restored = (await loadRegistry(app))[0];
  assert.equal(restored.daily_progress_target?.startingValue, 500);
  assert.equal(getTaskProgressToday({ ...restored, progress: { ...restored.progress!, current: 800 } }, "2026-09-06"), 300);
  assert.equal(restored.status_completion, "open");
});

test("morning plan and generic work log writers are idempotent", async () => {
  const { app, files } = mockApp(); const task = createTask("Inspect", { is_today: true, project: "Survey", progress: { type: "count", current: 10, target: 100, unit: "objects" }, daily_progress_target: { date: "2026-09-06", target: 20, startingValue: 10 } });
  const ungrouped = createTask("Process inbox", { is_today: true });
  await writeMorningPlanSnapshot(app, settings, "2026-09-06", [task, ungrouped], [task]);
  await writeMorningPlanSnapshot(app, settings, "2026-09-06", [task, ungrouped], [task]);
  const event = { id: "focus-1", date: "2026-09-06", timestamp: "2026-09-06T10:00:00Z", title: "Inspect", details: ["Focus: 30m"] };
  await appendWorkLogEvent(app, settings, event); await appendWorkLogEvent(app, settings, event);
  const note = files.get("Daily/2026-09-06.md") ?? "";
  assert.equal(note.match(/morning-os:plan:2026-09-06/g)?.length, 1);
  assert.equal(note.match(/morning-os:work-log:focus-1/g)?.length, 1);
  assert.match(note, /Today: \+20 objects/);
  assert.match(note, /#### Survey/);
  assert.match(note, /#### No Project/);
  assert.match(note, /\*\*Survey\*\* — Inspect/);
});

test("a Daily Note failure leaves one pending event that can be replayed safely", async () => {
  const files = new Map<string, string>(); const folders = new Set<string>(); let failDaily = true;
  const app = { vault: { adapter: { exists: async (path: string) => files.has(path) || folders.has(path), read: async (path: string) => files.get(path) ?? "", write: async (path: string, value: string) => { if (failDaily && path.startsWith("Daily/")) throw new Error("disk busy"); files.set(path, value); }, mkdir: async (path: string) => { folders.add(path); }, remove: async (path: string) => { files.delete(path); } } } } as never;
  const task = createTask("Inspect", { progress: { type: "count", current: 0, target: 10 } }); await saveRegistry(app, [task]);
  const event = await logTaskProgress(app, settings, task._id, { mode: "add", value: 3, eventId: "pending-1", timestamp: "2026-09-06T10:00:00Z" });
  assert.equal(event.dailyNoteWritten, false); assert.equal((await loadRegistry(app))[0].progress?.current, 3);
  failDaily = false; assert.equal(await syncPendingProgressEvents(app, settings), 1);
  assert.equal((files.get("Daily/2026-09-06.md")?.match(/pending-1/g) ?? []).length, 1);
  assert.equal(await syncPendingProgressEvents(app, settings), 0);
});

test("changing a daily target is recorded as an idempotent work-log event", async () => {
  const { app, files } = mockApp(); const task = createTask("Inspect", { progress: { type: "count", current: 10, target: 100, unit: "objects" } });
  await writeDailyTargetChangeEvent(app, settings, task, 20, 30, "2026-09-06");
  await writeDailyTargetChangeEvent(app, settings, task, 20, 30, "2026-09-06");
  const note = files.get("Daily/2026-09-06.md") ?? "";
  assert.equal(note.match(/daily-target-/g)?.length, 1);
  assert.match(note, /Daily target changed: \+20 objects → \+30 objects/);
});

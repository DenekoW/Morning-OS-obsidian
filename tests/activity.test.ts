import test from "node:test";
import assert from "node:assert/strict";
import { adjustRoutineProgress, cancelFocusSession, elapsedMilliseconds, finishFocusSession, loadActivityState, logReading, logRoutine, markFocusSessionDailyNoteWritten, pauseFocusSession, resumeFocusSession, startFocusSession, updateRoutine } from "../src/activity-service";
import { getRoutineProgress, getSessionCount, getTodayFocusMinutes, getWeeklyFocusMinutes, getWeeklyReadingCount } from "../src/selectors";

function mockApp() {
  const files = new Map<string, string>(); const folders = new Set<string>();
  return { files, app: { vault: { adapter: {
    exists: async (path: string) => files.has(path) || folders.has(path), read: async (path: string) => files.get(path) ?? "",
    write: async (path: string, value: string) => { files.set(path, value); }, mkdir: async (path: string) => { folders.add(path); },
  } } } as never };
}

test("focus service persists timestamps and accumulated pause time across reloads", async () => {
  const { app } = mockApp();
  const started = await startFocusSession(app, { title: "Write", routineId: "routine-writing" }, new Date("2026-09-06T01:00:00Z"));
  await pauseFocusSession(app, new Date("2026-09-06T01:20:00Z"));
  let restored = await loadActivityState(app);
  assert.equal(restored.focusSessions[0].status, "paused");
  assert.equal(elapsedMilliseconds(restored.focusSessions[0], Date.parse("2026-09-06T02:00:00Z")), 20 * 60000);
  await resumeFocusSession(app, new Date("2026-09-06T01:30:00Z"));
  const completed = await finishFocusSession(app, "Drafted discussion", new Date("2026-09-06T02:00:00Z"));
  assert.equal(completed?.durationMinutes, 50);
  assert.equal(completed?.dailyNoteWritten, false);
  await markFocusSessionDailyNoteWritten(app, started.id);
  restored = await loadActivityState(app);
  assert.equal(restored.activeSessionId, null);
  assert.equal(restored.focusSessions.find(item => item.id === started.id)?.pausedDurationMs, 10 * 60000);
  assert.equal(restored.focusSessions.find(item => item.id === started.id)?.dailyNoteWritten, true);
});

test("only one active focus session exists and discard does not count as work", async () => {
  const { app } = mockApp();
  await startFocusSession(app, { title: "One" }, new Date("2026-09-06T01:00:00Z"));
  await assert.rejects(() => startFocusSession(app, { title: "Two" }), /already active/);
  await cancelFocusSession(app, new Date("2026-09-06T01:10:00Z"));
  const state = await loadActivityState(app);
  assert.equal(getTodayFocusMinutes(state, "2026-09-06"), 0);
});

test("duration routine combines manual logs and linked sessions exactly once", async () => {
  const { app } = mockApp();
  await logRoutine(app, "routine-writing", 15, "Outline", "2026-09-06");
  await startFocusSession(app, { title: "Write", routineId: "routine-writing", projectId: "Paper" }, new Date("2026-09-06T01:00:00Z"));
  await finishFocusSession(app, "", new Date("2026-09-06T01:45:00Z"));
  const state = await loadActivityState(app); const routine = state.routines.find(item => item.id === "routine-writing")!;
  assert.equal(getRoutineProgress(state, routine, "2026-09-06"), 60);
  assert.equal(getTodayFocusMinutes(state, "2026-09-06"), 45);
  assert.equal(getWeeklyFocusMinutes(state, "2026-09-06"), 45);
  assert.equal(getSessionCount(state, "week", "2026-09-06"), 1);
});

test("routine progress can be reduced without rewriting completed focus history", async () => {
  const { app } = mockApp();
  await startFocusSession(app, { title: "Write", routineId: "routine-writing" }, new Date("2026-09-06T01:00:00Z"));
  await finishFocusSession(app, "", new Date("2026-09-06T02:00:00Z"));
  await adjustRoutineProgress(app, "routine-writing", -15, "Correct accidental overrun", "2026-09-06");
  let state = await loadActivityState(app); const routine = state.routines.find(item => item.id === "routine-writing")!;
  assert.equal(getRoutineProgress(state, routine, "2026-09-06"), 45);
  assert.equal(state.focusSessions[0].durationMinutes, 60);
  await adjustRoutineProgress(app, "routine-writing", -100, "Clamp display", "2026-09-06");
  state = await loadActivityState(app);
  assert.equal(getRoutineProgress(state, routine, "2026-09-06"), 0);
});

test("routine service edits content while preserving stable identity and logs", async () => {
  const { app } = mockApp();
  await logRoutine(app, "routine-writing", 30, "Draft", "2026-09-06");
  const updated = await updateRoutine(app, "routine-writing", { name: "Paper drafting", cadence: "weekly", target: 180, unit: "min", projectId: "Catalog" });
  assert.equal(updated.id, "routine-writing");
  assert.equal(updated.name, "Paper drafting");
  assert.equal(updated.cadence, "weekly");
  const state = await loadActivityState(app);
  assert.equal(state.routineLogs[0].routineId, "routine-writing");
  await assert.rejects(() => updateRoutine(app, "routine-writing", { target: 0 }), /positive/);
});

test("only Read entries count and a focus session cannot create duplicate reading history", async () => {
  const { app } = mockApp();
  await logReading(app, { title: "A", level: "skim", date: "2026-09-01", focusSessionId: "focus-1" });
  await logReading(app, { title: "B", level: "read", date: "2026-09-02", focusSessionId: "focus-2" });
  await assert.rejects(() => logReading(app, { title: "B again", level: "read", focusSessionId: "focus-2" }), /already has/);
  assert.equal(getWeeklyReadingCount(await loadActivityState(app), "2026-09-06"), 1);
});

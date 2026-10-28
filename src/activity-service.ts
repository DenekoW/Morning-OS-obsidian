import type { App } from "obsidian";
import type { ActivityState, FocusSession, FocusSessionType, ReadingEntry, Routine, RoutineLog } from "./types";
import { todayStr } from "./utils";

export const ACTIVITY_STATE_PATH = "_generated/activity-state.json";

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultActivityState(): ActivityState {
  return {
    schemaVersion: 1,
    routines: [
      { id: "routine-writing", name: "Catalog Paper Writing", cadence: "daily", metric: "duration", target: 60, unit: "min", enabled: true },
      { id: "routine-reading", name: "Paper Reading", cadence: "weekly", metric: "count", target: 5, unit: "papers", enabled: true },
    ],
    routineLogs: [], focusSessions: [], readingEntries: [], activeSessionId: null,
  };
}

export async function loadActivityState(app: App): Promise<ActivityState> {
  const fallback = defaultActivityState();
  if (!(await app.vault.adapter.exists(ACTIVITY_STATE_PATH))) return fallback;
  try {
    const raw = JSON.parse(await app.vault.adapter.read(ACTIVITY_STATE_PATH)) as Partial<ActivityState>;
    const state: ActivityState = {
      ...fallback, ...raw, schemaVersion: 1,
      routines: Array.isArray(raw.routines) ? raw.routines : fallback.routines,
      routineLogs: Array.isArray(raw.routineLogs) ? raw.routineLogs : [],
      focusSessions: Array.isArray(raw.focusSessions) ? raw.focusSessions : [],
      readingEntries: Array.isArray(raw.readingEntries) ? raw.readingEntries : [],
      activeSessionId: typeof raw.activeSessionId === "string" ? raw.activeSessionId : null,
    };
    if (!state.focusSessions.some(session => session.id === state.activeSessionId && ["active", "paused"].includes(session.status))) state.activeSessionId = null;
    return state;
  } catch { return fallback; }
}

export async function saveActivityState(app: App, state: ActivityState): Promise<void> {
  if (!(await app.vault.adapter.exists("_generated"))) await app.vault.adapter.mkdir("_generated");
  await app.vault.adapter.write(ACTIVITY_STATE_PATH, JSON.stringify(state, null, 2));
}

export function elapsedMilliseconds(session: FocusSession, now = Date.now()): number {
  const end = session.pausedAt ? Date.parse(session.pausedAt) : session.endedAt ? Date.parse(session.endedAt) : now;
  return Math.max(0, end - Date.parse(session.startedAt) - (session.pausedDurationMs || 0));
}

export async function startFocusSession(app: App, input: { title: string; taskId?: string; projectId?: string; routineId?: string; type?: FocusSessionType }, now = new Date()): Promise<FocusSession> {
  const state = await loadActivityState(app);
  if (state.activeSessionId) throw new Error("A focus session is already active");
  const session: FocusSession = { id: id("focus"), title: input.title.trim() || "Focus session", startedAt: now.toISOString(), pausedDurationMs: 0, status: "active", type: input.type ?? "other", taskId: input.taskId, projectId: input.projectId, routineId: input.routineId };
  state.focusSessions.push(session); state.activeSessionId = session.id;
  await saveActivityState(app, state); return session;
}

export async function pauseFocusSession(app: App, now = new Date()): Promise<void> {
  const state = await loadActivityState(app); const session = state.focusSessions.find(item => item.id === state.activeSessionId);
  if (!session || session.status !== "active") return;
  session.status = "paused"; session.pausedAt = now.toISOString(); await saveActivityState(app, state);
}

export async function resumeFocusSession(app: App, now = new Date()): Promise<void> {
  const state = await loadActivityState(app); const session = state.focusSessions.find(item => item.id === state.activeSessionId);
  if (!session || session.status !== "paused" || !session.pausedAt) return;
  session.pausedDurationMs += Math.max(0, now.getTime() - Date.parse(session.pausedAt));
  delete session.pausedAt; session.status = "active"; await saveActivityState(app, state);
}

export async function finishFocusSession(app: App, note = "", now = new Date()): Promise<FocusSession | null> {
  const state = await loadActivityState(app); const session = state.focusSessions.find(item => item.id === state.activeSessionId);
  if (!session) return null;
  const durationMs = elapsedMilliseconds(session, now.getTime());
  session.endedAt = now.toISOString(); delete session.pausedAt; session.status = "completed";
  session.durationMinutes = Math.max(1, Math.round(durationMs / 60000)); session.note = note.trim() || undefined; session.dailyNoteWritten = false;
  state.activeSessionId = null; await saveActivityState(app, state); return session;
}

export async function markFocusSessionDailyNoteWritten(app: App, sessionId: string): Promise<void> {
  const state = await loadActivityState(app); const session = state.focusSessions.find(item => item.id === sessionId);
  if (!session) return; session.dailyNoteWritten = true; await saveActivityState(app, state);
}

export async function cancelFocusSession(app: App, now = new Date()): Promise<void> {
  const state = await loadActivityState(app); const session = state.focusSessions.find(item => item.id === state.activeSessionId);
  if (!session) return;
  session.endedAt = now.toISOString(); delete session.pausedAt; session.status = "cancelled"; state.activeSessionId = null; await saveActivityState(app, state);
}

export async function logRoutine(app: App, routineId: string, value: number, note = "", date = todayStr()): Promise<RoutineLog> {
  if (!Number.isFinite(value) || value <= 0) throw new Error("Routine value must be positive");
  const state = await loadActivityState(app);
  if (!state.routines.some(routine => routine.id === routineId)) throw new Error("Routine not found");
  const log: RoutineLog = { id: id("routine-log"), routineId, date, value, note: note.trim() || undefined, createdAt: new Date().toISOString() };
  state.routineLogs.push(log); await saveActivityState(app, state); return log;
}

/** Records an auditable correction without rewriting FocusSession history. */
export async function adjustRoutineProgress(app: App, routineId: string, delta: number, note = "", date = todayStr()): Promise<RoutineLog> {
  if (!Number.isFinite(delta) || delta === 0) throw new Error("Routine adjustment must be non-zero");
  const state = await loadActivityState(app);
  if (!state.routines.some(routine => routine.id === routineId)) throw new Error("Routine not found");
  const log: RoutineLog = { id: id("routine-adjustment"), routineId, date, value: delta, note: note.trim() || "Progress correction", createdAt: new Date().toISOString() };
  state.routineLogs.push(log); await saveActivityState(app, state); return log;
}

export async function logReading(app: App, input: Omit<ReadingEntry, "id" | "date"> & { date?: string }): Promise<ReadingEntry> {
  if (!input.title.trim()) throw new Error("Paper title or identifier is required");
  const state = await loadActivityState(app);
  if (input.focusSessionId && state.readingEntries.some(entry => entry.focusSessionId === input.focusSessionId)) throw new Error("This focus session already has a reading entry");
  const entry: ReadingEntry = { ...input, id: id("reading"), title: input.title.trim(), date: input.date ?? todayStr() };
  state.readingEntries.push(entry); await saveActivityState(app, state); return entry;
}

export async function createRoutine(app: App, routine: Omit<Routine, "id" | "enabled">): Promise<Routine> {
  if (!routine.name.trim()) throw new Error("Routine name is required");
  if (!Number.isFinite(routine.target) || routine.target <= 0) throw new Error("Target must be positive");
  const state = await loadActivityState(app);
  const created: Routine = { ...routine, id: id("routine"), name: routine.name.trim(), enabled: true };
  state.routines.push(created); await saveActivityState(app, state); return created;
}

export async function updateRoutine(app: App, routineId: string, patch: Partial<Omit<Routine, "id">>): Promise<Routine> {
  const state = await loadActivityState(app);
  const routine = state.routines.find(item => item.id === routineId);
  if (!routine) throw new Error("Routine not found");
  const next = { ...routine, ...patch, id: routine.id, name: patch.name?.trim() ?? routine.name };
  if (!next.name) throw new Error("Routine name is required");
  if (!Number.isFinite(next.target) || next.target <= 0) throw new Error("Target must be positive");
  Object.assign(routine, next);
  await saveActivityState(app, state); return routine;
}

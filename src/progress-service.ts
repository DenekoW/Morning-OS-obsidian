import type { App } from "obsidian";
import type { MorningOSSettings } from "./settings";
import type { ProgressEvent, Task } from "./types";
import { appendWorkLogEvent } from "./daily-note-service";
import { generateId, loadRegistry, saveRegistry } from "./task-registry";
import { dateStrFromTimestamp, todayStr } from "./utils";

const EVENTS_PATH = "_generated/progress-events.json";

export async function loadProgressEvents(app: App): Promise<ProgressEvent[]> {
  if (!(await app.vault.adapter.exists(EVENTS_PATH))) return [];
  try { const parsed = JSON.parse(await app.vault.adapter.read(EVENTS_PATH)) as unknown; return Array.isArray(parsed) ? parsed as ProgressEvent[] : []; }
  catch { return []; }
}

async function saveProgressEvents(app: App, events: ProgressEvent[]): Promise<void> {
  if (!(await app.vault.adapter.exists("_generated"))) await app.vault.adapter.mkdir("_generated");
  await app.vault.adapter.write(EVENTS_PATH, JSON.stringify(events, null, 2));
}

function eventDetails(task: Task, event: ProgressEvent): string[] {
  const unit = task.progress?.unit ? ` ${task.progress.unit}` : "";
  return [
    ...(event.focusMinutes ? [`Focus: ${event.focusMinutes < 60 ? `${event.focusMinutes}m` : `${Math.floor(event.focusMinutes / 60)}h${event.focusMinutes % 60 ? ` ${event.focusMinutes % 60}m` : ""}`}`] : []),
    `Progress: ${event.delta >= 0 ? "+" : ""}${event.delta}${unit} → ${event.newValue} / ${task.progress?.target ?? event.newValue}${unit}`,
  ];
}

async function writeEvent(app: App, settings: MorningOSSettings, task: Task, event: ProgressEvent): Promise<void> {
  await appendWorkLogEvent(app, settings, { id: event.id, date: dateStrFromTimestamp(event.timestamp), timestamp: event.timestamp, title: task.text, details: eventDetails(task, event), note: event.note });
}

export async function logTaskProgress(app: App, settings: MorningOSSettings, taskId: string, input: { mode: "add" | "set"; value: number; note?: string; focusSessionId?: string; focusMinutes?: number; timestamp?: string; eventId?: string }): Promise<ProgressEvent> {
  if (!Number.isFinite(input.value) || input.value < 0) throw new Error("Progress value must be zero or greater");
  const registry = await loadRegistry(app); const task = registry.find(item => item._id === taskId);
  if (!task?.progress) throw new Error("Task does not support progress");
  const events = await loadProgressEvents(app); const eventId = input.eventId ?? `progress-${generateId()}`;
  const existing = events.find(event => event.id === eventId);
  if (existing) return existing;
  const previousValue = task.progress.current;
  const requested = input.mode === "add" ? previousValue + input.value : input.value;
  const newValue = Math.min(task.progress.target, Math.max(0, Math.round(requested)));
  const timestamp = input.timestamp ?? new Date().toISOString();
  const event: ProgressEvent = { id: eventId, taskId, timestamp, previousValue, newValue, delta: newValue - previousValue, note: input.note?.trim() || undefined, focusSessionId: input.focusSessionId, focusMinutes: input.focusMinutes, dailyNoteWritten: false };
  if (event.delta === 0 && !event.note) throw new Error("Progress did not change");
  events.push(event); await saveProgressEvents(app, events);
  task.progress.current = newValue; await saveRegistry(app, registry);
  try { await writeEvent(app, settings, task, event); event.dailyNoteWritten = true; await saveProgressEvents(app, events); }
  catch (error) { console.error("Morning OS Daily Note progress log pending", error); }
  return event;
}

export async function setTaskDailyProgressTarget(app: App, taskId: string, target: number, date = todayStr()): Promise<void> {
  const registry = await loadRegistry(app); const task = registry.find(item => item._id === taskId);
  if (!task?.progress) throw new Error("Task does not support progress");
  if (!Number.isFinite(target) || target <= 0) task.daily_progress_target = null;
  else task.daily_progress_target = { date, target: Math.round(target), startingValue: task.progress.current };
  await saveRegistry(app, registry);
}

export function getTaskProgressToday(task: Task, date = todayStr()): number {
  const daily = task.daily_progress_target;
  if (!task.progress || !daily || daily.date !== date) return 0;
  return Math.max(0, task.progress.current - daily.startingValue);
}

export async function syncPendingProgressEvents(app: App, settings: MorningOSSettings): Promise<number> {
  const events = await loadProgressEvents(app); const pending = events.filter(event => !event.dailyNoteWritten);
  if (!pending.length) return 0;
  const registry = await loadRegistry(app); let count = 0;
  for (const event of pending) {
    const task = registry.find(item => item._id === event.taskId);
    if (!task?.progress) continue;
    if (task.progress.current === event.previousValue) task.progress.current = event.newValue;
    await writeEvent(app, settings, task, event); event.dailyNoteWritten = true; count++;
  }
  await saveRegistry(app, registry); await saveProgressEvents(app, events); return count;
}

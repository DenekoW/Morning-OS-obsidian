import type { App } from "obsidian";
import type { MorningOSSettings } from "./settings";
import type { Task } from "./types";
import { appendWorkLogEvent } from "./daily-note-service";
import { loadProjectStates, setProjectNextAction } from "./project-state";
import { loadRegistry, setTaskStatus, updateTask } from "./task-registry";
import { dateStrFromTimestamp } from "./utils";

export interface TaskCompletionResult {
  task: Task;
  dailyNoteWritten: boolean;
}

export async function completeTaskWithNote(
  app: App,
  settings: MorningOSSettings,
  taskId: string,
  note = "",
  completedAt = new Date(),
): Promise<TaskCompletionResult> {
  const task = (await loadRegistry(app)).find(item => item._id === taskId && !item.is_deleted);
  if (!task) throw new Error("Task not found");
  if (task.progress && task.progress.current < task.progress.target) {
    throw new Error(`Overall progress must reach ${task.progress.target} ${task.progress.unit ?? ""} before completion.`);
  }

  const cleanNote = note.trim();
  if (cleanNote) {
    const existing = task.notes?.trim() ?? "";
    if (!existing.split(/\n\n+/).includes(cleanNote)) {
      await updateTask(app, taskId, { notes: existing ? `${existing}\n\n${cleanNote}` : cleanNote });
    }
  }
  await setTaskStatus(app, taskId, "done");
  if (task.project.trim()) {
    const project = (await loadProjectStates(app)).find(item => item.name === task.project);
    if (project?.next_action_task_id === taskId || (!project?.next_action_task_id && project?.next_action.trim() === task.text.trim())) {
      await setProjectNextAction(app, task.project, "", null);
    }
  }

  const timestamp = completedAt.toISOString();
  const date = dateStrFromTimestamp(completedAt);
  let dailyNoteWritten = false;
  try {
    await appendWorkLogEvent(app, settings, {
      id: `task-completed-${taskId}-${date}`,
      date,
      timestamp,
      title: task.text,
      details: ["Task completed"],
      note: cleanNote || undefined,
    });
    dailyNoteWritten = true;
  } catch (error) {
    console.error("Morning OS task completion Daily Note log failed", error);
  }
  const completed = (await loadRegistry(app)).find(item => item._id === taskId) ?? task;
  return { task: completed, dailyNoteWritten };
}

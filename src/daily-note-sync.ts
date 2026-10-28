import type { App } from "obsidian";
import type { MorningOSSettings } from "./settings";
import type { TaskRegistry } from "./types";
import { todayStr } from "./utils";

const START = "<!-- morning-os:tasks:start -->";
const END = "<!-- morning-os:tasks:end -->";
let settings: MorningOSSettings | null = null;

export function configureDailyTaskSync(next: MorningOSSettings): void { settings = next; }

export async function resolveDailyTaskNotePath(app: App): Promise<string> {
  let directory = settings?.dailyNoteDir ?? "";
  try {
    if (await app.vault.adapter.exists(".obsidian/daily-notes.json")) {
      const core = JSON.parse(await app.vault.adapter.read(".obsidian/daily-notes.json")) as { folder?: string };
      if (core.folder?.trim()) directory = core.folder.trim().replace(/^\/+|\/+$/g, "");
    }
  } catch { /* configured fallback */ }
  return directory ? `${directory}/${todayStr()}.md` : `${todayStr()}.md`;
}

function taskLine(task: TaskRegistry[number]): string {
  const checked = task.status_completion === "done" ? "x" : " ";
  const details = [task.project ? `Project: ${task.project}` : "", task.effort_minutes !== null ? `~${task.effort_minutes}m` : "", task.progress ? `${task.progress.current}/${task.progress.target}${task.progress.unit ? ` ${task.progress.unit}` : ""}` : ""].filter(Boolean);
  return `- [${checked}] ${task.text.replace(/\r?\n/g, " ").trim()}${details.length ? ` — ${details.join(" · ")}` : ""}`;
}

export function upsertDailyTaskBlock(markdown: string, tasks: TaskRegistry): string {
  const heading = settings?.dailyTaskHeading || "Morning OS Tasks";
  const body = tasks.length ? tasks.map(taskLine).join("\n") : "_今天尚未安排 Morning OS 任务。_";
  const block = `${START}\n> 由 Morning OS 自动同步；请在 Morning OS 中修改任务。\n\n${body}\n${END}`;
  const start = markdown.indexOf(START);
  const end = markdown.indexOf(END, start);
  if (start !== -1 && end !== -1) return markdown.slice(0, start) + block + markdown.slice(end + END.length);
  return `${markdown.trimEnd()}${markdown.trimEnd() ? "\n\n" : ""}## ${heading}\n\n${block}\n`;
}

export async function syncTasksToDailyNote(app: App, tasks: TaskRegistry): Promise<boolean> {
  if (!settings || settings.syncTasksToDailyNote === false) return false;
  const path = await resolveDailyTaskNotePath(app);
  if (!(await app.vault.adapter.exists(path))) return false;
  const today = todayStr();
  const visible = tasks.filter(task => !task.is_deleted && (task.planned_date === today || task.date_completed === today));
  const current = await app.vault.adapter.read(path);
  const updated = upsertDailyTaskBlock(current, visible);
  if (updated !== current) await app.vault.adapter.write(path, updated);
  return true;
}

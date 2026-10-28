import type { App } from "obsidian";
import type { MorningOSSettings } from "./settings";
import type { Task, WorkLogEvent } from "./types";

async function ensureDirectory(app: App, directory: string): Promise<void> {
  let path = "";
  for (const part of directory.split("/").filter(Boolean)) {
    path = path ? `${path}/${part}` : part;
    if (!(await app.vault.adapter.exists(path))) await app.vault.adapter.mkdir(path);
  }
}

export async function resolveDailyNotePath(app: App, settings: MorningOSSettings, date: string): Promise<string> {
  let directory = settings.dailyNoteDir.trim().replace(/^\/+|\/+$/g, "");
  try {
    if (await app.vault.adapter.exists(".obsidian/daily-notes.json")) {
      const config = JSON.parse(await app.vault.adapter.read(".obsidian/daily-notes.json")) as { folder?: string };
      if (config.folder?.trim()) directory = config.folder.trim().replace(/^\/+|\/+$/g, "");
    }
  } catch { /* configured directory is the fallback */ }
  return directory ? `${directory}/${date}.md` : `${date}.md`;
}

async function readOrCreate(app: App, settings: MorningOSSettings, date: string): Promise<{ path: string; markdown: string }> {
  const path = await resolveDailyNotePath(app, settings, date);
  const directory = path.split("/").slice(0, -1).join("/");
  if (directory) await ensureDirectory(app, directory);
  if (!(await app.vault.adapter.exists(path))) await app.vault.adapter.write(path, "");
  return { path, markdown: await app.vault.adapter.read(path) };
}

function appendToSection(markdown: string, heading: string, block: string): string {
  const lines = markdown.split(/\r?\n/);
  const headingLine = `## ${heading}`;
  const index = lines.findIndex(line => line.trim() === headingLine);
  if (index === -1) return `${markdown.trimEnd()}${markdown.trimEnd() ? "\n\n" : ""}${headingLine}\n\n${block}\n`;
  let insert = index + 1;
  while (insert < lines.length && !/^##\s+/.test(lines[insert])) insert++;
  const prefix = insert > index + 1 && lines[insert - 1].trim() ? [""] : [];
  lines.splice(insert, 0, ...prefix, block, "");
  return lines.join("\n");
}

function clean(value: string): string { return value.replace(/\r?\n/g, " ").trim(); }

export async function appendWorkLogEvent(app: App, settings: MorningOSSettings, event: WorkLogEvent): Promise<boolean> {
  if (!settings.syncTasksToDailyNote) return false;
  const { path, markdown } = await readOrCreate(app, settings, event.date);
  const marker = `<!-- morning-os:work-log:${event.id} -->`;
  if (markdown.includes(marker)) return false;
  const time = new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const body = [`- ${time} — **${clean(event.title)}**`, ...event.details.map(detail => `  - ${clean(detail)}`), ...(event.note?.trim() ? [`  - ${clean(event.note)}`] : []), `  ${marker}`].join("\n");
  await app.vault.adapter.write(path, appendToSection(markdown, settings.workLogHeading, body));
  return true;
}

export async function writeMorningPlanSnapshot(app: App, settings: MorningOSSettings, date: string, tasks: Task[], focus: Task[]): Promise<boolean> {
  if (!settings.syncTasksToDailyNote) return false;
  const { path, markdown } = await readOrCreate(app, settings, date);
  const marker = `<!-- morning-os:plan:${date} -->`;
  if (markdown.includes(marker)) return false;
  const focusLines = focus.length
    ? focus.map((task, index) => `${index + 1}. ${task.project.trim() ? `**${clean(task.project)}** — ` : ""}${clean(task.text)}`)
    : ["_No focus queue selected._"];
  const lines = [marker, "### Focus", ...focusLines, "", "### Tasks"];
  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    const project = task.project.trim() || "No Project";
    groups.set(project, [...(groups.get(project) ?? []), task]);
  }
  const orderedGroups = [...groups.entries()].sort(([left], [right]) => {
    if (left === "No Project") return 1;
    if (right === "No Project") return -1;
    return left.localeCompare(right);
  });
  if (!orderedGroups.length) lines.push("_No tasks selected._");
  for (const [project, projectTasks] of orderedGroups) {
    lines.push("", `#### ${clean(project)}`);
    for (const task of projectTasks) {
      lines.push(`- [ ] ${clean(task.text)}`);
      if (task.progress) {
        const daily = task.daily_progress_target?.date === date ? task.daily_progress_target : null;
        if (daily) lines.push(`  - Today: +${daily.target} ${task.progress.unit ?? ""}`.trimEnd());
        lines.push(`  - Starting progress: ${task.progress.current} / ${task.progress.target}${task.progress.unit ? ` ${task.progress.unit}` : ""}`);
      }
    }
  }
  await app.vault.adapter.write(path, appendToSection(markdown, settings.dailyPlanHeading, lines.join("\n")));
  return true;
}

export async function writeShutdownSnapshot(app: App, settings: MorningOSSettings, date: string, thoughts: string, tomorrowTask?: string): Promise<boolean> {
  if (!settings.syncTasksToDailyNote) return false;
  const { path, markdown } = await readOrCreate(app, settings, date);
  const marker = `<!-- morning-os:shutdown:${date} -->`;
  if (markdown.includes(marker)) return false;
  const lines = [marker, ...(thoughts.trim() ? [`- Still on my mind: ${clean(thoughts)}`] : []), ...(tomorrowTask ? [`- Tomorrow first: ${clean(tomorrowTask)}`] : [])];
  await app.vault.adapter.write(path, appendToSection(markdown, settings.shutdownHeading, lines.join("\n")));
  return true;
}

export async function writeDailyTargetChangeEvent(app: App, settings: MorningOSSettings, task: Task, previousTarget: number, newTarget: number, date: string): Promise<boolean> {
  const unit = task.progress?.unit ? ` ${task.progress.unit}` : "";
  return appendWorkLogEvent(app, settings, { id: `daily-target-${task._id}-${date}-${previousTarget}-${newTarget}`, date, timestamp: new Date().toISOString(), title: task.text, details: [`Daily target changed: +${previousTarget}${unit} → +${newTarget}${unit}`] });
}

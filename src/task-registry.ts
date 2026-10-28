import { App } from "obsidian";
import type { AreaConfig, TabConfig, Task, TaskRegistry, CompletionStatus, PipelineStage } from "./types";
import { PIPELINE_STAGES } from "./types";
import { writeHistorySnapshot } from "./agent/history";
import { todayStr } from "./utils";
import { syncTasksToDailyNote } from "./daily-note-sync";

const REGISTRY_PATH = "00-MOC/Morning OS Tasks.md";
const LEGACY_REGISTRY_PATH = "_generated/tasks.json";
const AREAS_RECOVERY_BACKUP_PATH = "_generated/backups/tasks-before-areas-recovery.json";

export interface AreasRecoveryResult {
  changed: boolean;
  settingsChanged: boolean;
  tasksRecovered: number;
  legacyTasksMigrated: number;
  areasCreated: number;
  tabsCreated: number;
  backupCreated: boolean;
  error?: string;
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export async function loadRegistry(app: App): Promise<TaskRegistry> {
  let tasks: TaskRegistry = [];
  if (await app.vault.adapter.exists(REGISTRY_PATH)) {
    tasks = parseTaskMarkdown(await app.vault.adapter.read(REGISTRY_PATH));
  } else if (await app.vault.adapter.exists(LEGACY_REGISTRY_PATH)) {
    const raw = JSON.parse(await app.vault.adapter.read(LEGACY_REGISTRY_PATH)) as Record<string, unknown>[];
    tasks = raw.map(migrateTask);
    await saveRegistry(app, tasks);
  }
  await syncTasksToDailyNote(app, tasks);
  return tasks;
}

/**
 * Repairs persisted task area metadata before normal registry reads can discard
 * legacy fields. This is intentionally safe to call on every plugin launch:
 * completed records already have `areas`, settings entries are de-duplicated,
 * and no files are written when there is nothing left to repair.
 */
export async function recoverRegistryAreas(app: App, configuredAreas: AreaConfig[]): Promise<AreasRecoveryResult> {
  const result: AreasRecoveryResult = {
    changed: false,
    settingsChanged: false,
    tasksRecovered: 0,
    legacyTasksMigrated: 0,
    areasCreated: 0,
    tabsCreated: 0,
    backupCreated: false,
  };

  // The Markdown registry is authoritative once present. A retained legacy JSON
  // file is a migration backup and must never overwrite or reshape live state.
  if (await app.vault.adapter.exists(REGISTRY_PATH)) return result;
  if (!(await app.vault.adapter.exists(LEGACY_REGISTRY_PATH))) return result;

  let raw: string;
  let tasks: Record<string, unknown>[];
  try {
    raw = await app.vault.adapter.read(LEGACY_REGISTRY_PATH);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
      throw new Error("registry is not an array of task records");
    }
    tasks = parsed;
  } catch (err) {
    return { ...result, error: `Could not read ${LEGACY_REGISTRY_PATH}: ${(err as Error).message}` };
  }

  const recoveredAreaConfigs = JSON.parse(JSON.stringify(configuredAreas)) as AreaConfig[];

  // Only configured area keys can be inferred from tags alone. Tags also hold
  // arbitrary custom fields, so treating every tag key as an area would corrupt
  // the user's settings (for example, "status" or "company").
  const inferableAreaKeys = new Set(recoveredAreaConfigs.map(area => area.key));

  for (const task of tasks) {
    const currentAreas = readStringArray(task.areas);
    const legacyAreas = readStringArray(task.pillars);
    const tags = readStringRecord(task.tags);
    let recoveredAreas = currentAreas;

    if (currentAreas.length === 0 && legacyAreas.length > 0) {
      recoveredAreas = legacyAreas;
      task.areas = recoveredAreas;
      result.changed = true;
      result.tasksRecovered++;
      result.legacyTasksMigrated++;
    } else if (currentAreas.length === 0) {
      const inferredAreas = Object.keys(tags).filter(key => inferableAreaKeys.has(key));
      if (inferredAreas.length > 0) {
        recoveredAreas = inferredAreas;
        task.areas = recoveredAreas;
        result.changed = true;
        result.tasksRecovered++;
      }
    }

    // A valid `areas` value wins over legacy data, but the old field must not
    // survive a rewrite because normal runtime code only understands `areas`.
    if (Object.prototype.hasOwnProperty.call(task, "pillars")) {
      delete task.pillars;
      result.changed = true;
    }

    for (const areaKey of recoveredAreas) {
      // An existing `areas` value or a legacy `pillars` value is authoritative.
      // Once seen, it may also safely establish this key for later tag recovery.
      inferableAreaKeys.add(areaKey);
      const area = ensureArea(recoveredAreaConfigs, areaKey);
      if (area.created) {
        result.settingsChanged = true;
        result.areasCreated++;
      }

      const tabKey = tags[areaKey];
      if (tabKey && ensureTab(area.area, tabKey)) {
        result.settingsChanged = true;
        result.tabsCreated++;
      }
    }
  }

  if (!result.changed) {
    if (result.settingsChanged) replaceAreaConfigs(configuredAreas, recoveredAreaConfigs);
    return result;
  }

  try {
    if (!(await app.vault.adapter.exists("_generated/backups"))) {
      await app.vault.adapter.mkdir("_generated/backups");
    }
    if (!(await app.vault.adapter.exists(AREAS_RECOVERY_BACKUP_PATH))) {
      await app.vault.adapter.write(AREAS_RECOVERY_BACKUP_PATH, raw);
      result.backupCreated = true;
    }
    await app.vault.adapter.write(LEGACY_REGISTRY_PATH, JSON.stringify(tasks, null, 2));
    if (result.settingsChanged) replaceAreaConfigs(configuredAreas, recoveredAreaConfigs);
    return result;
  } catch (err) {
    return { ...result, settingsChanged: false, error: `Could not write area recovery: ${(err as Error).message}` };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))];
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
  );
}

function readTaskProgress(value: unknown): Task["progress"] {
  if (!isRecord(value) || value.type !== "count") return null;
  const current = Number(value.current); const target = Number(value.target);
  if (!Number.isFinite(current) || !Number.isFinite(target) || target <= 0) return null;
  return { type: "count", current: Math.max(0, Math.round(current)), target: Math.round(target), unit: typeof value.unit === "string" && value.unit.trim() ? value.unit.trim() : undefined };
}

function readDailyProgressTarget(value: unknown): Task["daily_progress_target"] {
  if (!isRecord(value) || typeof value.date !== "string") return null;
  const target = Number(value.target); const startingValue = Number(value.startingValue);
  if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(startingValue)) return null;
  return { date: value.date, target: Math.round(target), startingValue: Math.max(0, Math.round(startingValue)) };
}

function readPipelineStage(value: unknown): PipelineStage | null {
  return PIPELINE_STAGES.includes(value as PipelineStage) ? (value as PipelineStage) : null;
}

function ensureArea(areas: AreaConfig[], key: string): { area: AreaConfig; created: boolean } {
  const existing = areas.find(area => area.key === key);
  if (existing) return { area: existing, created: false };

  const area: AreaConfig = {
    key,
    label: labelFromKey(key),
    icon: "",
    feedToLLM: false,
    tabs: [],
  };
  areas.push(area);
  return { area, created: true };
}

function ensureTab(area: AreaConfig, key: string): boolean {
  if (area.tabs.some(tab => tab.key === key)) return false;
  const tab: TabConfig = {
    key,
    label: labelFromKey(key),
    fields: [],
    view_mode: "cards",
  };
  area.tabs.push(tab);
  return true;
}

function labelFromKey(key: string): string {
  return key
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || key;
}

function replaceAreaConfigs(target: AreaConfig[], source: AreaConfig[]): void {
  target.splice(0, target.length, ...source);
}

export function migrateTask(t: Record<string, unknown>): Task {
  const plannedDate = typeof t.planned_date === "string" && t.planned_date
    ? t.planned_date
    : t.is_today === true || t.in_today === true
      ? todayStr()
      : null;
  const effort = typeof t.effort_minutes === "number" && Number.isFinite(t.effort_minutes) && t.effort_minutes >= 0
    ? Math.round(t.effort_minutes)
    : null;
  const execution = ["ready", "waiting", "blocked"].includes(String(t.execution_state))
    ? t.execution_state as Task["execution_state"]
    : "ready";
  const focusOrder = Number.isInteger(t.focus_order) && Number(t.focus_order) > 0
    ? Number(t.focus_order)
    : null;
  return {
    _id:               (t._id ?? t.id ?? generateId()) as string,
    text:              (t.text ?? "") as string,
    notes:             (t.notes ?? "") as string,
    areas:           (t.areas ?? []) as string[],
    tags:              (t.tags ?? {}) as Record<string, string>,
    status_completion: migrateCompletion(t),
    status_priority:   (t.status_priority ?? t.priority ?? "regular") as "red" | "regular",
    status_urgency:    (t.status_urgency ?? t.urgency ?? "none") as Task["status_urgency"],
    is_today:          plannedDate === todayStr(),
    is_deleted:        (t.is_deleted ?? t.deleted ?? false) as boolean,
    parent_id:         (t.parent_id ?? null) as string | null,
    project:           typeof t.project === "string" ? t.project : "",
    eisenhower_priority: typeof t.eisenhower_priority === "string" ? t.eisenhower_priority as Task["eisenhower_priority"] : "",
    planned_date:      plannedDate,
    effort_minutes:    effort,
    context:           typeof t.context === "string" ? t.context : "",
    execution_state:   execution,
    focus_order:       plannedDate === todayStr() && execution === "ready" ? focusOrder : null,
    routine_id:        typeof t.routine_id === "string" ? t.routine_id : null,
    progress:          readTaskProgress(t.progress),
    daily_progress_target: readDailyProgressTarget(t.daily_progress_target),
    pipeline_stage:    migrateCompletion(t) === "done" ? "complete" : readPipelineStage(t.pipeline_stage),
    date_created:      (t.date_created ?? t.created ?? todayStr()) as string,
    date_modified:     (t.date_modified ?? t.modified ?? todayStr()) as string,
    date_completed:    (t.date_completed ?? t.completed ?? null) as string | null,
    date_remind:       (t.date_remind ?? t.remind_date ?? null) as string | null,
  };
}

function migrateCompletion(t: Record<string, unknown>): CompletionStatus {
  if (t.status_completion) return t.status_completion as CompletionStatus;
  if (t.done === true) return "done";
  return "open";
}

export function normalizeRegistry(registry: TaskRegistry): TaskRegistry {
  const normalized = registry.map(task => migrateTask(task as unknown as Record<string, unknown>));
  const focus = normalized
    .filter(task => task.focus_order !== null)
    .sort((left, right) => (left.focus_order ?? 999) - (right.focus_order ?? 999))
    .slice(0, 3);
  for (const task of normalized) task.focus_order = null;
  focus.forEach((task, index) => { task.focus_order = index + 1; });
  return normalized;
}

export function parseTaskMarkdown(markdown: string): TaskRegistry {
  const lines = markdown.split(/\r?\n/);
  const tasks: TaskRegistry = [];
  let currentProject: string | null = null;
  let inDeletedSection = false;
  for (let index = 0; index < lines.length; index++) {
    const projectHeading = lines[index].match(/^## Project:\s*(.*)$/);
    if (projectHeading) {
      currentProject = projectHeading[1].trim() === "未归属项目" ? "" : projectHeading[1].trim();
      inDeletedSection = false;
      continue;
    }
    if (/^## Deleted\s*$/.test(lines[index])) {
      currentProject = null;
      inDeletedSection = true;
      continue;
    }
    const checkbox = lines[index].match(/^\s*-\s+\[([ xX])\]\s+(.*)$/);
    if (!checkbox) continue;
    let metadata: Record<string, unknown> = {};
    const comment = lines[index + 1]?.match(/^\s*<!--\s*morning-os\s+(\{.*\})\s*-->\s*$/);
    if (comment) {
      try { metadata = JSON.parse(comment[1]) as Record<string, unknown>; index++; } catch { /* legacy plain task */ }
    }
    const done = checkbox[1].toLowerCase() === "x";
    tasks.push(migrateTask({
      ...metadata,
      text: checkbox[2].trim(),
      project: inDeletedSection || currentProject === null ? metadata.project : currentProject,
      is_deleted: inDeletedSection || Boolean(metadata.is_deleted),
      status_completion: done ? "done" : "open",
      date_completed: done ? metadata.date_completed || todayStr() : null,
    }));
  }
  return normalizeRegistry(tasks);
}

function taskMarkdownEntry(task: Task): string {
  const checkbox = task.status_completion === "done" ? "x" : " ";
  const metadata = { ...task, text: undefined, is_today: undefined };
  const text = String(task.text || "").replace(/\r?\n/g, " ");
  return `- [${checkbox}] ${text}\n  <!-- morning-os ${JSON.stringify(metadata)} -->`;
}

export function serializeTaskMarkdown(registry: TaskRegistry): string {
  const normalized = normalizeRegistry(registry);
  const active = normalized.filter(task => !task.is_deleted);
  const deleted = normalized.filter(task => task.is_deleted);
  const projects = new Map<string, Task[]>();
  for (const task of active) {
    const project = task.project.trim() || "未归属项目";
    const tasks = projects.get(project) ?? [];
    tasks.push(task);
    projects.set(project, tasks);
  }
  const lines = [
    "---", "morning-os-task-registry: 2", "---", "", "# Morning OS Tasks", "",
    "> 此文件由 Morning OS 管理，可通过 Git 同步。任务正文和复选框可直接编辑；请保留每项下方的 morning-os 元数据注释。", "",
  ];
  for (const [project, tasks] of projects) {
    lines.push(`## Project: ${project.replace(/\r?\n/g, " ")}`, "", ...tasks.map(taskMarkdownEntry), "");
  }
  if (deleted.length) lines.push("## Deleted", "", ...deleted.map(taskMarkdownEntry), "");
  return lines.join("\n");
}

export async function saveRegistry(app: App, registry: TaskRegistry): Promise<void> {
  const normalized = normalizeRegistry(registry);
  const markdown = serializeTaskMarkdown(normalized);
  const folder = REGISTRY_PATH.split("/").slice(0, -1).join("/");
  if (folder && !(await app.vault.adapter.exists(folder))) await app.vault.adapter.mkdir(folder);
  const temporaryPath = `${REGISTRY_PATH}.tmp`;
  await app.vault.adapter.write(temporaryPath, markdown);
  const verified = parseTaskMarkdown(await app.vault.adapter.read(temporaryPath));
  const expectedIds = normalized.map(task => task._id).sort();
  const verifiedIds = verified.map(task => task._id).sort();
  if (verified.length !== normalized.length || JSON.stringify(expectedIds) !== JSON.stringify(verifiedIds)) {
    throw new Error("Task Markdown verification failed");
  }
  await app.vault.adapter.write(REGISTRY_PATH, markdown);
  // Record our own write so the vault watcher can skip it — only external
  // edits (mos-float widget, manual file edits, sync tools) should reload.
  lastSelfWrittenMarkdown = markdown;
  try { await app.vault.adapter.remove(temporaryPath); } catch { /* best effort */ }
  await syncTasksToDailyNote(app, normalized);
}

// External-edit coordination: the desktop float widget and manual file edits
// change the registry outside the plugin. saveRegistry records what it wrote
// so the file watcher only reloads on changes it did not make itself.
let lastSelfWrittenMarkdown: string | null = null;

export function isRegistrySelfWrite(content: string): boolean {
  return lastSelfWrittenMarkdown !== null && content === lastSelfWrittenMarkdown;
}

function parseTagsFromText(text: string): { cleanText: string; areas: string[]; tags: Record<string, string>; date_remind: string | null } {
  const areas: string[] = [];
  const tags: Record<string, string> = {};
  let date_remind: string | null = null;

  const areaMatches = text.matchAll(/#p\/([\w-]+)/g);
  for (const m of areaMatches) areas.push(m[1]);

  const subtabMatches = text.matchAll(/#t\/([\w-]+)/g);
  const subtabList: string[] = [];
  for (const m of subtabMatches) subtabList.push(m[1]);
  if (subtabList.length > 0 && areas.length > 0) {
    tags[areas[areas.length - 1]] = subtabList[0];
  }

  const remindMatch = text.match(/@remind\((\d{4}-\d{2}-\d{2})\)/);
  if (remindMatch) date_remind = remindMatch[1];

  const cleanText = text
    .replace(/#p\/[\w-]+/g, "")
    .replace(/#t\/[\w-]+/g, "")
    .replace(/@remind\([^)]*\)/g, "")
    .trim();

  return { cleanText, areas, tags, date_remind };
}

export function createTask(
  rawText: string,
  opts: Partial<Pick<Task, "status_priority" | "status_urgency" | "areas" | "tags" | "is_today" | "date_remind" | "parent_id" | "project" | "eisenhower_priority" | "planned_date" | "effort_minutes" | "context" | "execution_state" | "focus_order" | "routine_id" | "progress" | "daily_progress_target" | "pipeline_stage">> = {}
): Task {
  const today = todayStr();
  const parsed = parseTagsFromText(rawText);
  const plannedDate = opts.planned_date !== undefined ? opts.planned_date : opts.is_today ? today : null;
  return {
    _id: generateId(),
    text: parsed.cleanText,
    notes: "",
    areas: opts.areas !== undefined ? opts.areas : parsed.areas,
    tags: opts.tags !== undefined ? opts.tags : parsed.tags,
    status_completion: "open",
    status_priority: opts.status_priority ?? "regular",
    status_urgency: opts.status_urgency ?? "none",
    is_today: plannedDate === today,
    is_deleted: false,
    parent_id: opts.parent_id ?? null,
    project: opts.project ?? "",
    eisenhower_priority: opts.eisenhower_priority ?? "",
    planned_date: plannedDate,
    effort_minutes: opts.effort_minutes ?? null,
    context: opts.context ?? "",
    execution_state: opts.execution_state ?? "ready",
    focus_order: plannedDate === today && (opts.execution_state ?? "ready") === "ready" ? opts.focus_order ?? null : null,
    routine_id: opts.routine_id ?? null,
    progress: opts.progress ?? null,
    daily_progress_target: opts.daily_progress_target ?? null,
    pipeline_stage: opts.pipeline_stage ?? null,
    date_created: today,
    date_modified: today,
    date_completed: null,
    date_remind: opts.date_remind !== undefined ? opts.date_remind : parsed.date_remind,
  };
}

export type ProjectTaskDestination = "backlog" | "today";

export function createProjectTask(
  rawText: string,
  project: string,
  priority: Task["eisenhower_priority"],
  destination: ProjectTaskDestination = "backlog",
): Task {
  const cleanProject = project.trim();
  if (!rawText.trim()) throw new Error("Task text is required");
  if (!cleanProject) throw new Error("Project is required");
  return createTask(rawText, {
    project: cleanProject,
    eisenhower_priority: priority,
    status_priority: priority === "urgent_important" ? "red" : "regular",
    is_today: destination === "today",
  });
}

export function getChildren(registry: TaskRegistry, parentId: string): Task[] {
  return registry.filter(t => t.parent_id === parentId && !t.is_deleted);
}

export function hasOpenChildren(registry: TaskRegistry, parentId: string): boolean {
  return getChildren(registry, parentId).some(t => t.status_completion !== "done");
}


export async function updateTask(app: App, id: string, patch: Partial<Task>): Promise<void> {
  const registry = await loadRegistry(app);
  const idx = registry.findIndex(t => t._id === id);
  if (idx === -1) return;
  const raw = { ...registry[idx], ...patch, date_modified: todayStr() } as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(patch, "planned_date")) raw.is_today = patch.planned_date === todayStr();
  if (Object.prototype.hasOwnProperty.call(patch, "is_today")) raw.planned_date = patch.is_today ? todayStr() : null;
  const next = migrateTask(raw);
  if (!next.is_today || next.execution_state !== "ready" || next.status_completion !== "open") next.focus_order = null;
  registry[idx] = next;
  await saveRegistry(app, registry);
}

export async function setTaskStatus(app: App, id: string, status: CompletionStatus): Promise<void> {
  const existing = (await loadRegistry(app)).find(item => item._id === id);
  if (status === "done") {
    if (existing?.progress && existing.progress.current < existing.progress.target) throw new Error(`Overall progress must reach ${existing.progress.target} ${existing.progress.unit ?? ""} before completion.`);
  }
  const today = todayStr();
  await updateTask(app, id, {
    status_completion: status,
    date_completed: status === "done" ? today : null,
    // Keep the pipeline bar in sync: finishing a task fills it; reopening one
    // drops it back to "working" instead of leaving a stale "complete".
    pipeline_stage: status === "done" ? "complete" : existing?.pipeline_stage === "complete" ? "working" : existing?.pipeline_stage ?? null,
  });
}

export async function setPipelineStage(app: App, id: string, stage: PipelineStage | null): Promise<void> {
  await updateTask(app, id, { pipeline_stage: stage });
}

export async function moveTaskToToday(app: App, id: string, priority: "red" | "regular"): Promise<void> {
  await updateTask(app, id, { planned_date: todayStr(), status_priority: priority });
}

export async function deleteTask(app: App, id: string): Promise<void> {
  const registry = await loadRegistry(app);
  const today = todayStr();
  for (const t of registry) {
    if (t._id === id || t.parent_id === id) {
      t.is_deleted = true;
      t.is_today = false;
      t.planned_date = null;
      t.focus_order = null;
      t.date_modified = today;
    }
  }
  await saveRegistry(app, registry);
}

export async function restoreTask(app: App, id: string): Promise<void> {
  await updateTask(app, id, { is_deleted: false });
}

export async function clearNextDayTasks(app: App): Promise<void> {
  const today = todayStr();
  const d = new Date(today + "T12:00:00");
  d.setDate(d.getDate() - 1);
  const yesterdayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const registry = await loadRegistry(app);

  // Snapshot yesterday's state before clearing
  await writeHistorySnapshot(app, yesterdayStr, registry);

  for (const task of registry) task.is_today = task.planned_date === today;
  await saveRegistry(app, registry);
}

export function getActiveReminders(registry: TaskRegistry): Task[] {
  const today = todayStr();
  return registry.filter(t =>
    !t.is_deleted &&
    t.status_completion === "open" &&
    t.date_remind !== null &&
    t.date_remind <= today
  );
}

export { generateId, REGISTRY_PATH };

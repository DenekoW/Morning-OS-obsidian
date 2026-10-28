import type { App } from "obsidian";
import type { ProjectState, Task } from "./types";
import { loadActivityState, saveActivityState } from "./activity-service";
import { createProjectTask, loadRegistry, saveRegistry } from "./task-registry";
import { todayStr } from "./utils";

const PROJECT_STATE_PATH = "_generated/project-state.json";

export async function loadProjectStates(app: App): Promise<ProjectState[]> {
  if (!(await app.vault.adapter.exists(PROJECT_STATE_PATH))) return [];
  try {
    const value = JSON.parse(await app.vault.adapter.read(PROJECT_STATE_PATH)) as unknown;
    return Array.isArray(value) ? value.filter((item): item is ProjectState => Boolean(item && typeof item === "object" && "name" in item)) : [];
  } catch { return []; }
}

async function saveProjectStates(app: App, states: ProjectState[]): Promise<void> {
  if (!(await app.vault.adapter.exists("_generated"))) await app.vault.adapter.mkdir("_generated");
  await app.vault.adapter.write(PROJECT_STATE_PATH, JSON.stringify(states, null, 2));
}

export async function createProject(app: App, name: string, nextAction = ""): Promise<ProjectState> {
  const cleanName = name.trim();
  if (!cleanName) throw new Error("Project name is required");
  const states = await loadProjectStates(app);
  if (states.some(project => project.name.trim().toLocaleLowerCase() === cleanName.toLocaleLowerCase())) {
    throw new Error("A project with this name already exists");
  }
  const project = { name: cleanName, next_action: nextAction.trim(), date_modified: todayStr() };
  states.push(project);
  await saveProjectStates(app, states);
  return project;
}

export interface ProjectChangeResult {
  tasksUpdated: number;
  routinesUpdated: number;
}

export async function renameProject(app: App, oldName: string, newName: string): Promise<ProjectChangeResult> {
  const sourceName = oldName.trim();
  const cleanName = newName.trim();
  if (!sourceName) throw new Error("Project name is required");
  if (!cleanName) throw new Error("Project name is required");
  const [states, registry, activity] = await Promise.all([loadProjectStates(app), loadRegistry(app), loadActivityState(app)]);
  const matchesSource = (value: string) => value.trim().toLocaleLowerCase() === sourceName.toLocaleLowerCase();
  const sourceExists = states.some(project => matchesSource(project.name)) || registry.some(task => matchesSource(task.project)) || activity.routines.some(routine => matchesSource(routine.projectId ?? ""));
  if (!sourceExists) throw new Error("Project no longer exists");
  const conflicts = (value: string) => value.trim().toLocaleLowerCase() === cleanName.toLocaleLowerCase() && !matchesSource(value);
  if (states.some(project => conflicts(project.name)) || registry.some(task => conflicts(task.project)) || activity.routines.some(routine => conflicts(routine.projectId ?? ""))) {
    throw new Error("A project with this name already exists");
  }

  let stateFound = false;
  const nextStates = states.map(project => {
    if (!matchesSource(project.name)) return project;
    stateFound = true;
    return { ...project, name: cleanName, date_modified: todayStr() };
  });
  if (!stateFound) nextStates.push({ name: cleanName, next_action: "", next_action_task_id: null, date_modified: todayStr() });
  let tasksUpdated = 0;
  for (const task of registry) {
    if (!matchesSource(task.project)) continue;
    task.project = cleanName;
    task.date_modified = todayStr();
    tasksUpdated += 1;
  }
  let routinesUpdated = 0;
  for (const routine of activity.routines) {
    if (!matchesSource(routine.projectId ?? "")) continue;
    routine.projectId = cleanName;
    routinesUpdated += 1;
  }
  await saveRegistry(app, registry);
  if (routinesUpdated) await saveActivityState(app, activity);
  await saveProjectStates(app, nextStates);
  return { tasksUpdated, routinesUpdated };
}

export async function deleteProject(app: App, name: string): Promise<ProjectChangeResult> {
  const cleanName = name.trim();
  if (!cleanName) throw new Error("Project name is required");
  const [states, registry, activity] = await Promise.all([loadProjectStates(app), loadRegistry(app), loadActivityState(app)]);
  const matches = (value: string) => value.trim().toLocaleLowerCase() === cleanName.toLocaleLowerCase();
  const sourceExists = states.some(project => matches(project.name)) || registry.some(task => matches(task.project)) || activity.routines.some(routine => matches(routine.projectId ?? ""));
  if (!sourceExists) throw new Error("Project no longer exists");
  let tasksUpdated = 0;
  for (const task of registry) {
    if (!matches(task.project)) continue;
    task.project = "";
    task.date_modified = todayStr();
    tasksUpdated += 1;
  }
  let routinesUpdated = 0;
  for (const routine of activity.routines) {
    if (!matches(routine.projectId ?? "")) continue;
    routine.projectId = null;
    routinesUpdated += 1;
  }
  await saveRegistry(app, registry);
  if (routinesUpdated) await saveActivityState(app, activity);
  await saveProjectStates(app, states.filter(project => !matches(project.name)));
  return { tasksUpdated, routinesUpdated };
}

export async function setProjectNextAction(app: App, name: string, nextAction: string, taskId: string | null = null): Promise<void> {
  const states = await loadProjectStates(app);
  const index = states.findIndex(project => project.name === name);
  const next = { name, next_action: nextAction.trim(), next_action_task_id: taskId, date_modified: todayStr() };
  if (index === -1) states.push(next); else states[index] = next;
  await saveProjectStates(app, states);
}

export async function ensureProjectNextTask(app: App, name: string, nextAction: string): Promise<Task | null> {
  const cleanText = nextAction.trim();
  if (!cleanText) {
    await setProjectNextAction(app, name, "", null);
    return null;
  }
  const [states, registry] = await Promise.all([loadProjectStates(app), loadRegistry(app)]);
  const state = states.find(project => project.name === name);
  let task = state?.next_action_task_id
    ? registry.find(item => item._id === state.next_action_task_id && !item.is_deleted && item.status_completion === "open" && item.project === name)
    : undefined;
  if (!task) {
    const normalized = cleanText.toLocaleLowerCase();
    task = registry.find(item => !item.is_deleted && item.status_completion === "open" && item.project === name && item.text.trim().toLocaleLowerCase() === normalized);
  }
  if (!task) {
    task = createProjectTask(cleanText, name, "", "backlog");
    registry.push(task);
  } else if (task.text !== cleanText) {
    task.text = cleanText;
    task.date_modified = todayStr();
  }
  await saveRegistry(app, registry);
  await setProjectNextAction(app, name, task.text, task._id);
  return task;
}

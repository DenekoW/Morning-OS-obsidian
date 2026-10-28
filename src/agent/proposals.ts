import type { App } from "obsidian";
import type { AgentProposal, AgentRequest, AIContext, ProjectState, TaskRegistry } from "../types";
import type { MorningOSSettings } from "../settings";
import { callLLM } from "./llm";
import { selectProjectSummaries, selectTodayTasks, selectUnfinishedTasks, selectWorkload } from "../selectors";
import { todayStr } from "../utils";
import { validateProposal } from "./proposal-validator";
import { parseJsonObject } from "./json";
import type { ActivityState } from "../types";
import { loadActivityState } from "../activity-service";
import { getWeeklyActivitySummary } from "../selectors";

export interface AgentAdapter { propose(request: AgentRequest): Promise<AgentProposal>; }

const SYSTEM = `You are a research planning assistant. Return one JSON object only. Never request files or edit markdown.
Allowed mutation types: set-focus, move-to-today, move-to-backlog, set-execution-state, set-task-metadata, set-project-next-action.
Return {"feature": string, "summary": string, "rationale": string[], "mutations": ProposedMutation[]}.
Mutation shapes are exactly:
{"type":"set-focus","task_id":"existing-id","order":1}
{"type":"move-to-today","task_id":"existing-id"}
{"type":"move-to-backlog","task_id":"existing-id"}
{"type":"set-execution-state","task_id":"existing-id","state":"ready|waiting|blocked"}
{"type":"set-task-metadata","task_id":"existing-id","effort_minutes":60,"context":"deep-work"}
{"type":"set-project-next-action","project":"exact project name","next_action":"one concrete action"}
Never invent or rewrite task IDs. For plan-day, select at most three open, ready Today tasks using set-focus with unique orders 1–3. Prefer realistic capacity and explicitly respect blocked/waiting tasks.`;

class ProviderAgentAdapter implements AgentAdapter {
  constructor(private settings: MorningOSSettings) {}
  async propose(request: AgentRequest): Promise<AgentProposal> {
    const raw = await callLLM(SYSTEM, JSON.stringify(request), this.settings);
    return parseJsonObject(raw) as AgentProposal;
  }
}

export function buildAIContext(tasks: TaskRegistry, projects: ProjectState[], settings: MorningOSSettings, activity?: ActivityState): AIContext {
  const date = todayStr();
  return {
    date,
    today_tasks: selectTodayTasks(tasks, date),
    unfinished_tasks: selectUnfinishedTasks(tasks, date),
    project_summaries: selectProjectSummaries(tasks, projects, date),
    workload: selectWorkload(tasks, date),
    recent_completed: tasks.filter(task => task.status_completion === "done" && task.date_completed).slice(-20).map(task => ({ _id: task._id, text: task.text, project: task.project, date_completed: task.date_completed })),
    capacity: { daily_minutes: settings.dailyCapacityMinutes, deep_work_minutes: settings.deepWorkCapacityMinutes },
    weeklyActivity: activity ? getWeeklyActivitySummary(activity, date) : undefined,
  };
}

export async function requestAgentProposal(app: App, feature: AgentRequest["feature"], tasks: TaskRegistry, projects: ProjectState[], settings: MorningOSSettings, project?: string): Promise<AgentProposal> {
  const activity = await loadActivityState(app);
  const request: AgentRequest = {
    feature,
    context: buildAIContext(tasks, projects, settings, activity),
    project,
    project_tasks: project ? tasks.filter(task => !task.is_deleted && task.status_completion === "open" && task.project === project) : undefined,
  };
  const adapter: AgentAdapter = new ProviderAgentAdapter(settings);
  return validateProposal(await adapter.propose(request), request, tasks);
}

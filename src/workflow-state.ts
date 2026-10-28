import type { App } from "obsidian";
import type { DailyWorkflowState } from "./types";
import { todayStr } from "./utils";

const WORKFLOW_DIR = "_generated/workflow";
const emptyState = (date: string): DailyWorkflowState => ({ date, planning_completed_at: null, still_on_mind: "", tomorrow_first_task_id: null, dismissed_last_night_task_id: null, closed_at: null });

export async function loadWorkflowState(app: App, date = todayStr()): Promise<DailyWorkflowState> {
  const path = `${WORKFLOW_DIR}/${date}.json`;
  if (!(await app.vault.adapter.exists(path))) return emptyState(date);
  try { return { ...emptyState(date), ...JSON.parse(await app.vault.adapter.read(path)) as Partial<DailyWorkflowState>, date }; }
  catch { return emptyState(date); }
}

export async function saveWorkflowState(app: App, state: DailyWorkflowState): Promise<void> {
  if (!(await app.vault.adapter.exists(WORKFLOW_DIR))) await app.vault.adapter.mkdir(WORKFLOW_DIR);
  await app.vault.adapter.write(`${WORKFLOW_DIR}/${state.date}.json`, JSON.stringify(state, null, 2));
}

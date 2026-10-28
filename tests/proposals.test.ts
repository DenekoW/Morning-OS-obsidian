import test from "node:test";
import assert from "node:assert/strict";
import type { AgentRequest, Task } from "../src/types";
import { validateProposal } from "../src/agent/proposal-validator";
import { buildLocalPlanProposal } from "../src/agent/local-plan";
import { parseJsonObject } from "../src/agent/json";
import { describeProposalMutation } from "../src/agent/proposal-label";

const task: Task = {
  _id: "t1", text: "Write", notes: "", areas: [], tags: {}, status_completion: "open", status_priority: "regular", status_urgency: "none",
  is_today: true, is_deleted: false, date_created: "2026-09-06", date_modified: "2026-09-06", date_completed: null, date_remind: null,
  parent_id: null, project: "Paper", eisenhower_priority: "", planned_date: "2026-09-06", effort_minutes: 60, context: "writing",
  execution_state: "ready", focus_order: null,
};
const request: AgentRequest = {
  feature: "plan-day",
  context: { date: "2026-09-06", today_tasks: [task], unfinished_tasks: [], project_summaries: [], workload: { task_count: 1, known_minutes: 60, unknown_count: 0, deep_work_minutes: 0 }, recent_completed: [], capacity: { daily_minutes: 480, deep_work_minutes: 240 } },
};

test("proposal validator accepts whitelisted mutations", () => {
  const proposal = validateProposal({ feature: "plan-day", summary: "Focus", rationale: ["Ready"], mutations: [{ type: "set-focus", task_id: "t1", order: 1 }] }, request, [task]);
  assert.equal(proposal.mutations.length, 1);
});

test("proposal validator rejects unknown tasks and duplicate Focus slots", () => {
  assert.throws(() => validateProposal({ feature: "plan-day", summary: "Bad", rationale: [], mutations: [{ type: "move-to-today", task_id: "missing" }] }, request, [task]), /Unknown task/);
  assert.throws(() => validateProposal({ feature: "plan-day", summary: "Bad", rationale: [], mutations: [{ type: "set-focus", task_id: "t1", order: 1 }, { type: "set-focus", task_id: "t1", order: 1 }] }, request, [task]), /Duplicate Focus/);
});

test("project review cannot mutate tasks outside the selected project", () => {
  const scoped = { ...request, feature: "review-project" as const, project: "Paper", project_tasks: [task] };
  const other = { ...task, _id: "other", project: "Other" };
  assert.throws(() => validateProposal({ feature: "review-project", summary: "Bad", rationale: [], mutations: [{ type: "set-execution-state", task_id: "other", state: "blocked" }] }, scoped, [task, other]), /crossed task scope/);
});

test("agent JSON parser accepts fenced and prefixed JSON", () => {
  assert.deepEqual(parseJsonObject('```json\n{"feature":"plan-day"}\n```'), { feature: "plan-day" });
  assert.deepEqual(parseJsonObject('Plan follows: {"feature":"plan-day","summary":"ok"}'), { feature: "plan-day", summary: "ok" });
  assert.throws(() => parseJsonObject("not a plan"), /text instead of a plan/);
});

test("local plan only selects ready open Today tasks in priority order", () => {
  const urgent = { ...task, _id: "urgent", status_priority: "red" as const, eisenhower_priority: "urgent_important" as const };
  const blocked = { ...task, _id: "blocked", execution_state: "blocked" as const };
  const backlog = { ...task, _id: "backlog", is_today: false };
  const regular = { ...task, _id: "regular", date_created: "2026-09-05" };
  const proposal = buildLocalPlanProposal([regular, blocked, backlog, urgent]);
  assert.deepEqual(proposal.mutations, [
    { type: "set-focus", task_id: "urgent", order: 1 },
    { type: "set-focus", task_id: "regular", order: 2 },
  ]);
});

test("proposal descriptions expose task meaning instead of internal IDs", () => {
  const description = describeProposalMutation({ type: "set-focus", task_id: "t1", order: 1 }, [task]);
  assert.equal(description.action, "Focus #1");
  assert.equal(description.taskText, "Write");
  assert.deepEqual(description.metadata, ["Paper"]);
  assert.equal(JSON.stringify(description).includes("t1"), false);

  const missing = describeProposalMutation({ type: "move-to-today", task_id: "missing" }, [task]);
  assert.equal(missing.taskText, "Task is no longer available");
  assert.equal(JSON.stringify(missing).includes("missing"), false);
});

import type { AgentProposal, AgentRequest, ProposedMutation, TaskRegistry } from "../types";

function validateMutation(mutation: ProposedMutation, tasks: TaskRegistry): string | null {
  if (mutation.type === "set-project-next-action") return mutation.project.trim() ? null : "Project name is required";
  const task = tasks.find(item => item._id === mutation.task_id && !item.is_deleted);
  if (!task) return `Unknown task: ${mutation.task_id}`;
  if (mutation.type === "set-focus" && (mutation.order < 1 || mutation.order > 3)) return "Focus order must be 1–3";
  if (mutation.type === "set-task-metadata" && mutation.effort_minutes !== undefined && mutation.effort_minutes !== null && mutation.effort_minutes < 0) return "Effort cannot be negative";
  return null;
}

export function validateProposal(proposal: AgentProposal, request: AgentRequest, tasks: TaskRegistry): AgentProposal {
  if (!proposal || proposal.feature !== request.feature || !Array.isArray(proposal.mutations)) throw new Error("Agent returned an invalid proposal");
  if (proposal.mutations.length > 30) throw new Error("Agent proposal is too large");
  const focusOrders = new Set<number>();
  for (const mutation of proposal.mutations) {
    const error = validateMutation(mutation, tasks);
    if (error) throw new Error(error);
    if (mutation.type === "set-focus") {
      if (focusOrders.has(mutation.order)) throw new Error(`Duplicate Focus order ${mutation.order}`);
      focusOrders.add(mutation.order);
    }
    if (mutation.type === "set-project-next-action" && request.project && mutation.project !== request.project) throw new Error("Project review crossed project scope");
    if (request.project && mutation.type !== "set-project-next-action") {
      const allowed = request.project_tasks?.some(task => task._id === mutation.task_id);
      if (!allowed) throw new Error("Project review crossed task scope");
    }
  }
  return { ...proposal, summary: String(proposal.summary || "Proposal"), rationale: Array.isArray(proposal.rationale) ? proposal.rationale.map(String).slice(0, 12) : [] };
}

import type { AgentProposal, TaskRegistry } from "../types";

export function buildLocalPlanProposal(tasks: TaskRegistry): AgentProposal {
  const rank = (task: TaskRegistry[number]): number => {
    if (task.eisenhower_priority === "urgent_important") return 0;
    if (task.status_priority === "red") return 1;
    if (task.eisenhower_priority === "important_not_urgent") return 2;
    if (task.eisenhower_priority === "urgent_not_important") return 3;
    return 4;
  };
  const candidates = tasks
    .filter(task => task.is_today && !task.is_deleted && task.status_completion === "open" && task.execution_state === "ready")
    .sort((a, b) => {
      const existingA = a.focus_order ?? 99;
      const existingB = b.focus_order ?? 99;
      return existingA - existingB || rank(a) - rank(b) || a.date_created.localeCompare(b.date_created);
    })
    .slice(0, 3);
  return {
    feature: "plan-day",
    summary: "Local focus plan (AI unavailable)",
    rationale: ["Kept only open, ready Today tasks", "Ordered existing Focus first, then urgency and importance"],
    mutations: candidates.map((task, index) => ({ type: "set-focus" as const, task_id: task._id, order: index + 1 })),
  };
}

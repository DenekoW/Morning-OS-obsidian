import type { ProposedMutation, TaskRegistry } from "../types";

export interface ProposalMutationDescription {
  action: string;
  taskText: string | null;
  metadata: string[];
}

export function describeProposalMutation(
  mutation: ProposedMutation,
  tasks: TaskRegistry,
): ProposalMutationDescription {
  if (mutation.type === "set-project-next-action") {
    return {
      action: `Set next action · ${mutation.project}`,
      taskText: mutation.next_action,
      metadata: [],
    };
  }

  const task = tasks.find(item => item._id === mutation.task_id && !item.is_deleted);
  const metadata = task
    ? [task.project, priorityLabel(task.eisenhower_priority)].filter((value): value is string => Boolean(value))
    : [];
  const action = mutation.type === "set-focus"
    ? `Focus #${mutation.order}`
    : mutation.type === "move-to-today"
      ? "Move to Today"
      : mutation.type === "move-to-backlog"
        ? "Move to Backlog"
        : mutation.type === "set-execution-state"
          ? `Set ${mutation.state}`
          : "Update task details";
  return {
    action,
    taskText: task?.text ?? "Task is no longer available",
    metadata,
  };
}

function priorityLabel(priority: TaskRegistry[number]["eisenhower_priority"]): string {
  if (priority === "urgent_important") return "紧急且重要";
  if (priority === "important_not_urgent") return "重要不紧急";
  if (priority === "urgent_not_important") return "紧急不重要";
  return "";
}

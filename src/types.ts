export type CompletionStatus = "open" | "done" | "dismissed";
export type ExecutionState = "ready" | "waiting" | "blocked";
/** Work-pipeline stage shown as a segmented mini bar on Today tasks. */
export type PipelineStage = "start" | "working" | "collecting" | "complete";
export const PIPELINE_STAGES: PipelineStage[] = ["start", "working", "collecting", "complete"];
export type AgentFeature = "plan-day" | "review-project" | "weekly-review";

export interface FieldDef {
  key: string;
  label: string;
  type: "text" | "url" | "dropdown" | "date";
  options?: string[];
}

export interface TabConfig {
  key: string;
  label: string;
  fields: FieldDef[];
  view_mode: "cards" | "table";
}

export interface AreaConfig {
  key: string;
  label: string;
  icon: string;
  tabs: TabConfig[];
  feedToLLM: boolean;  // whether area markdown sections feed into LLM context
}

export interface LLMSectionMapping {
  heading: string;    // e.g. "Tactical Rules", "Short Term"
  target: "tactical_rules" | "emotional_rules" | "goals_short" | "goals_long";
  enabled: boolean;
}

export interface Task {
  _id: string;
  text: string;
  notes: string;
  areas: string[];
  tags: Record<string, string>;
  status_completion: CompletionStatus;
  status_priority: "red" | "regular";
  status_urgency: "none" | "low" | "med" | "high";
  is_today: boolean;
  is_deleted: boolean;
  date_created: string;
  date_modified: string;
  date_completed: string | null;
  date_remind: string | null;
  parent_id: string | null;
  project: string;
  eisenhower_priority: "" | "important_not_urgent" | "urgent_not_important" | "urgent_important";
  planned_date: string | null;
  effort_minutes: number | null;
  context: string;
  execution_state: ExecutionState;
  focus_order: number | null;
  /** Optional stable link; old task records remain valid without it. */
  routine_id?: string | null;
  progress?: TaskProgress | null;
  daily_progress_target?: DailyProgressTarget | null;
  /** null/undefined = not started yet (empty pipeline bar). */
  pipeline_stage?: PipelineStage | null;
}

export interface TaskProgress {
  type: "count";
  current: number;
  target: number;
  unit?: string;
}

export interface DailyProgressTarget {
  date: string;
  target: number;
  startingValue: number;
}

export interface ProgressEvent {
  id: string;
  taskId: string;
  timestamp: string;
  previousValue: number;
  newValue: number;
  delta: number;
  note?: string;
  focusSessionId?: string;
  focusMinutes?: number;
  dailyNoteWritten: boolean;
}

export interface WorkLogEvent {
  id: string;
  date: string;
  timestamp: string;
  title: string;
  details: string[];
  note?: string;
}

export type TaskRegistry = Task[];

export type SuggestionSource =
  | "tasks"
  | "goals"
  | "technical_backlog"
  | "carried_tasks"
  | "wins";

export interface Suggestion {
  text: string;
  source: SuggestionSource;
}

export interface DailyBrief {
  date: string;
  meta?: {
    goals: {
      short_term_count: number;
      long_term_count: number;
    };
  };
  identity?: {
    rules: string[];
  };
  goals?: {
    short_term: string[];
    long_term: string[];
  };
  tactical_rules?: string[];
  hobby_tasks?: string[];
  suggestions?: Suggestion[];
  wins?: string[];
}

export interface ProjectState {
  name: string;
  next_action: string;
  next_action_task_id?: string | null;
  date_modified: string;
}

export interface ProjectSummary {
  name: string;
  open_count: number;
  today_count: number;
  blocked_count: number;
  next_action: string;
  last_touched: string | null;
  days_since_activity: number | null;
}

export interface WorkloadSummary {
  task_count: number;
  known_minutes: number;
  unknown_count: number;
  deep_work_minutes: number;
}

export interface SuggestedProjectAction {
  project: string;
  task: Task;
  source: "next" | "ready";
}

export interface DailyWorkflowState {
  date: string;
  planning_completed_at: string | null;
  still_on_mind: string;
  tomorrow_first_task_id: string | null;
  dismissed_last_night_task_id?: string | null;
  closed_at: string | null;
}

export type RoutineCadence = "daily" | "weekly";
export type RoutineMetric = "check" | "duration" | "count";
export type FocusSessionStatus = "active" | "paused" | "completed" | "cancelled";
export type FocusSessionType = "deep-work" | "writing" | "reading" | "coding" | "other";

export interface Routine {
  id: string;
  name: string;
  projectId?: string | null;
  cadence: RoutineCadence;
  metric: RoutineMetric;
  target: number;
  unit?: string;
  enabled: boolean;
}

export interface RoutineLog {
  id: string;
  routineId: string;
  date: string;
  value: number;
  note?: string;
  createdAt: string;
}

export interface FocusSession {
  id: string;
  title: string;
  startedAt: string;
  endedAt?: string;
  pausedAt?: string;
  pausedDurationMs: number;
  durationMinutes?: number;
  status: FocusSessionStatus;
  taskId?: string;
  projectId?: string;
  routineId?: string;
  type: FocusSessionType;
  note?: string;
  dailyNoteWritten?: boolean;
}

export interface ReadingEntry {
  id: string;
  title: string;
  date: string;
  level: "skim" | "read";
  project?: string;
  note?: string;
  focusSessionId?: string;
}

export interface ActivityState {
  schemaVersion: 1;
  routines: Routine[];
  routineLogs: RoutineLog[];
  focusSessions: FocusSession[];
  readingEntries: ReadingEntry[];
  activeSessionId: string | null;
}

export interface WeeklyActivitySummary {
  focusedMinutes: number;
  sessions: number;
  projectFocusMinutes: Record<string, number>;
  routineProgress: Record<string, { value: number; target: number; unit: string }>;
  papersRead: number;
}

export interface AIContext {
  date: string;
  today_tasks: Task[];
  unfinished_tasks: Task[];
  project_summaries: ProjectSummary[];
  workload: WorkloadSummary;
  recent_completed: Pick<Task, "_id" | "text" | "project" | "date_completed">[];
  capacity: { daily_minutes: number; deep_work_minutes: number };
  weeklyActivity?: WeeklyActivitySummary;
}

export type ProposedMutation =
  | { type: "set-focus"; task_id: string; order: number }
  | { type: "move-to-today"; task_id: string }
  | { type: "move-to-backlog"; task_id: string }
  | { type: "set-execution-state"; task_id: string; state: ExecutionState }
  | { type: "set-task-metadata"; task_id: string; effort_minutes?: number | null; context?: string }
  | { type: "set-project-next-action"; project: string; next_action: string };

export interface AgentRequest {
  feature: AgentFeature;
  context: AIContext;
  project?: string;
  project_tasks?: Task[];
}

export interface AgentProposal {
  feature: AgentFeature;
  summary: string;
  rationale: string[];
  mutations: ProposedMutation[];
}

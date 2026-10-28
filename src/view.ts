import { ItemView, WorkspaceLeaf, TFile, Modal, App, sanitizeHTMLToDom, MarkdownRenderer, Component, requestUrl, Notice } from "obsidian";
import changelogText from "../CHANGELOG.md";
import { parseChangelog } from "./agent/parse-changelog";

declare const __FEEDBACK_PROXY_URL__: string;
declare const __FEEDBACK_SECRET__: string;
const FEEDBACK_PROXY_URL: string = __FEEDBACK_PROXY_URL__;
const FEEDBACK_SECRET: string    = __FEEDBACK_SECRET__;
import { DailyBrief, Task, TaskRegistry, FieldDef, TabConfig, AreaConfig, DailyWorkflowState, ProjectState, AgentFeature, AgentProposal, ProposedMutation, ActivityState, FocusSession, Routine, RoutineCadence, RoutineMetric, PipelineStage, PIPELINE_STAGES } from "./types";
import { MorningOSSettings } from "./settings";
import type MorningOSPlugin from "./main";
import { renderOnboarding } from "./onboarding";
import { scaffoldDailyNote } from "./agent/scaffold-daily-note";
import { addDays, dateStrFromTimestamp, todayStr } from "./utils";
import { loadRegistry, saveRegistry, setTaskStatus, setPipelineStage, updateTask, createTask, createProjectTask, moveTaskToToday, deleteTask, getActiveReminders, getChildren, hasOpenChildren } from "./task-registry";
import { appendWinToLog, readTodayWinsFromLog } from "./agent/vault-reader";
import { parseIdentityAnchor } from "./agent/vault-reader";
import { attachTaskTextSuggest } from "./task-text-suggest";
import { selectContinuableProgressTasks, selectFocusTasks, selectProjectPlanningTasks, selectProjectSummaries, selectSuggestedProjectActions, selectTodayTasks, selectUnfinishedTasks, selectWorkload, formatCombinedWorkloadSummary, formatDuration, formatRecency, getRemainingDailyRoutineMinutes, getRoutineProgress, getSessionCount, getTodayFocusMinutes } from "./selectors";
import { createProject, deleteProject, ensureProjectNextTask, loadProjectStates, renameProject, setProjectNextAction } from "./project-state";
import { loadWorkflowState, saveWorkflowState } from "./workflow-state";
import { applyMutations, moveFocusTask } from "./mutation-service";
import { requestAgentProposal } from "./agent/proposals";
import { buildLocalPlanProposal } from "./agent/local-plan";
import { describeProposalMutation } from "./agent/proposal-label";
import { shouldAutoSaveTask, type TaskEditCloseIntent } from "./task-edit-state";
import { adjustRoutineProgress, cancelFocusSession, createRoutine, defaultActivityState, elapsedMilliseconds, finishFocusSession, loadActivityState, logReading, logRoutine, markFocusSessionDailyNoteWritten, pauseFocusSession, resumeFocusSession, startFocusSession, updateRoutine } from "./activity-service";
import { appendWorkLogEvent, writeDailyTargetChangeEvent, writeMorningPlanSnapshot, writeShutdownSnapshot } from "./daily-note-service";
import { getTaskProgressToday, loadProgressEvents, logTaskProgress, setTaskDailyProgressTarget, syncPendingProgressEvents } from "./progress-service";
import { completeTaskWithNote } from "./task-completion-service";
import { describeTaskAssistantAction, executeTaskAssistantAction, loadTaskAssistantActivities, requestTaskAssistant, resolveTaskQuery, type TaskAssistantActivity, type TaskAssistantPlan, undoTaskAssistantActivity } from "./task-assistant-service";

export const VIEW_TYPE_AREA = "morning-os-area-view";
export const VIEW_TYPE_DUMP = "morning-os-inbox-view";
export const VIEW_TYPE_TRASH = "morning-os-trash-view";

function buildNavItems(areas: AreaConfig[]) {
  return [
    { id: "home",  label: "🌅 Home",  type: VIEW_TYPE_MORNING },
    { id: "dump",  label: "📥 Inbox", type: VIEW_TYPE_DUMP },
    ...areas.map(p => ({ id: p.key, label: `${p.icon} ${p.label}`, type: `${VIEW_TYPE_AREA}-${p.key}` })),
    { id: "trash", label: "🗑 Trash", type: VIEW_TYPE_TRASH },
  ];
}

// Renders vault/LLM-authored text as markdown so Obsidian features (wikilinks, bold, tags, …)
// work inside task titles and metadata — plain createEl({text}) only ever sets textContent.
function renderMdContent(
  app: App,
  component: Component,
  parent: HTMLElement,
  tag: keyof HTMLElementTagNameMap,
  cls: string,
  text: string
): HTMLElement {
  const el = parent.createEl(tag, cls ? { cls } : undefined);
  void MarkdownRenderer.render(app, text, el, "", component).then(() => {
    // Unwrap the single <p> block so inline layouts (flex rows, list items) aren't affected
    const inner = el.querySelector(":scope > p");
    if (inner && el.childNodes.length === 1) {
      while (inner.firstChild) el.insertBefore(inner.firstChild, inner);
      inner.remove();
    }
  });
  return el;
}

function requestTaskCompletion(
  app: App,
  settings: MorningOSSettings,
  task: Task,
  registry: TaskRegistry,
  onComplete: () => void | Promise<void>,
): void {
  if (task.progress && task.progress.current < task.progress.target) {
    new Notice(`Overall progress must reach ${task.progress.target} ${task.progress.unit ?? ""} before completion.`);
    return;
  }
  if (settings.requireSubtasksComplete && hasOpenChildren(registry, task._id)) {
    new Notice("Morning OS: Complete all subtasks first");
    return;
  }
  new TaskCompletionModal(app, task, async note => {
    const result = await completeTaskWithNote(app, settings, task._id, note);
    if (!result.dailyNoteWritten) new Notice("Task completed and note saved, but the Daily Note Work Log could not be updated.", 8000);
    await onComplete();
  }).open();
}


export const VIEW_TYPE_MORNING = "morning-os-view";

const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  start: "Start",
  working: "Working",
  collecting: "Collecting",
  complete: "Complete",
};

const PIPELINE_STAGE_TITLES: Record<PipelineStage, string> = {
  start: "Start — kicked off",
  working: "Working — actively in progress",
  collecting: "Collecting — gathering results",
  complete: "Complete — mark task done",
};

export class MorningView extends ItemView {
  private brief: DailyBrief | null = null;
  private wins: string[] = [];
  private suggestionReactions: ("up" | "down" | null)[] = [];
  private settings: MorningOSSettings;
  private plugin: MorningOSPlugin;
  private floatingHandle: HTMLElement | null = null;
  private floatingActions: HTMLElement | null = null;
  private floatingCleanup: (() => void) | null = null;
  private registry: TaskRegistry = [];
  private identityLines: string[] = [];
  private projectStates: ProjectState[] = [];
  private workflowState: DailyWorkflowState = { date: todayStr(), planning_completed_at: null, still_on_mind: "", tomorrow_first_task_id: null, dismissed_last_night_task_id: null, closed_at: null };
  private activity: ActivityState = defaultActivityState();
  private lastNightCandidate: Task | null = null;
  private timerTicker: number | null = null;
  private expandedProjects = new Set<string>();

  constructor(leaf: WorkspaceLeaf, settings: MorningOSSettings, plugin: MorningOSPlugin) {
    super(leaf);
    this.settings = settings;
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_MORNING; }
  getDisplayText(): string { return "Morning OS"; }
  getIcon(): string { return "sun"; }

  async onOpen() {
    if (!this.settings.onboarded) {
      await this.loadRegistryAndIdentity();
      await this.loadWins();
      this.render();
      return;
    }

    const today = todayStr();
    await scaffoldDailyNote(today, this.app, this.settings);

    // Auto-promote tasks with due date_remind to today
    await this.promoteReminders();

    // Always load registry and render immediately — don't block on agent
    await this.loadRegistryAndIdentity();
    await this.loadBrief();
    await this.loadWins();
    await this.loadSuggestionReaction();
    this.render();

    // Trigger agent in background if brief doesn't exist for today
    const briefPath = `${this.settings.briefsDir}/${today}.json`;
    const briefExists = await this.app.vault.adapter.exists(briefPath);
    const alreadyRan = this.plugin.settings.agentLastRunDate === today && briefExists;
    if (!alreadyRan) {
      void this.plugin.triggerAgent();
    }
  }

  async onClose() {
    if (this.timerTicker !== null) window.clearInterval(this.timerTicker);
    this.floatingCleanup?.();
    this.floatingCleanup = null;
    this.floatingHandle?.remove();
    this.floatingHandle = null;
    this.floatingActions?.remove();
    this.floatingActions = null;
  }

  async refresh() {
    await this.loadBrief();
    await this.loadWins();
    await this.loadSuggestionReaction();
    await this.loadRegistryAndIdentity();
    this.render();
  }

  private async promoteReminders() {
    const today = todayStr();
    const registry = await loadRegistry(this.app);
    const due = registry.filter(t =>
      !t.is_deleted && !t.is_today &&
      t.status_completion === "open" &&
      t.date_remind !== null && t.date_remind <= today
    );
    if (!due.length) return;
    for (const t of due) {
      t.is_today = true;
      t.date_modified = today;
    }
    await saveRegistry(this.app, registry);
  }

  private async loadRegistryAndIdentity() {
    try { await syncPendingProgressEvents(this.app, this.settings); } catch (error) { console.error("Morning OS pending progress sync failed", error); }
    [this.registry, this.identityLines, this.projectStates, this.workflowState, this.activity] = await Promise.all([
      loadRegistry(this.app), parseIdentityAnchor(this.app, this.settings), loadProjectStates(this.app), loadWorkflowState(this.app), loadActivityState(this.app),
    ]);
    const previousWorkflow = await loadWorkflowState(this.app, addDays(todayStr(), -1));
    const candidateId = previousWorkflow.tomorrow_first_task_id;
    this.lastNightCandidate = candidateId && this.workflowState.dismissed_last_night_task_id !== candidateId
      ? this.registry.find(task => task._id === candidateId && !task.is_deleted && task.status_completion === "open") ?? null
      : null;
    await this.syncPendingFocusWorkLogs();
  }

  private async syncPendingFocusWorkLogs(): Promise<void> {
    const progressEvents = await loadProgressEvents(this.app);
    for (const session of this.activity.focusSessions.filter(item => item.status === "completed" && item.dailyNoteWritten === false)) {
      const task = session.taskId ? this.registry.find(item => item._id === session.taskId) : undefined;
      if (task?.progress) {
        if (progressEvents.some(event => event.focusSessionId === session.id && event.dailyNoteWritten)) await markFocusSessionDailyNoteWritten(this.app, session.id);
        continue;
      }
      const reading = this.activity.readingEntries.find(entry => entry.focusSessionId === session.id);
      if (session.type === "reading" && !reading) continue;
      await appendWorkLogEvent(this.app, this.settings, reading ? { id: reading.id, date: reading.date, timestamp: session.endedAt ?? session.startedAt, title: reading.title, details: [`Reading: ${formatDuration(session.durationMinutes ?? 0)}`, `Status: ${reading.level === "read" ? "Read" : "Skim"}`], note: reading.note } : { id: session.id, date: dateStrFromTimestamp(session.endedAt ?? session.startedAt), timestamp: session.endedAt ?? session.startedAt, title: session.title, details: [`Focus: ${formatDuration(session.durationMinutes ?? 0)}`], note: session.note });
      await markFocusSessionDailyNoteWritten(this.app, session.id);
    }
  }

  private async loadBrief() {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const file = this.app.vault.getAbstractFileByPath(`${this.settings.briefsDir}/${today}.json`);
    if (file instanceof TFile) {
      this.brief = JSON.parse(await this.app.vault.read(file)) as DailyBrief;
    } else {
      this.brief = null;
    }
  }

  private async loadWins() {
    const today = todayStr();
    const fromLog = await readTodayWinsFromLog(today, this.app, this.settings);
    if (fromLog.length > 0) {
      this.wins = fromLog;
    } else {
      this.wins = this.brief?.wins?.slice() ?? [];
    }
  }

  private parseWinsFromNote(content: string): string[] {
    const lines = content.split("\n");
    const wins: string[] = [];
    let inWins = false;
    for (const line of lines) {
      const stripped = line.trim();
      const winsRe = new RegExp(`^#{1,3} (?:${this.settings.sectionWins}|I feel good about these after today)\\s*$`, "i");
      if (winsRe.test(stripped)) {
        inWins = true;
        continue;
      }
      if (inWins) {
        if (/^#{1,3} /.test(stripped)) break;
        const match = stripped.match(/^-\s*(?:\[.\]\s+)?(.*)/);
        if (match && match[1].trim()) wins.push(match[1].trim());
      }
    }
    return wins;
  }

  private async loadSuggestionReaction() {
    const count = this.brief?.suggestions?.length ?? 0;
    this.suggestionReactions = Array<"up" | "down" | null>(count).fill(null);
    if (!count) return;
    const file = this.app.vault.getAbstractFileByPath(
      `${this.settings.feedbackDir}/reactions/${todayStr()}.json`
    );
    if (!(file instanceof TFile)) return;
    try {
      const data = JSON.parse(await this.app.vault.read(file)) as { suggestion_reactions?: ("up" | "down" | null)[] };
      const saved: ("up" | "down" | null)[] = data.suggestion_reactions ?? [];
      for (let i = 0; i < count; i++) {
        this.suggestionReactions[i] = saved[i] ?? null;
      }
    } catch { /* intentional — corrupt reactions file just resets to no reactions */ }
  }

  private render() {
    if (this.timerTicker !== null) { window.clearInterval(this.timerTicker); this.timerTicker = null; }
    const container = this.containerEl.children[1] as HTMLElement;
    const previousScrollTop = container.querySelector<HTMLElement>(":scope > .morning-os-scroll")?.scrollTop ?? null;
    container.empty();
    container.addClass("morning-os");

    if (!this.settings.onboarded) {
      renderOnboarding(container, this.plugin);
      return;
    }

    this.floatingHandle?.remove();
    this.floatingHandle = null;
    this.floatingActions?.remove();
    this.floatingActions = null;
    this.renderFloatingActions();

    const scroll = container.createDiv({ cls: "morning-os-scroll" });
    const wrapper = scroll.createDiv({ cls: "morning-os-wrapper" });

    this.renderWhatsNew(wrapper);

    if (this.wantsAI() && !this.hasApiKey()) {
      this.renderApiKeyBanner(wrapper);
    }

    this.renderHeader(wrapper);
    this.renderIdentityStrip(wrapper);
    this.renderGoals(wrapper);
    this.renderFocus(wrapper);

    const body = wrapper.createDiv({ cls: "morning-os-body" });
    const left = body.createDiv({ cls: "morning-os-left" });
    const right = body.createDiv({ cls: "morning-os-right" });

    this.renderPipelineBoard(left);
    this.renderTasks(left);
    this.renderTacticalRules(right);
    this.renderSuggestion(right);
    if (right.childElementCount === 0) {
      body.addClass("is-single-column");
      right.remove();
    }

    this.renderRoutines(wrapper);

    this.renderMorningPlanning(wrapper);
    this.renderProjects(wrapper);
    this.renderHobbyTasks(wrapper);
    this.renderWins(wrapper);
    this.renderShutdown(wrapper);
    this.renderFeedbackFooter(wrapper);
    if (previousScrollTop !== null) {
      scroll.scrollTop = previousScrollTop;
      window.requestAnimationFrame(() => { scroll.scrollTop = previousScrollTop; });
    }
  }

  private hasApiKey(): boolean {
    const s = this.settings;
    const provider = s.intelligenceProvider;
    if (provider === "bedrock") return !!(s.awsAccessKeyId && s.awsSecretAccessKey);
    if (provider === "openai") return !!s.openaiApiKey;
    if (provider === "deepseek") return !!s.deepseekApiKey;
    if (provider === "gemini") return !!s.geminiApiKey;
    if (provider === "groq") return !!s.groqApiKey;
    return false;
  }

  private wantsAI(): boolean {
    const s = this.settings;
    return s.aiEnabled && (
      s.modeTacticalRules || s.modeIdentityRules || s.modeGoals ||
      s.modeHobbyTasks || s.modeSuggestion ||
      s.modeWins
    );
  }

  private renderApiKeyBanner(parent: HTMLElement) {
    const banner = parent.createDiv({ cls: "mos-onboard-banner" });
    banner.createSpan({
      text: "Add your API key in Morning OS settings to generate personalized briefings, or turn off Use AI for briefings.",
    });
    const dismiss = banner.createEl("button", { cls: "mos-onboard-banner-dismiss", text: "✕" });
    dismiss.addEventListener("click", () => banner.remove());
  }

  private renderHeader(parent: HTMLElement) {
    const header = parent.createDiv({ cls: "morning-os-header" });
    const dateObj = new Date(todayStr() + "T00:00:00");
    header.createDiv({
      cls: "morning-os-date-weekday",
      text: dateObj.toLocaleDateString("en-US", { weekday: "long" }),
    });
    const board = header.createEl("button", { cls: "mos-task-board-link", text: "▦ 任务看板" });
    board.addEventListener("click", () => this.app.workspace.openLinkText(this.settings.taskBoardPath, "", false));
    header.createDiv({
      cls: "morning-os-date-numeric",
      text: dateObj.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" }),
    });
  }

  private renderFloatingActions() {
    const container = this.containerEl.children[1] as HTMLElement;
    const { handle, actions, cleanup } = mountFloatingPanel(container, this.plugin);
    this.floatingHandle = handle;
    this.floatingActions = actions;
    this.floatingCleanup = cleanup;
  }

  private renderIdentityStrip(parent: HTMLElement) {
    if (!this.settings.showIdentity) return;
    const lines = this.identityLines.length > 0 ? this.identityLines : (this.brief?.identity?.rules ?? []);
    if (!lines.length) return;
    const strip = parent.createDiv({ cls: "morning-os-identity-strip" });
    strip.createDiv({ cls: "morning-os-identity-label", text: "I am someone who" });
    const rules = strip.createDiv({ cls: "morning-os-identity-rules" });
    for (const rule of lines) {
      renderMdContent(this.app, this, rules, "span", "morning-os-identity-rule", rule);
    }
  }

  private renderGoals(parent: HTMLElement) {
    if (!this.settings.showGoals) return;
    const goals = this.brief?.goals;
    if (!goals?.short_term?.length && !goals?.long_term?.length) return;
    const { short_term, long_term } = goals;
    const { short_term_count = 2, long_term_count = 2 } = this.brief?.meta?.goals ?? {};

    const stVisible = short_term.slice(0, short_term_count);
    const stHidden  = short_term.slice(short_term_count);
    const ltVisible = long_term.slice(0, long_term_count);
    const ltHidden  = long_term.slice(long_term_count);

    const wrap = parent.createDiv({ cls: "morning-os-goals-wrap" });

    const toggle = wrap.createDiv({ cls: "morning-os-goals-toggle" });
    toggle.createSpan({ cls: "morning-os-goals-toggle-label", text: "Goals" });
    toggle.addEventListener("click", () => wrap.toggleClass("is-open", !wrap.hasClass("is-open")));

    const preview = toggle.createDiv({ cls: "morning-os-goals-preview" });
    for (const item of stVisible)
      renderMdContent(this.app, this, preview, "span", "morning-os-goals-preview-pill morning-os-goals-pill-short", item);
    for (const item of ltVisible)
      renderMdContent(this.app, this, preview, "span", "morning-os-goals-preview-pill morning-os-goals-pill-long", item);

    const hasHidden = stHidden.length > 0 || ltHidden.length > 0;
    if (hasHidden)
      toggle.createSpan({ cls: "morning-os-goals-toggle-hint", text: `+${stHidden.length + ltHidden.length} more` });

    const panel = wrap.createDiv({ cls: "morning-os-goals-panel" });
    const grid = panel.createDiv({ cls: "morning-os-goals-grid" });

    const short = grid.createDiv({ cls: "morning-os-goals-col" });
    short.createEl("h2", { text: "Short-term" });
    const sl = short.createDiv({ cls: "morning-os-card" }).createEl("ul");
    for (const item of short_term) renderMdContent(this.app, this, sl, "li", "", item);

    const long = grid.createDiv({ cls: "morning-os-goals-col" });
    long.createEl("h2", { text: "Long-term" });
    const ll = long.createDiv({ cls: "morning-os-card" }).createEl("ul");
    for (const item of long_term) renderMdContent(this.app, this, ll, "li", "", item);
  }

  private renderFocus(parent: HTMLElement) {
    const section = parent.createDiv({ cls: "mos-focus-section" });
    const header = section.createDiv({ cls: "mos-section-header" });
    const focus = selectFocusTasks(this.registry);
    const active = this.activity.focusSessions.find(session => session.id === this.activity.activeSessionId);
    header.createEl("h2", { cls: "morning-os-section-heading", text: `Focus · ${focus.length}/3` });
    header.createSpan({ cls: "mos-section-note", text: `${formatDuration(getTodayFocusMinutes(this.activity))} today` });
    const standalone = header.createEl("button", { cls: "mos-btn", text: "+ Focus" });
    standalone.disabled = Boolean(active);
    standalone.setAttr("title", "Start a focus timer without linking it to a task or routine");
    standalone.addEventListener("click", () => new StandaloneFocusModal(this.app, async input => {
      await startFocusSession(this.app, input);
      await this.plugin.refreshView();
    }).open());
    const plan = header.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Plan my day" });
    plan.setAttr("title", "Build a reviewable execution order for Today");
    plan.addEventListener("click", () => void this.runAgentFeature("plan-day"));
    if (active) this.renderActiveSession(section, active);
    if (!focus.length) {
      section.createDiv({ cls: "morning-os-card morning-os-card-empty" }).createEl("p", { cls: "morning-os-empty-state", text: "Choose 1–3 ready Today tasks from the task menu." });
      return;
    }
    const card = section.createDiv({ cls: "morning-os-card mos-focus-card" });
    for (const [index, task] of focus.entries()) {
      const row = card.createDiv({ cls: "mos-focus-row" });
      row.createSpan({ cls: "mos-focus-order", text: String(task.focus_order) });
      const content = row.createDiv({ cls: "mos-focus-content" });
      renderMdContent(this.app, this, content, "span", "mos-focus-title", task.text);
      const metadata = [
        task.project,
        task.context,
        task.effort_minutes !== null ? formatDuration(task.effort_minutes) : "",
      ].filter(Boolean);
      if (metadata.length) content.createSpan({ cls: "mos-focus-meta", text: metadata.join(" · ") });
      if (task.progress) {
        const today = task.daily_progress_target?.date === todayStr() ? `${getTaskProgressToday(task)} / ${task.daily_progress_target.target} today · ` : "";
        content.createSpan({ cls: "mos-focus-meta", text: `${today}${task.progress.current} / ${task.progress.target} ${task.progress.unit ?? ""}`.trim() });
      }
      const controls = row.createDiv({ cls: "mos-focus-controls" });
      const start = controls.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Start" });
      start.disabled = Boolean(active);
      start.addEventListener("click", () => void startFocusSession(this.app, { title: task.text, taskId: task._id, projectId: task.project || undefined, routineId: task.routine_id ?? undefined, type: this.sessionType(task.context) }).then(() => this.plugin.refreshView()).catch(error => new Notice((error as Error).message)));
      const up = controls.createEl("button", { cls: "mos-focus-control", text: "↑", attr: { title: "Move up", "aria-label": `Move ${task.text} up` } });
      up.disabled = index === 0;
      up.addEventListener("click", () => void moveFocusTask(this.app, task._id, -1).then(() => this.plugin.refreshView()));
      const down = controls.createEl("button", { cls: "mos-focus-control", text: "↓", attr: { title: "Move down", "aria-label": `Move ${task.text} down` } });
      down.disabled = index === focus.length - 1;
      down.addEventListener("click", () => void moveFocusTask(this.app, task._id, 1).then(() => this.plugin.refreshView()));
      const remove = controls.createEl("button", { cls: "mos-focus-control mos-focus-remove", text: "Remove", attr: { title: "Remove from Focus only" } });
      remove.addEventListener("click", () => void updateTask(this.app, task._id, { focus_order: null }).then(() => this.plugin.refreshView()));
    }
  }

  private sessionType(context: string): FocusSession["type"] {
    const value = context.trim().toLowerCase();
    if (["deep", "deep-work", "deep work"].includes(value)) return "deep-work";
    if (["writing", "reading", "coding"].includes(value)) return value as FocusSession["type"];
    return "other";
  }

  private renderActiveSession(parent: HTMLElement, session: FocusSession): void {
    const card = parent.createDiv({ cls: "morning-os-card mos-active-session" });
    card.createSpan({ cls: "mos-active-label", text: session.status === "paused" ? "PAUSED" : "NOW" });
    const main = card.createDiv({ cls: "mos-active-main" });
    main.createSpan({ cls: "mos-active-title", text: session.title });
    const elapsed = main.createSpan({ cls: "mos-focus-elapsed", text: this.formatElapsed(elapsedMilliseconds(session)) });
    const controls = card.createDiv({ cls: "mos-active-controls" });
    const pause = controls.createEl("button", { cls: "mos-btn", text: session.status === "paused" ? "Resume" : "Pause" });
    pause.addEventListener("click", () => void (session.status === "paused" ? resumeFocusSession(this.app) : pauseFocusSession(this.app)).then(() => this.plugin.refreshView()));
    const finish = controls.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Finish" });
    const linkedTask = session.taskId ? this.registry.find(task => task._id === session.taskId) : undefined;
    const complete = async (note = "", progressValue?: number) => {
      const completed = await finishFocusSession(this.app, note);
      if (!completed) return;
      if (linkedTask?.progress && progressValue !== undefined && progressValue > 0) {
        const event = await logTaskProgress(this.app, this.settings, linkedTask._id, { mode: "add", value: progressValue, note, focusSessionId: completed.id, focusMinutes: completed.durationMinutes, timestamp: completed.endedAt, eventId: `progress-${completed.id}` });
        if (!event.dailyNoteWritten) new Notice("Progress saved. Daily Note Work Log is pending and will retry automatically.", 8000);
        else await markFocusSessionDailyNoteWritten(this.app, completed.id);
        await this.plugin.refreshView(); return;
      }
      if (completed?.routineId) {
        const routine = this.activity.routines.find(item => item.id === completed.routineId);
        if (routine?.metric === "count" && /read/i.test(routine.name)) {
          await this.plugin.refreshView();
          new ReadingLogModal(this.app, completed.id, async input => {
            const entry = await logReading(this.app, input);
            await appendWorkLogEvent(this.app, this.settings, { id: entry.id, date: entry.date, timestamp: completed.endedAt ?? new Date().toISOString(), title: entry.title, details: [`Reading: ${formatDuration(completed.durationMinutes ?? 0)}`, `Status: ${entry.level === "read" ? "Read" : "Skim"}`], note: entry.note });
            await markFocusSessionDailyNoteWritten(this.app, completed.id);
            await this.plugin.refreshView();
          }).open();
          return;
        }
      }
      await appendWorkLogEvent(this.app, this.settings, { id: completed.id, date: todayStr(), timestamp: completed.endedAt ?? new Date().toISOString(), title: completed.title, details: [`Focus: ${formatDuration(completed.durationMinutes ?? 0)}`], note });
      await markFocusSessionDailyNoteWritten(this.app, completed.id);
      await this.plugin.refreshView();
    };
    finish.addEventListener("click", () => linkedTask?.progress ? new FocusNoteModal(this.app, complete, linkedTask).open() : void complete());
    const finishWithNote = controls.createEl("button", { cls: "mos-btn", text: "Note & finish" });
    finishWithNote.addEventListener("click", () => new FocusNoteModal(this.app, complete, linkedTask).open());
    const discard = controls.createEl("button", { cls: "mos-btn", text: "Discard" });
    discard.addEventListener("click", () => void cancelFocusSession(this.app).then(() => this.plugin.refreshView()));
    if (this.timerTicker !== null) window.clearInterval(this.timerTicker);
    if (session.status === "active") this.timerTicker = window.setInterval(() => elapsed.setText(this.formatElapsed(elapsedMilliseconds(session))), 1000);
  }

  private formatElapsed(milliseconds: number): string {
    const seconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(seconds / 3600);
    return `${hours ? `${hours}:` : ""}${String(Math.floor((seconds % 3600) / 60)).padStart(hours ? 2 : 1, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  private renderRoutines(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "mos-routines-section" });
    const header = section.createDiv({ cls: "mos-section-header" });
    header.createEl("h2", { cls: "morning-os-section-heading", text: "Routines" });
    const add = header.createEl("button", { cls: "mos-btn", text: "+ Routine" });
    add.addEventListener("click", () => new RoutineCreateModal(this.app, async routine => { await createRoutine(this.app, routine); await this.plugin.refreshView(); }).open());
    const card = section.createDiv({ cls: "morning-os-card mos-routines-card" });
    const routines = this.activity.routines.filter(routine => routine.enabled);
    if (!routines.length) card.createEl("p", { cls: "morning-os-empty-state", text: "No active routines." });
    for (const routine of routines) {
      const row = card.createDiv({ cls: "mos-routine-row" });
      const copy = row.createDiv({ cls: "mos-routine-copy" });
      copy.createSpan({ cls: "mos-routine-title", text: routine.name });
      const value = getRoutineProgress(this.activity, routine);
      const unit = routine.unit ?? (routine.metric === "duration" ? "min" : "times");
      copy.createSpan({ cls: "mos-routine-meta", text: `${routine.cadence === "daily" ? "Today" : "This week"} · ${value} / ${routine.target} ${unit}${value >= routine.target ? " ✓" : ""}` });
      const progress = copy.createDiv({ cls: "mos-routine-progress" });
      progress.createDiv({ cls: "mos-routine-progress-fill", attr: { style: `width:${Math.min(100, (value / routine.target) * 100)}%` } });
      if (routine.metric === "count" && /read/i.test(routine.name) && this.activity.readingEntries.length) {
        const history = copy.createEl("details", { cls: "mos-reading-history" });
        history.createEl("summary", { text: "Recent reading history" });
        for (const entry of this.activity.readingEntries.slice(-5).reverse()) {
          history.createDiv({ text: `${entry.date} · ${entry.level === "read" ? "Read" : "Skim"} · ${entry.title}${entry.project ? ` · ${entry.project}` : ""}` });
        }
      }
      const controls = row.createDiv({ cls: "mos-routine-controls" });
      if (!(routine.metric === "count" && /read/i.test(routine.name))) {
        controls.createEl("button", { cls: "mos-btn", text: routine.metric === "duration" ? "Set time" : "Set progress" }).addEventListener("click", () => new RoutineProgressModal(this.app, routine, value, async (desired, note) => {
          const delta = desired - value;
          if (delta !== 0) await adjustRoutineProgress(this.app, routine.id, delta, note);
          await this.plugin.refreshView();
        }).open());
      }
      if (routine.metric === "count" && /read/i.test(routine.name)) {
        controls.createEl("button", { cls: "mos-btn", text: "Log paper" }).addEventListener("click", () => new ReadingLogModal(this.app, undefined, async input => {
          const entry = await logReading(this.app, input);
          await appendWorkLogEvent(this.app, this.settings, { id: entry.id, date: entry.date, timestamp: new Date().toISOString(), title: entry.title, details: [`Status: ${entry.level === "read" ? "Read" : "Skim"}`], note: entry.note });
          await this.plugin.refreshView();
        }).open());
      } else {
        controls.createEl("button", { cls: "mos-btn", text: "Log" }).addEventListener("click", () => new RoutineLogModal(this.app, routine, async (amount, note) => {
          const log = await logRoutine(this.app, routine.id, amount, note);
          await appendWorkLogEvent(this.app, this.settings, { id: log.id, date: log.date, timestamp: log.createdAt, title: routine.name, details: [`${routine.metric === "duration" ? "Duration" : "Progress"}: ${amount} ${routine.unit ?? ""}`], note });
          await this.plugin.refreshView();
        }).open());
      }
      const start = controls.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Start focus" });
      start.disabled = Boolean(this.activity.activeSessionId);
      start.addEventListener("click", () => void startFocusSession(this.app, { title: routine.name, projectId: routine.projectId ?? undefined, routineId: routine.id, type: /read/i.test(routine.name) ? "reading" : /writ/i.test(routine.name) ? "writing" : "other" }).then(() => this.plugin.refreshView()).catch(error => new Notice((error as Error).message)));
      controls.createEl("button", { cls: "mos-btn", text: "Edit" }).addEventListener("click", () => new RoutineEditModal(this.app, routine, async patch => { await updateRoutine(this.app, routine.id, patch); await this.plugin.refreshView(); }).open());
    }
  }

  private renderMorningPlanning(parent: HTMLElement) {
    const unfinished = selectUnfinishedTasks(this.registry);
    const suggested = selectSuggestedProjectActions(this.registry, this.projectStates);
    const continuable = selectContinuableProgressTasks(this.registry);
    const routineMinutes = getRemainingDailyRoutineMinutes(this.activity);
    if (!unfinished.length && !suggested.length && !continuable.length && !this.lastNightCandidate && routineMinutes === 0 && !this.workflowState.planning_completed_at) return;
    const details = parent.createEl("details", { cls: "mos-morning-planning" });
    if (!this.workflowState.planning_completed_at) details.setAttr("open", "");
    const summary = details.createEl("summary", { cls: "mos-planning-header" });
    summary.createEl("h2", { cls: "morning-os-section-heading", text: "Morning Planning" });
    const workload = selectWorkload(this.registry);
    summary.createSpan({ cls: "mos-planning-count", text: formatCombinedWorkloadSummary(workload, routineMinutes) });
    const content = details.createDiv({ cls: "mos-planning-content" });
    const assistantRow = content.createDiv({ cls: "mos-planning-ai-row" });
    assistantRow.createEl("button", { cls: "mos-btn", text: "Ask AI" }).addEventListener("click", () => {
      if (!this.hasApiKey()) { new Notice("Morning OS: configure an AI provider key first."); return; }
      new TaskAssistantModal(this.app, this.settings, this.registry, this.projectStates, this.activity, () => this.plugin.refreshView()).open();
    });
    const renderCandidate = (task: Task, label: string) => {
      const row = content.createDiv({ cls: "mos-planning-task-row" });
      renderMdContent(this.app, this, row, "span", "mos-planning-task-text", task.parent_id ? `↳ ${task.text}` : task.text);
      renderTaskMeta(row, task);
      const state = row.createEl("select", { cls: "mos-btn mos-btn-select" });
      for (const value of ["ready", "waiting", "blocked"] as const) {
        const option = state.createEl("option", { value, text: value }); option.selected = task.execution_state === value;
      }
      state.addEventListener("change", () => void applyMutations(this.app, [{ type: "set-execution-state", task_id: task._id, state: state.value as Task["execution_state"] }]).then(() => this.plugin.refreshView()));
      let dailyTarget: HTMLInputElement | null = null;
      if (task.progress) {
        dailyTarget = row.createEl("input", { type: "number", cls: "mos-progress-target-input", placeholder: "Today target" });
        dailyTarget.min = "1";
      }
      const add = row.createEl("button", { cls: "mos-btn mos-btn-primary", text: label });
      add.addEventListener("click", () => void (async () => {
        await applyMutations(this.app, [{ type: "move-to-today", task_id: task._id }]);
        if (task.progress && dailyTarget?.value) await setTaskDailyProgressTarget(this.app, task._id, Number(dailyTarget.value));
        await this.plugin.refreshView();
      })());
      if (task.planned_date) {
        const backlogBtn = row.createEl("button", { cls: "mos-btn", text: "Backlog" });
        backlogBtn.addEventListener("click", () => void applyMutations(this.app, [{ type: "move-to-backlog", task_id: task._id }]).then(() => this.plugin.refreshView()));
      }
    };
    if (this.lastNightCandidate) this.renderLastNightCandidate(content, this.lastNightCandidate);
    if (unfinished.length) {
      content.createEl("h3", { cls: "mos-planning-subheading", text: "Unfinished from previous days" });
      for (const task of unfinished) renderCandidate(task, "Keep Today");
    }
    if (suggested.length) {
      content.createEl("h3", { cls: "mos-planning-subheading", text: "Suggested next actions" });
      for (const suggestion of suggested) {
        const group = content.createDiv({ cls: "mos-planning-project-suggestion" });
        group.createSpan({ cls: "mos-planning-project-name", text: suggestion.project });
        const row = group.createDiv({ cls: "mos-planning-task-row" });
        renderMdContent(this.app, this, row, "span", "mos-planning-task-text", `→ ${suggestion.task.text}`);
        const add = row.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Add Today" });
        add.addEventListener("click", () => void applyMutations(this.app, [{ type: "move-to-today", task_id: suggestion.task._id }]).then(() => this.plugin.refreshView()));
        row.createEl("button", { cls: "mos-btn", text: "View project" }).addEventListener("click", () => this.viewProject(suggestion.project));
      }
    }
    if (continuable.length) {
      content.createEl("h3", { cls: "mos-planning-subheading", text: "Progress tasks ready for another daily target" });
      for (const task of continuable) renderCandidate(task, "Continue Today");
    }
    const complete = content.createEl("button", { cls: "mos-btn mos-btn-primary mos-planning-complete", text: this.workflowState.planning_completed_at ? "Planning complete ✓" : "Complete planning" });
    complete.addEventListener("click", () => void (async () => {
      if (!this.workflowState.planning_completed_at) {
        await writeMorningPlanSnapshot(this.app, this.settings, todayStr(), selectTodayTasks(this.registry), selectFocusTasks(this.registry));
        this.workflowState.planning_completed_at = new Date().toISOString();
      } else {
        this.workflowState.planning_completed_at = null;
      }
      await saveWorkflowState(this.app, this.workflowState); await this.plugin.refreshView();
    })());
  }

  private renderLastNightCandidate(parent: HTMLElement, task: Task): void {
    const block = parent.createDiv({ cls: "mos-last-night-task" });
    block.createEl("h3", { cls: "mos-planning-subheading", text: "First task from last night" });
    const row = block.createDiv({ cls: "mos-planning-task-row" });
    renderMdContent(this.app, this, row, "span", "mos-planning-task-text", `→ ${task.text}`);
    if (task.execution_state !== "ready") row.createSpan({ cls: `mos-meta-chip is-${task.execution_state}`, text: task.execution_state });
    const inToday = task.planned_date === todayStr();
    const inFocus = selectFocusTasks(this.registry).some(item => item._id === task._id);
    if (task.execution_state === "ready") {
      const start = row.createEl("button", { cls: "mos-btn mos-btn-primary", text: inFocus ? "Start" : "Start with this" });
      start.disabled = Boolean(this.activity.activeSessionId);
      start.addEventListener("click", () => void this.startLastNightCandidate(task));
    }
    const add = row.createEl("button", { cls: "mos-btn", text: inToday ? "Already in Today" : "Add to Today" });
    add.disabled = inToday;
    add.addEventListener("click", () => void applyMutations(this.app, [{ type: "move-to-today", task_id: task._id }]).then(() => this.plugin.refreshView()));
    row.createEl("button", { cls: "mos-btn", text: "Choose another" }).addEventListener("click", () => void (async () => {
      this.workflowState.dismissed_last_night_task_id = task._id;
      await saveWorkflowState(this.app, this.workflowState);
      this.lastNightCandidate = null;
      await this.plugin.refreshView();
    })());
  }

  private async startLastNightCandidate(task: Task): Promise<void> {
    if (task.execution_state !== "ready") return;
    if (task.planned_date !== todayStr()) await applyMutations(this.app, [{ type: "move-to-today", task_id: task._id }]);
    let registry = await loadRegistry(this.app);
    const focus = selectFocusTasks(registry);
    if (!focus.some(item => item._id === task._id) && focus.length < 3) {
      const used = new Set(focus.map(item => item.focus_order));
      const order = ([1, 2, 3] as const).find(value => !used.has(value));
      if (order) await applyMutations(this.app, [{ type: "set-focus", task_id: task._id, order }]);
      registry = await loadRegistry(this.app);
    }
    const fresh = registry.find(item => item._id === task._id) ?? task;
    await startFocusSession(this.app, { title: fresh.text, taskId: fresh._id, projectId: fresh.project || undefined, routineId: fresh.routine_id ?? undefined, type: this.sessionType(fresh.context) });
    await this.plugin.refreshView();
  }

  private viewProject(project: string): void {
    const state = this.projectStates.find(item => item.name === project);
    const tasks = selectProjectPlanningTasks(this.registry, project, state);
    new ProjectPlanningTasksModal(this.app, project, tasks, state, () => this.plugin.refreshView()).open();
  }

  private renderProjects(parent: HTMLElement) {
    const summaries = selectProjectSummaries(this.registry, this.projectStates);
    const section = parent.createDiv({ cls: "mos-projects-section" });
    const heading = section.createDiv({ cls: "mos-section-header" });
    heading.createEl("h2", { cls: "morning-os-section-heading", text: "Projects" });
    const addProject = heading.createEl("button", { cls: "mos-btn mos-btn-primary", text: "+ Project" });
    addProject.addEventListener("click", () => this.openProjectComposer());
    const addProjectTask = heading.createEl("button", { cls: "mos-btn", text: "+ Task" });
    addProjectTask.addEventListener("click", () => this.openProjectTaskComposer());
    const weekly = heading.createEl("button", { cls: "mos-btn", text: "Weekly review" });
    weekly.addEventListener("click", () => void this.runAgentFeature("weekly-review"));
    if (!summaries.length) {
      section.createDiv({ cls: "morning-os-card morning-os-card-empty", text: "No projects yet." });
      return;
    }
    for (const project of summaries) {
      const projectState = this.projectStates.find(item => item.name === project.name);
      const projectTasks = this.registry.filter(item => !item.is_deleted && item.status_completion === "open" && item.project === project.name);
      const details = section.createEl("details", { cls: "mos-project-health" });
      details.dataset.project = project.name;
      details.open = this.expandedProjects.has(project.name);
      details.addEventListener("toggle", () => {
        if (details.open) this.expandedProjects.add(project.name);
        else this.expandedProjects.delete(project.name);
      });
      const summary = details.createEl("summary", { cls: "mos-project-health-summary" });
      const main = summary.createDiv({ cls: "mos-project-health-main" });
      main.createEl("strong", { text: project.name });
      main.createSpan({ text: `${project.open_count} open · Today ${project.today_count}${project.blocked_count ? ` · Blocked ${project.blocked_count}` : ""}` });
      main.createSpan({ cls: "mos-project-next", text: project.next_action ? `Next → ${project.next_action}` : "No next action" });
      summary.createSpan({ cls: project.days_since_activity !== null && project.days_since_activity >= this.settings.projectStaleDays ? "mos-recency is-stale" : "mos-recency", text: formatRecency(project.days_since_activity, this.settings.projectStaleDays) });
      const body = details.createDiv({ cls: "morning-os-card mos-project-health-body" });
      const edit = body.createDiv({ cls: "mos-project-next-edit" });
      const manageProject = edit.createEl("button", { cls: "mos-btn", text: "Edit project" });
      manageProject.addEventListener("click", () => {
        const taskCount = this.registry.filter(item => !item.is_deleted && item.project === project.name).length;
        const routineCount = this.activity.routines.filter(item => item.projectId === project.name).length;
        new ProjectEditModal(this.app, project.name, taskCount, routineCount, async newName => {
          const result = await renameProject(this.app, project.name, newName);
          this.expandedProjects.delete(project.name);
          this.expandedProjects.add(newName.trim());
          new Notice(`Project renamed. Updated ${result.tasksUpdated} task${result.tasksUpdated === 1 ? "" : "s"} and ${result.routinesUpdated} routine${result.routinesUpdated === 1 ? "" : "s"}.`);
          await this.plugin.refreshView();
        }, async () => {
          const result = await deleteProject(this.app, project.name);
          this.expandedProjects.delete(project.name);
          new Notice(`Project deleted. Kept ${result.tasksUpdated} task${result.tasksUpdated === 1 ? "" : "s"} and ${result.routinesUpdated} routine${result.routinesUpdated === 1 ? "" : "s"} without a project.`);
          await this.plugin.refreshView();
        }).open();
      });
      const input = edit.createEl("input", { type: "text", cls: "morning-os-wins-input", placeholder: "Set project next action" });
      input.value = project.next_action;
      const save = edit.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Save" });
      save.addEventListener("click", () => void ensureProjectNextTask(this.app, project.name, input.value).then(() => this.plugin.refreshView()));
      const editNext = edit.createEl("button", { cls: "mos-btn", text: "Edit task" });
      editNext.addEventListener("click", () => void ensureProjectNextTask(this.app, project.name, input.value).then(task => {
        if (!task) { new Notice("Enter a Next task title first."); return; }
        new TaskEditModal(this.app, task, async updated => {
          const registry = await loadRegistry(this.app);
          const index = registry.findIndex(item => item._id === updated._id);
          if (index !== -1) registry[index] = updated;
          await saveRegistry(this.app, registry);
          await setProjectNextAction(this.app, project.name, updated.text, updated._id);
          await this.plugin.refreshView();
        }, false, this.plugin.settings.areas, this.plugin.settings.advancedAreaFeatures, this.settings).open();
      }));
      const review = edit.createEl("button", { cls: "mos-btn", text: "Review project" });
      review.addEventListener("click", () => void this.runAgentFeature("review-project", project.name));
      const add = edit.createEl("button", { cls: "mos-btn mos-btn-primary", text: "+ Add task" });
      add.addEventListener("click", () => this.openProjectTaskComposer(project.name));
      for (const task of projectTasks) {
        const row = body.createDiv({ cls: "mos-project-task-row" });
        const completeTask = row.createEl("input", { type: "checkbox" });
        completeTask.setAttr("aria-label", `Complete ${task.text}`);
        completeTask.addEventListener("change", () => {
          if (!completeTask.checked) return;
          completeTask.checked = false;
          requestTaskCompletion(this.app, this.settings, task, this.registry, () => this.plugin.refreshView());
        });
        renderMdContent(this.app, this, row, "span", "mos-project-task-text", task.parent_id ? `↳ ${task.text}` : task.text);
        renderTaskMeta(row, task);
        const editTask = row.createEl("button", { cls: "mos-btn mos-btn-inline", text: "Edit" });
        editTask.addEventListener("click", () => {
          new TaskEditModal(this.app, task, async updated => {
            const registry = await loadRegistry(this.app);
            const index = registry.findIndex(item => item._id === updated._id);
            if (index !== -1) registry[index] = updated;
            await saveRegistry(this.app, registry);
            if (projectState?.next_action_task_id === updated._id || (!projectState?.next_action_task_id && projectState?.next_action.trim() === task.text.trim())) {
              await setProjectNextAction(this.app, project.name, updated.text, updated._id);
            }
            await this.plugin.refreshView();
          }, false, this.plugin.settings.areas, this.plugin.settings.advancedAreaFeatures, this.settings).open();
        });
      }
    }
  }

  private openProjectTaskComposer(project = ""): void {
    const projectNames = [...new Set([
      ...this.registry.map(task => task.project.trim()).filter(Boolean),
      ...this.projectStates.map(state => state.name.trim()).filter(Boolean),
    ])].sort((left, right) => left.localeCompare(right));
    new ProjectTaskModal(this.app, projectNames, project, async task => {
      const registry = await loadRegistry(this.app);
      registry.push(task);
      await saveRegistry(this.app, registry);
      await this.plugin.refreshView();
    }).open();
  }

  private openProjectComposer(): void {
    new ProjectCreateModal(this.app, async (name, nextAction) => {
      await createProject(this.app, name);
      if (nextAction.trim()) await ensureProjectNextTask(this.app, name.trim(), nextAction);
      await this.plugin.refreshView();
    }).open();
  }

  private renderShutdown(parent: HTMLElement) {
    const section = parent.createDiv({ cls: "mos-shutdown-section" });
    const header = section.createDiv({ cls: "mos-section-header" });
    header.createEl("h2", { cls: "morning-os-section-heading", text: "Shutdown" });
    if (this.workflowState.closed_at) header.createSpan({ cls: "mos-section-note", text: "Day closed ✓" });
    const card = section.createDiv({ cls: "morning-os-card mos-shutdown-card" });
    card.createSpan({ cls: "mos-focus-summary", text: `Focused work today · ${formatDuration(getTodayFocusMinutes(this.activity))} · ${getSessionCount(this.activity, "today")} sessions` });
    card.createSpan({ cls: "mos-edit-label", text: "Still on my mind" });
    const thoughts = card.createEl("textarea", { cls: "morning-os-wins-input mos-shutdown-thoughts" });
    thoughts.value = this.workflowState.still_on_mind;
    card.createSpan({ cls: "mos-edit-label", text: "Tomorrow’s first task candidate" });
    const first = card.createEl("select", { cls: "mos-btn mos-btn-select" });
    first.createEl("option", { value: "", text: "Choose during shutdown" });
    for (const task of this.registry.filter(item => !item.is_deleted && item.status_completion === "open" && item.execution_state === "ready")) {
      const option = first.createEl("option", { value: task._id, text: task.text }); option.selected = task._id === this.workflowState.tomorrow_first_task_id;
    }
    const close = card.createEl("button", { cls: "mos-btn mos-btn-primary", text: this.workflowState.closed_at ? "Update shutdown" : "Close the day" });
    close.addEventListener("click", () => void (async () => {
      this.workflowState.still_on_mind = thoughts.value.trim();
      this.workflowState.tomorrow_first_task_id = first.value || null;
      this.workflowState.closed_at = new Date().toISOString();
      await saveWorkflowState(this.app, this.workflowState);
      const tomorrow = this.registry.find(task => task._id === this.workflowState.tomorrow_first_task_id)?.text;
      await writeShutdownSnapshot(this.app, this.settings, todayStr(), this.workflowState.still_on_mind, tomorrow);
      await this.plugin.refreshView();
    })());
  }

  private async runAgentFeature(feature: AgentFeature, project?: string): Promise<void> {
    if (!this.hasApiKey() && feature !== "plan-day") { new Notice("Morning OS: configure an AI provider key first."); return; }
    new Notice("Morning OS: preparing a reviewable proposal…");
    try {
      if (!this.hasApiKey() && feature === "plan-day") {
        new ProposalReviewModal(this.app, buildLocalPlanProposal(this.registry), this.registry, async mutations => {
          await applyMutations(this.app, mutations);
          await this.plugin.refreshView();
        }).open();
        return;
      }
      const proposal = await requestAgentProposal(this.app, feature, this.registry, this.projectStates, this.settings, project);
      new ProposalReviewModal(this.app, proposal, this.registry, async mutations => {
        await applyMutations(this.app, mutations);
        await this.plugin.refreshView();
      }).open();
    } catch (error) {
      if (feature === "plan-day") {
        const fallback = buildLocalPlanProposal(this.registry);
        new Notice(`Morning OS: AI plan unavailable — showing a local proposal instead. ${(error as Error).message.slice(0, 90)}`, 8000);
        new ProposalReviewModal(this.app, fallback, this.registry, async mutations => {
          await applyMutations(this.app, mutations);
          await this.plugin.refreshView();
        }).open();
        return;
      }
      new Notice(`Morning OS: proposal failed — ${(error as Error).message.slice(0, 140)}`);
    }
  }

  private renderTasks(parent: HTMLElement) {
    const today = todayStr();
    const workload = selectWorkload(this.registry, today);
    const routineMinutes = getRemainingDailyRoutineMinutes(this.activity, today);
    const workloadRow = parent.createDiv({ cls: "mos-workload-summary" });
    workloadRow.createEl("h2", { cls: "morning-os-section-heading", text: "Today" });
    workloadRow.createSpan({ text: formatCombinedWorkloadSummary(workload, routineMinutes) });
    workloadRow.createSpan({ text: `Deep work · ${formatDuration(workload.deep_work_minutes)} / ${formatDuration(this.settings.deepWorkCapacityMinutes)}` });
    // A subtask nests under its parent's row only when the parent is also in Today —
    // otherwise it would never render at all, since it's excluded from top-level lists.
    const nestsUnderParent = (t: Task): boolean => {
      if (t.parent_id === null) return false;
      const p = this.registry.find(x => x._id === t.parent_id);
      return !!p && !p.is_deleted && p.is_today;
    };
    const redOpen    = this.registry.filter(t => t.is_today && !t.is_deleted && !nestsUnderParent(t) && t.status_priority === "red" && t.status_completion !== "done");
    const regOpen    = this.registry.filter(t => t.is_today && !t.is_deleted && !nestsUnderParent(t) && t.status_priority === "regular" && t.status_completion !== "done");
    const redDone    = this.registry.filter(t => t.is_today && !t.is_deleted && !nestsUnderParent(t) && t.status_priority === "red" && t.status_completion === "done" && t.date_completed === today);
    const regDone    = this.registry.filter(t => t.is_today && !t.is_deleted && !nestsUnderParent(t) && t.status_priority === "regular" && t.status_completion === "done" && t.date_completed === today);

    if (!redOpen.length && !regOpen.length && !redDone.length && !regDone.length) {
      const empty = parent.createDiv({ cls: "morning-os-card morning-os-card-empty" });
      empty.createEl("p", { cls: "morning-os-empty-state", text: "You're all caught up for today." });
      empty.createEl("p", { cls: "morning-os-empty-state", text: "Add a task here or pick from the Inbox to get started." });
    } else {
      if (redOpen.length > 0 || redDone.length > 0) {
        parent.createEl("h2", { cls: "morning-os-section-heading morning-os-red-heading", text: "Red alert" });
        const card = parent.createDiv({ cls: "morning-os-card morning-os-card-red" });
        this.renderRegistryTaskList(card, redOpen);
        this.renderRegistryDoneList(card, redDone);
      }
      if (regOpen.length > 0 || regDone.length > 0) {
        parent.createEl("h2", { cls: "morning-os-section-heading", text: "Regular" });
        const card = parent.createDiv({ cls: "morning-os-card" });
        this.renderRegistryTaskList(card, regOpen);
        this.renderRegistryDoneList(card, regDone);
      }
    }

    renderAddTaskInput(parent, this.app, "Capture a task…", async (text) => {
      const task = createTask(text, { is_today: true, status_priority: "regular" });
      const reg = await loadRegistry(this.app);
      reg.push(task);
      await saveRegistry(this.app, reg);
      await this.plugin.autoRefreshBrief();
      this.plugin.refreshView();
    });
  }

  private renderRegistryTaskList(parent: HTMLElement, tasks: Task[]) {
    for (const task of tasks) {
      const children = getChildren(this.registry, task._id);
      const row = parent.createDiv({ cls: "morning-os-task-row" });

      let childListEl: HTMLElement | null = null;
      const ensureChildList = (): HTMLElement => {
        if (!childListEl) {
          childListEl = parent.createDiv({ cls: "mos-subtask-list" });
          if (collapsedTasks.has(task._id)) childListEl.addClass("is-collapsed");
        }
        return childListEl;
      };

      if (children.length > 0) {
        const toggleBtn = row.createEl("button", {
          cls: "mos-subtask-toggle",
          text: collapsedTasks.has(task._id) ? "▸" : "▾",
        });
        toggleBtn.addEventListener("click", () => {
          const collapsed = collapsedTasks.has(task._id);
          if (collapsed) collapsedTasks.delete(task._id); else collapsedTasks.add(task._id);
          toggleBtn.setText(collapsed ? "▾" : "▸");
          ensureChildList().toggleClass("is-collapsed", !collapsed);
        });
      }

      const checkbox = row.createEl("input", { type: "checkbox" });
      const textSpan = renderMdContent(this.app, this, row, "span", "morning-os-task-text", task.text);
      renderTaskMeta(row, task);
      attachInlineTextEdit(this.app, textSpan, task, () => this.plugin.refreshView());
      if (task.date_remind) {
        row.createSpan({ cls: "morning-os-reminder-badge", text: `⏰ ${task.date_remind}` });
      }
      if (task.notes?.trim() && this.plugin.settings.showNotesIndicator) {
        row.createSpan({ cls: "mos-notes-badge", attr: { title: "Has notes" }, text: "📝" });
      }

      const moreBtn = row.createEl("button", { cls: "mos-more-btn", text: "⋯" });
      moreBtn.addEventListener("click", () => {
        const flipPriority = task.status_priority === "red" ? "regular" : "red";
        const flipLabel = task.status_priority === "red" ? "→ Move to Regular" : "🔴 Move to Red alert";
        const menuItems: MenuAction[] = [];
        if (task.parent_id === null) {
          menuItems.push({
            label: "＋ Add subtask",
            action: () => {
              const list = ensureChildList();
              renderAddTaskInput(list, this.app, "Add subtask…", async (text) => {
                const child = createTask(text, { parent_id: task._id, areas: [...task.areas], tags: { ...task.tags } });
                const reg = await loadRegistry(this.app);
                reg.push(child);
                await saveRegistry(this.app, reg);
                this.plugin.refreshView();
              });
              list.querySelector<HTMLInputElement>(".morning-os-wins-input-row:last-child input")?.focus();
            },
          });
        }
        menuItems.push(
          ...([1, 2, 3] as const).map(order => ({ label: `Focus #${order}`, action: () => void applyMutations(this.app, [{ type: "set-focus", task_id: task._id, order }]).then(() => this.plugin.refreshView()) })),
          {
            label: flipLabel,
            action: () => {
              void updateTask(this.app, task._id, { status_priority: flipPriority }).then(async () => {
                await this.plugin.autoRefreshBrief();
                this.plugin.refreshView();
              });
            },
          },
          {
            label: "✕ Remove from today",
            action: () => {
              void (async () => {
                await updateTask(this.app, task._id, { is_today: false });
                await this.plugin.autoRefreshBrief();
                this.plugin.refreshView();
              })();
            },
          },
          {
            label: "✎ Edit metadata",
            action: () => {
              new TaskEditModal(this.app, task, async (updated) => {
                const reg = await loadRegistry(this.app);
                const idx = reg.findIndex(t => t._id === updated._id);
                if (idx !== -1) reg[idx] = updated;
                await saveRegistry(this.app, reg);
                this.plugin.refreshView();
              }, false, this.plugin.settings.areas, this.plugin.settings.advancedAreaFeatures, this.settings).open();
            },
          },
          {
            label: "🗑 Delete",
            danger: true,
            action: () => void deleteTask(this.app, task._id).then(() => this.plugin.refreshView()),
          },
        );
        openContextMenu(moreBtn, menuItems);
      });

      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          checkbox.checked = false;
          requestTaskCompletion(this.app, this.settings, task, this.registry, () => this.plugin.refreshView());
          return;
        }
        row.removeClass("morning-os-task-done");
        void setTaskStatus(this.app, task._id, "open").then(() => this.plugin.refreshView());
      });

      this.renderTaskProgress(parent, task);
      this.renderPipelineBar(parent, task);

      if (children.length > 0) {
        const list = ensureChildList();
        for (const child of children) {
          renderTaskRowShared(list, child, this.app, this, () => this.plugin.refreshView(), this.plugin, false, undefined, this.registry, true);
        }
      }
    }
  }

  private renderTaskProgress(parent: HTMLElement, task: Task): void {
    if (!task.progress) return;
    const progress = task.progress;
    const wrap = parent.createDiv({ cls: "mos-task-progress" });
    const daily = task.daily_progress_target?.date === todayStr() ? task.daily_progress_target : null;
    if (daily) wrap.createSpan({ text: `Today ${getTaskProgressToday(task)} / ${daily.target}${getTaskProgressToday(task) >= daily.target ? " ✓" : ""}` });
    wrap.createSpan({ text: `Overall ${progress.current} / ${progress.target} ${progress.unit ?? ""} · ${Math.round((progress.current / progress.target) * 100)}%` });
    const bar = wrap.createDiv({ cls: "mos-task-progress-bar" });
    bar.createDiv({ cls: "mos-task-progress-fill", attr: { style: `width:${Math.min(100, (progress.current / progress.target) * 100)}%` } });
    wrap.createEl("button", { cls: "mos-btn mos-btn-inline", text: "Log progress" }).addEventListener("click", () => new ProgressUpdateModal(this.app, task, async input => {
      const event = await logTaskProgress(this.app, this.settings, task._id, input);
      if (!event.dailyNoteWritten) new Notice("Progress saved. Daily Note Work Log is pending and will retry automatically.", 8000);
      await this.plugin.refreshView();
    }).open());
  }

  /** Segmented mini bar: Start → Working → Collecting → Complete. */
  private renderPipelineBar(parent: HTMLElement, task: Task): void {
    const currentIndex = task.pipeline_stage ? PIPELINE_STAGES.indexOf(task.pipeline_stage) : -1;
    const wrap = parent.createDiv({ cls: "mos-pipeline" });
    const bar = wrap.createDiv({ cls: "mos-pipeline-bar", attr: { role: "group", "aria-label": "Pipeline stage" } });
    PIPELINE_STAGES.forEach((stage, index) => {
      const seg = bar.createEl("button", {
        cls: "mos-pipeline-segment",
        attr: { title: PIPELINE_STAGE_TITLES[stage], "aria-label": PIPELINE_STAGE_TITLES[stage] },
      });
      if (index <= currentIndex) seg.addClass("is-filled");
      if (index === currentIndex) seg.addClass("is-active");
      seg.addEventListener("click", () => { void this.onPipelineStageClick(task, stage, index, currentIndex); });
    });
    wrap.createSpan({
      cls: "mos-pipeline-label",
      text: currentIndex >= 0 ? PIPELINE_STAGE_LABELS[PIPELINE_STAGES[currentIndex]] : "Not started",
    });
  }

  private async onPipelineStageClick(task: Task, stage: PipelineStage, index: number, currentIndex: number): Promise<void> {
    if (stage === "complete" && task.status_completion !== "done") {
      // The final segment means "finish the task" — route through the normal
      // completion flow (note modal, subtask/progress guards) instead of
      // silently flipping a flag.
      requestTaskCompletion(this.app, this.settings, task, this.registry, () => this.plugin.refreshView());
      return;
    }
    // Clicking the active first segment again resets to "not started".
    const next = index === currentIndex && stage === "start" ? null : stage;
    if (next === (task.pipeline_stage ?? null)) return;
    await setPipelineStage(this.app, task._id, next);
    this.plugin.refreshView();
  }

  /** Summary card: every Today task currently somewhere in the pipeline. */
  private renderPipelineBoard(parent: HTMLElement): void {
    const inFlight = this.registry.filter(t =>
      t.is_today && !t.is_deleted && t.status_completion !== "done" &&
      t.pipeline_stage !== null && t.pipeline_stage !== undefined && t.pipeline_stage !== "complete"
    );
    if (!inFlight.length) return;

    parent.createEl("h2", { cls: "morning-os-section-heading", text: `In flight · ${inFlight.length}` });
    const card = parent.createDiv({ cls: "morning-os-card mos-pipeline-board" });

    const counts = card.createDiv({ cls: "mos-pipeline-counts" });
    for (const stage of PIPELINE_STAGES) {
      const n = inFlight.filter(t => t.pipeline_stage === stage).length;
      if (n > 0) counts.createSpan({ cls: `mos-pipeline-count mos-pipeline-count-${stage}`, text: `${PIPELINE_STAGE_LABELS[stage]} · ${n}` });
    }

    const stageRank = (t: Task): number => PIPELINE_STAGES.indexOf(t.pipeline_stage ?? "start");
    for (const task of [...inFlight].sort((a, b) => stageRank(b) - stageRank(a))) {
      const row = card.createDiv({ cls: "mos-pipeline-board-row" });
      renderMdContent(this.app, this, row, "span", "morning-os-task-text", task.text);
      if (task.project) row.createSpan({ cls: "mos-pipeline-board-project", text: task.project });
      this.renderPipelineBar(row, task);
    }
  }

  private renderRegistryDoneList(parent: HTMLElement, tasks: Task[]) {
    for (const task of tasks) {
      const children = getChildren(this.registry, task._id);
      const row = parent.createDiv({ cls: "morning-os-task-row morning-os-task-done" });

      let childListEl: HTMLElement | null = null;
      const ensureChildList = (): HTMLElement => {
        if (!childListEl) {
          childListEl = parent.createDiv({ cls: "mos-subtask-list" });
          if (collapsedTasks.has(task._id)) childListEl.addClass("is-collapsed");
        }
        return childListEl;
      };

      if (children.length > 0) {
        const toggleBtn = row.createEl("button", {
          cls: "mos-subtask-toggle",
          text: collapsedTasks.has(task._id) ? "▸" : "▾",
        });
        toggleBtn.addEventListener("click", () => {
          const collapsed = collapsedTasks.has(task._id);
          if (collapsed) collapsedTasks.delete(task._id); else collapsedTasks.add(task._id);
          toggleBtn.setText(collapsed ? "▾" : "▸");
          ensureChildList().toggleClass("is-collapsed", !collapsed);
        });
      }

      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = true;
      const textSpan = renderMdContent(this.app, this, row, "span", "morning-os-task-text", task.text);
      renderTaskMeta(row, task);
      attachInlineTextEdit(this.app, textSpan, task, () => this.plugin.refreshView());
      if (task.notes?.trim() && this.plugin.settings.showNotesIndicator) {
        row.createSpan({ cls: "mos-notes-badge", attr: { title: "Has notes" }, text: "📝" });
      }
      checkbox.addEventListener("change", () => {
        if (checkbox.checked && this.plugin.settings.requireSubtasksComplete && hasOpenChildren(this.registry, task._id)) {
          checkbox.checked = false;
          new Notice("Morning OS: Complete all subtasks first");
          return;
        }
        row.toggleClass("morning-os-task-done", checkbox.checked);
        void setTaskStatus(this.app, task._id, checkbox.checked ? "done" : "open")
          .then(() => this.plugin.refreshView());
      });

      if (children.length > 0) {
        const list = ensureChildList();
        for (const child of children) {
          renderTaskRowShared(list, child, this.app, this, () => this.plugin.refreshView(), this.plugin, false, undefined, this.registry, true);
        }
      }
    }
  }

  private renderTacticalRules(parent: HTMLElement) {
    if (!this.settings.showRulesForToday) return;
    const hasTasks = this.registry.some(t => t.is_today && !t.is_deleted && t.status_completion !== "done");
    if (!hasTasks || !this.brief?.tactical_rules?.length) return;
    parent.createEl("h2", { cls: "morning-os-section-heading", text: "Rules for today" });
    const card = parent.createDiv({ cls: "morning-os-card morning-os-card-rules" });
    const list = card.createEl("ul");
    for (const rule of this.brief.tactical_rules) {
      renderMdContent(this.app, this, list, "li", "", rule);
    }
  }

  private renderSuggestion(parent: HTMLElement) {
    if (!this.settings.showSuggestions) return;
    if (!this.brief?.suggestions?.length) return;
    parent.createEl("h2", { cls: "morning-os-section-heading", text: "Suggestions" });
    this.brief.suggestions.forEach((s, i) => {
      const card = parent.createDiv({ cls: "morning-os-card morning-os-suggestion-card" });
      renderMdContent(this.app, this, card, "p", "morning-os-suggestion-text", s.text);

      const footer = card.createDiv({ cls: "morning-os-suggestion-footer" });
      const sourceLabel: Record<string, string> = {
        tasks: "Today's Tasks",
        goals: "Goals",
        technical_backlog: "Technical Backlog",
        carried_tasks: "Carried Tasks",
        wins: "Yesterday's Wins",
      };
      footer.createSpan({ cls: "morning-os-suggestion-source", text: sourceLabel[s.source] ?? s.source });

      const reactions = footer.createDiv({ cls: "morning-os-suggestion-reactions" });
      const thumbUp = reactions.createEl("button", { cls: "morning-os-reaction-btn", text: "👍" });
      const thumbDown = reactions.createEl("button", { cls: "morning-os-reaction-btn", text: "👎" });

      if (this.suggestionReactions[i] === "up") thumbUp.addClass("morning-os-reaction-active");
      if (this.suggestionReactions[i] === "down") thumbDown.addClass("morning-os-reaction-active");

      thumbUp.addEventListener("click", () => {
        const next = this.suggestionReactions[i] === "up" ? null : "up";
        this.suggestionReactions[i] = next;
        thumbUp.toggleClass("morning-os-reaction-active", next === "up");
        thumbDown.removeClass("morning-os-reaction-active");
        void this.writeSuggestionReactions();
      });

      thumbDown.addEventListener("click", () => {
        const next = this.suggestionReactions[i] === "down" ? null : "down";
        this.suggestionReactions[i] = next;
        thumbDown.toggleClass("morning-os-reaction-active", next === "down");
        thumbUp.removeClass("morning-os-reaction-active");
        void this.writeSuggestionReactions();
      });
    });
  }

  private async writeSuggestionReactions() {
    const today = todayStr();
    const dir = `${this.settings.feedbackDir}/reactions`;
    const filePath = `${dir}/${today}.json`;
    const payload = JSON.stringify(
      { date: today, suggestion_reactions: this.suggestionReactions },
      null, 2
    );
    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, payload);
    } else {
      try { await this.app.vault.createFolder(dir); } catch { /* intentional — dir may already exist */ }
      await this.app.vault.create(filePath, payload);
    }
  }

  private renderReminders(parent: HTMLElement) {
    const reminders = getActiveReminders(this.registry);
    if (!reminders.length) return;

    parent.createEl("h2", { cls: "morning-os-section-heading", text: "Reminders" });
    const card = parent.createDiv({ cls: "morning-os-card" });

    for (const task of reminders) {
      const row = card.createDiv({ cls: "morning-os-task-row" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      const textSpan = renderMdContent(this.app, this, row, "span", "morning-os-task-text", task.text);
      textSpan.addEventListener("dblclick", () => {
        const input = createEl("input");
        input.type = "text";
        input.value = task.text;
        input.className = "morning-os-wins-input mos-inline-edit";
        textSpan.replaceWith(input);
        attachTaskTextSuggest(this.app, input);
        input.focus();
        let saving = false;
        const save = async () => {
          if (saving) return;
          saving = true;
          const newText = input.value.trim();
          if (newText && newText !== task.text) {
            const reg = await loadRegistry(this.app);
            const idx = reg.findIndex(t => t._id === task._id);
            if (idx !== -1) { reg[idx].text = newText; reg[idx].date_modified = todayStr(); }
            await saveRegistry(this.app, reg);
            this.plugin.refreshView();
          } else {
            input.replaceWith(textSpan);
          }
        };
        input.addEventListener("blur", () => { void save(); });
        input.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") input.replaceWith(textSpan);
        });
      });
      row.createSpan({ cls: "morning-os-reminder-badge", text: `⏰ ${task.date_remind}` });

      // Dismiss = clear remind date (task stays open)
      const dismissBtn = row.createEl("button", { cls: "mos-task-action-btn mos-task-action-delete", text: "🗑" });
      dismissBtn.setAttribute("aria-label", "Dismiss reminder");
      dismissBtn.addEventListener("click", () => {
        row.remove();
        void updateTask(this.app, task._id, { date_remind: null }).then(() => this.plugin.refreshView());
      });

      // Done = mark task done
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          checkbox.checked = false;
          requestTaskCompletion(this.app, this.settings, task, this.registry, () => this.plugin.refreshView());
        }
      });
    }
  }

  private renderHobbyTasks(parent: HTMLElement) {
    if (!this.brief?.hobby_tasks?.length) return;
    const section = parent.createDiv({ cls: "morning-os-hobby" });
    section.createEl("h2", { cls: "morning-os-section-heading", text: "Hobby tasks" });
    const card = section.createDiv({ cls: "morning-os-card morning-os-hobby-card" });
    const list = card.createEl("ul", { cls: "morning-os-hobby-list" });
    for (const item of this.brief.hobby_tasks ?? []) {
      renderMdContent(this.app, this, list, "li", "", item);
    }
  }

  private renderWins(parent: HTMLElement) {
    const section = parent.createDiv({ cls: "morning-os-wins" });
    section.createEl("h2", { cls: "morning-os-section-heading morning-os-green-heading", text: "Wins today" });
    const card = section.createDiv({ cls: "morning-os-card morning-os-card-wins" });

    const list = card.createDiv({ cls: "morning-os-wins-list" });
    this.renderWinsList(list);

    const inputRow = card.createDiv({ cls: "morning-os-wins-input-row" });
    const input = inputRow.createEl("input", {
      type: "text",
      cls: "morning-os-wins-input",
      placeholder: "Add a win...",
    });
    const addBtn = inputRow.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Add" });

    const addWin = async () => {
      const text = input.value.trim();
      if (!text) return;
      await this.appendWinToNote(text);
      this.wins.push(text);
      input.value = "";
      list.empty();
      this.renderWinsList(list);
    };

    addBtn.addEventListener("click", () => { void addWin(); });
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") void addWin();
    });
  }

  private renderWinsList(parent: HTMLElement) {
    if (this.wins.length === 0) {
      parent.createEl("p", { cls: "morning-os-empty-state", text: "Fill this before sleep." });
    } else {
      for (const win of this.wins) {
        renderMdContent(this.app, this, parent, "p", "morning-os-wins-item", win);
      }
    }
  }

  private async appendWinToNote(winText: string) {
    await appendWinToLog(winText, todayStr(), this.app, this.settings);
  }

  private renderWhatsNew(parent: HTMLElement) {
    const manifest = this.plugin.manifest;
    if (manifest.version === this.settings.lastSeenVersion) return;

    const entry = parseChangelog(changelogText, manifest.version);
    if (!entry) return;

    const banner = parent.createDiv({ cls: "mos-whats-new-banner" });

    const top = banner.createDiv({ cls: "mos-whats-new-top" });
    const label = top.createSpan({ cls: "mos-whats-new-label" });
    label.createSpan({ cls: "mos-whats-new-badge", text: `v${entry.version}` });
    label.createSpan({ text: " What's new" });
    const dismissBtn = top.createEl("button", { cls: "mos-whats-new-dismiss", text: "Got it ✓" });

    for (const section of entry.sections) {
      banner.createDiv({ cls: "mos-whats-new-section-heading", text: section.heading });
      if (section.heading.toLowerCase() === "personal") {
        // Personal note renders as paragraphs, not a list
        for (const item of section.items) {
          banner.createEl("p", { cls: "mos-whats-new-note", text: item });
        }
      } else {
        const list = banner.createEl("ul", { cls: "mos-whats-new-list" });
        for (const item of section.items) {
          list.createEl("li", { text: item });
        }
      }
    }

    dismissBtn.addEventListener("click", () => {
      void (async () => {
        this.settings.lastSeenVersion = manifest.version;
        await this.plugin.saveData(this.plugin.settings);
        banner.remove();
      })();
    });
  }

  private renderFeedbackFooter(parent: HTMLElement) {
    const card = parent.createDiv({ cls: "mos-feedback-card" });

    const left = card.createDiv({ cls: "mos-feedback-text" });
    left.createDiv({ cls: "mos-feedback-title", text: "Share your thoughts" });
    left.createDiv({ cls: "mos-feedback-sub", text: "What's working? What's missing?" });

    const btn = card.createEl("button", { cls: "mos-feedback-btn", text: "Give feedback →" });
    btn.addEventListener("click", () => new FeedbackModal(this.app).open());
  }

  private daysBetween(dateStr: string, todayStr: string): number {
    const d1 = new Date(dateStr + "T00:00:00");
    const d2 = new Date(todayStr + "T00:00:00");
    return Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
  }
}

function mountFloatingPanel(container: HTMLElement, plugin: MorningOSPlugin): { handle: HTMLElement; actions: HTMLElement; cleanup: () => void } {
  const handle = container.createDiv({ cls: "morning-os-floating-handle" });
  const actions = container.createDiv({ cls: "morning-os-floating-actions" });

  const show = () => actions.addClass("is-visible");
  const hide = () => actions.removeClass("is-visible");

  handle.addEventListener("mouseenter", show);
  actions.addEventListener("mouseleave", hide);
  handle.addEventListener("touchstart", (e: TouchEvent) => { e.preventDefault(); show(); }, { passive: false });
  const touchHandler = (e: TouchEvent) => {
    if (!handle.contains(e.target as Node) && !actions.contains(e.target as Node)) hide();
  };
  activeDocument.addEventListener("touchstart", touchHandler);
  const cleanup = () => activeDocument.removeEventListener("touchstart", touchHandler);

  actions.createDiv({ cls: "morning-os-fab-label", text: "Agent" });
  const refreshBtn = actions.createEl("button", { cls: "morning-os-fab" });
  refreshBtn.appendChild(sanitizeHTMLToDom(`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`));
  refreshBtn.appendText(" Refresh brief");
  refreshBtn.addEventListener("click", () => { void plugin.triggerRefresh(); });

  const runBtn = actions.createEl("button", { cls: "morning-os-fab" });
  runBtn.appendChild(sanitizeHTMLToDom(`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polygon points="10 8 16 12 10 16 10 8"></polygon></svg>`));
  runBtn.appendText(" Run agent");
  runBtn.addEventListener("click", () => { void plugin.triggerAgent(); });

  actions.createDiv({ cls: "morning-os-fab-label", text: "Views" });
  for (const item of buildNavItems(plugin.settings.areas)) {
    const btn = actions.createEl("button", { cls: "morning-os-fab morning-os-fab-view", text: item.label });
    btn.addEventListener("click", () => {
      hide();
      if (item.id === "home")  void plugin.activateView();
      else if (item.id === "dump")  void plugin.activateDump();
      else if (item.id === "trash") void plugin.activateTrash();
      else void plugin.activateArea(item.id);
    });
  }

  return { handle, actions, cleanup };
}

type FilterState = {
  priority?: "red" | "regular";
  urgency?: "none" | "low" | "med" | "high";
  remind?: "has" | "due";
  status?: "open" | "done" | "dismissed";
  custom?: Record<string, string>;
};

function applyFilters(tasks: Task[], filters: FilterState): Task[] {
  const today = todayStr();
  return tasks.filter(t => {
    if (filters.priority && t.status_priority !== filters.priority) return false;
    if (filters.urgency && t.status_urgency !== filters.urgency) return false;
    if (filters.remind === "has" && !t.date_remind) return false;
    if (filters.remind === "due" && !(t.date_remind && t.date_remind <= today)) return false;
    if (filters.status && t.status_completion !== filters.status) return false;
    if (filters.custom) {
      for (const [key, val] of Object.entries(filters.custom)) {
        if (val && t.tags[key] !== val) return false;
      }
    }
    return true;
  });
}

function renderFilterSelects(
  parent: HTMLElement,
  filters: FilterState,
  onChange: (f: FilterState) => void,
  showUrgency = false,
  tabFields?: FieldDef[]
) {
  const mkSelect = (
    opts: { value: string; label: string }[],
    current: string | undefined,
    onchange: (v: string) => void
  ) => {
    const sel = parent.createEl("select", { cls: "mos-btn mos-btn-select mos-filter-select" });
    for (const o of opts) {
      const opt = sel.createEl("option", { value: o.value, text: o.label });
      if ((current ?? "") === o.value) opt.selected = true;
    }
    sel.addEventListener("change", () => onchange(sel.value));
  };

  mkSelect(
    [{ value: "", label: "Priority: All" }, { value: "red", label: "🔴 Red" }, { value: "regular", label: "Regular" }],
    filters.priority,
    v => onChange({ ...filters, priority: v as FilterState["priority"] || undefined })
  );

  mkSelect(
    [{ value: "", label: "Status: All" }, { value: "open", label: "Open" }, { value: "done", label: "Done" }, { value: "dismissed", label: "Dismissed" }],
    filters.status,
    v => onChange({ ...filters, status: v as FilterState["status"] || undefined })
  );

  if (showUrgency) {
    mkSelect(
      [{ value: "", label: "Urgency: All" }, { value: "none", label: "—" }, { value: "low", label: "Low" }, { value: "med", label: "Med" }, { value: "high", label: "High" }],
      filters.urgency,
      v => onChange({ ...filters, urgency: v as FilterState["urgency"] || undefined })
    );
  }

  mkSelect(
    [{ value: "", label: "Remind: All" }, { value: "has", label: "Has reminder" }, { value: "due", label: "Due today" }],
    filters.remind,
    v => onChange({ ...filters, remind: v as FilterState["remind"] || undefined })
  );

  // Custom field filters (dropdown fields only)
  if (tabFields?.length) {
    for (const field of tabFields) {
      if (field.type === "dropdown" && field.options?.length) {
        const opts = [{ value: "", label: `${field.label}: All` }, ...field.options.map(o => ({ value: o, label: o }))];
        const currentCustom = filters.custom?.[field.key];
        mkSelect(opts, currentCustom, v => {
          const custom = { ...(filters.custom ?? {}) };
          if (v) custom[field.key] = v;
          else delete custom[field.key];
          onChange({ ...filters, custom: Object.keys(custom).length > 0 ? custom : undefined });
        });
      }
    }
  }
}


type SortField = "date_created" | "date_modified" | "date_completed" | "name";
type SortDir = "asc" | "desc";

function sortTasks(tasks: Task[], field: SortField, dir: SortDir): Task[] {
  return [...tasks].sort((a, b) => {
    const va = field === "name" ? a.text : (a[field] ?? "");
    const vb = field === "name" ? b.text : (b[field] ?? "");
    if (va < vb) return dir === "asc" ? -1 : 1;
    if (va > vb) return dir === "asc" ? 1 : -1;
    return 0;
  });
}

const URGENCY_DOT: Record<string, string> = { low: "#3fb950", med: "#c9a84c", high: "#e5534b", none: "transparent" };
const URGENCY_LABEL: Record<string, string> = { low: "L", med: "M", high: "H", none: "" };

type MenuAction = { label: string; danger?: boolean; action: () => void };

function openContextMenu(anchor: HTMLElement, items: MenuAction[]) {
  document.querySelector(".mos-ctx-menu")?.remove();
  const menu = document.body.createDiv({ cls: "mos-ctx-menu" });
  const rect = anchor.getBoundingClientRect();
  menu.setCssStyles({
    position: "fixed",
    top: `${rect.bottom + 4}px`,
    left: `${rect.left}px`,
    zIndex: "9999",
  });

  for (const item of items) {
    const btn = menu.createEl("button", {
      cls: "mos-ctx-item" + (item.danger ? " mos-ctx-item-danger" : ""),
      text: item.label,
    });
    btn.addEventListener("click", () => { menu.remove(); item.action(); });
  }

  const close = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) { menu.remove(); document.removeEventListener("mousedown", close); }
  };
  document.addEventListener("mousedown", close);
}

function attachInlineTextEdit(app: App, textSpan: HTMLElement, task: Task, onSaved: () => void) {
  textSpan.addEventListener("dblclick", () => {
    const input = createEl("input");
    input.type = "text";
    input.value = task.text;
    input.className = "morning-os-wins-input mos-inline-edit";
    textSpan.replaceWith(input);
    attachTaskTextSuggest(app, input);
    input.focus();
    let saving = false;
    const save = async () => {
      if (saving) return;
      saving = true;
      const newText = input.value.trim();
      if (newText && newText !== task.text) {
        const reg = await loadRegistry(app);
        const idx = reg.findIndex(t => t._id === task._id);
        if (idx !== -1) { reg[idx].text = newText; reg[idx].date_modified = todayStr(); }
        await saveRegistry(app, reg);
        onSaved();
      } else {
        input.replaceWith(textSpan);
      }
    };
    input.addEventListener("blur", () => { void save(); });
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") void save();
      if (e.key === "Escape") input.replaceWith(textSpan);
    });
  });
}

// Tracks which parent tasks have their subtask list collapsed. Module-level so the
// collapsed/expanded state survives the full re-render every refresh triggers.
const collapsedTasks = new Set<string>();

const EISENHOWER_LABELS: Record<string, string> = {
  important_not_urgent: "重要不紧急",
  urgent_not_important: "紧急不重要",
  urgent_important: "紧急且重要",
};

function renderTaskMeta(parent: HTMLElement, task: Task): void {
  if (task.project) parent.createSpan({ cls: "mos-meta-chip mos-task-project-badge", text: task.project });
  const priority = EISENHOWER_LABELS[task.eisenhower_priority];
  if (priority) parent.createSpan({ cls: "mos-meta-chip mos-task-priority-badge", text: priority });
  if (task.effort_minutes !== null) parent.createSpan({ cls: "mos-meta-chip", text: formatDuration(task.effort_minutes) });
  if (task.context) parent.createSpan({ cls: "mos-meta-chip", text: task.context });
  if (task.execution_state !== "ready") parent.createSpan({ cls: `mos-meta-chip is-${task.execution_state}`, text: task.execution_state });
}

function renderTaskRowShared(
  parent: HTMLElement,
  task: Task,
  app: App,
  component: Component,
  onRefresh: () => void,
  plugin?: MorningOSPlugin,
  showUrgency = false,
  tabFields?: FieldDef[],
  registry: TaskRegistry = [],
  isChild = false
) {
  const isDone = task.status_completion === "done";
  const hasChildren = !isChild && getChildren(registry, task._id).length > 0;
  const row = parent.createDiv({ cls: "morning-os-task-row" + (isDone ? " morning-os-task-done" : "") + (isChild ? " mos-task-row-child" : "") });

  if (hasChildren) {
    const toggleBtn = row.createEl("button", {
      cls: "mos-subtask-toggle",
      text: collapsedTasks.has(task._id) ? "▸" : "▾",
    });
    toggleBtn.addEventListener("click", () => {
      const collapsed = collapsedTasks.has(task._id);
      if (collapsed) collapsedTasks.delete(task._id); else collapsedTasks.add(task._id);
      toggleBtn.setText(collapsed ? "▾" : "▸");
      ensureChildList().toggleClass("is-collapsed", !collapsed);
    });
  }

  const checkbox = row.createEl("input", { type: "checkbox" });
  checkbox.checked = isDone;

  // Urgency dot
  const dot = row.createSpan({ cls: "mos-urgency-dot", attr: { title: `Urgency: ${task.status_urgency}` } });
  dot.style.background = URGENCY_DOT[task.status_urgency] ?? URGENCY_DOT.none;
  dot.textContent = URGENCY_LABEL[task.status_urgency] ?? "";

  // Inline text — double-click to edit
  const textSpan = renderMdContent(app, component, row, "span", "morning-os-task-text", task.text);
  renderTaskMeta(row, task);
  attachInlineTextEdit(app, textSpan, task, onRefresh);

  if (task.date_remind) {
    row.createSpan({ cls: "morning-os-reminder-badge", text: `⏰ ${task.date_remind}` });
  }

  if (task.notes?.trim() && (plugin?.settings.showNotesIndicator ?? true)) {
    row.createSpan({ cls: "mos-notes-badge", attr: { title: "Has notes" }, text: "📝" });
  }

  // Meta field chips (area tab context only)
  if (tabFields?.length) {
    const chipRow = row.createSpan({ cls: "mos-task-meta-chips" });
    for (const field of tabFields) {
      const val = task.tags[field.key];
      if (val) {
        const chip = chipRow.createSpan({ cls: "mos-meta-chip" });
        chip.createSpan({ text: `${field.label}: ` });
        renderMdContent(app, component, chip, "span", "", val);
      }
    }
  }

  // Action buttons — today regular, today red alert, ⋯ menu
  const actions = row.createDiv({ cls: "mos-task-action-bar" });

  actions.createEl("button", { cls: "mos-action-btn", attr: { title: "→ Today (Regular)" }, text: "›" })
    .addEventListener("click", () => {
      void moveTaskToToday(app, task._id, "regular").then(async () => {
        if (plugin) { await plugin.autoRefreshBrief(); plugin.refreshView(); }
        onRefresh();
      });
    });

  actions.createEl("button", { cls: "mos-action-btn mos-action-btn-red", attr: { title: "→ Today (Red alert)" }, text: "»" })
    .addEventListener("click", () => {
      void moveTaskToToday(app, task._id, "red").then(async () => {
        if (plugin) { await plugin.autoRefreshBrief(); plugin.refreshView(); }
        onRefresh();
      });
    });

  let childListEl: HTMLElement | null = null;
  const ensureChildList = (): HTMLElement => {
    if (!childListEl) {
      childListEl = parent.createDiv({ cls: "mos-subtask-list" });
      if (collapsedTasks.has(task._id)) childListEl.addClass("is-collapsed");
    }
    return childListEl;
  };

  const moreBtn = actions.createEl("button", { cls: "mos-action-btn", attr: { title: "More actions" }, text: "⋯" });
  moreBtn.addEventListener("click", () => {
    const menuItems: MenuAction[] = [];
    if (!isChild) {
      menuItems.push({
        label: "＋ Add subtask",
        action: () => {
          const list = ensureChildList();
          renderAddTaskInput(list, app, "Add subtask…", async (text) => {
            const child = createTask(text, { parent_id: task._id, areas: [...task.areas], tags: { ...task.tags } });
            const reg = await loadRegistry(app);
            reg.push(child);
            await saveRegistry(app, reg);
            if (plugin) plugin.refreshView();
            onRefresh();
          });
          list.querySelector<HTMLInputElement>(".morning-os-wins-input-row:last-child input")?.focus();
        },
      });
    }
    menuItems.push(
      {
        label: "✎ Edit metadata",
        action: () => {
          new TaskEditModal(app, task, async (updated) => {
            const reg = await loadRegistry(app);
            const idx = reg.findIndex(t => t._id === updated._id);
            if (idx !== -1) reg[idx] = updated;
            await saveRegistry(app, reg);
            if (plugin) plugin.refreshView();
            onRefresh();
          }, showUrgency, plugin?.settings.areas ?? [], plugin?.settings.advancedAreaFeatures ?? false, plugin?.settings).open();
        },
      },
      {
        label: "🗑 Delete",
        danger: true,
        action: () => {
          void deleteTask(app, task._id).then(() => {
            if (plugin) plugin.refreshView();
            onRefresh();
          });
        },
      },
    );
    openContextMenu(moreBtn, menuItems);
  });

  checkbox.addEventListener("change", () => {
    if (checkbox.checked && !isDone && plugin) {
      checkbox.checked = false;
      requestTaskCompletion(app, plugin.settings, task, registry, () => plugin.refreshView());
      return;
    }
    row.toggleClass("morning-os-task-done", checkbox.checked);
    void setTaskStatus(app, task._id, checkbox.checked ? "done" : "open").then(() => {
      if (plugin) plugin.refreshView();
    });
  });

  if (!isChild) {
    const children = getChildren(registry, task._id);
    if (children.length > 0) {
      const list = ensureChildList();
      for (const child of children) {
        renderTaskRowShared(list, child, app, component, onRefresh, plugin, showUrgency, tabFields, registry, true);
      }
    }
  }

  return row;
}

function renderAddTaskInput(parent: HTMLElement, app: App, placeholder: string, onAdd: (text: string) => Promise<void>) {
  const row = parent.createDiv({ cls: "morning-os-wins-input-row" });
  const input = row.createEl("input", { type: "text", cls: "morning-os-wins-input", placeholder });
  attachTaskTextSuggest(app, input);
  const btn = row.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Add" });
  const add = async () => {
    const text = input.value.trim();
    if (!text) return;
    await onAdd(text);
    input.value = "";
  };
  btn.addEventListener("click", () => { void add(); });
  input.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") void add(); });
}

export class AreaView extends ItemView {
  private settings: MorningOSSettings;
  private plugin: MorningOSPlugin;
  private registry: TaskRegistry = [];
  private activeTab: string | null = null;
  private areaKey: string;
  private sortField: SortField = "date_created";
  private sortDir: SortDir = "asc";
  private floatingCleanup: (() => void) | null = null;
  private filters: FilterState = {};

  constructor(leaf: WorkspaceLeaf, settings: MorningOSSettings, plugin: MorningOSPlugin, areaKey: string) {
    super(leaf);
    this.settings = settings;
    this.plugin = plugin;
    this.areaKey = areaKey;
  }

  getViewType(): string { return `${VIEW_TYPE_AREA}-${this.areaKey}`; }
  getDisplayText(): string { return this.plugin.settings.areas.find(p => p.key === this.areaKey)?.label ?? this.areaKey; }
  getIcon(): string { return "layers"; }

  async onOpen() { this.registry = await loadRegistry(this.app); this.render(); }
  async refresh() { this.registry = await loadRegistry(this.app); this.render(); }
  async onClose() { this.floatingCleanup?.(); this.floatingCleanup = null; }

  private render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("morning-os");
    this.floatingCleanup?.();
    this.floatingCleanup = mountFloatingPanel(container, this.plugin).cleanup;

    const area = this.plugin.settings.areas.find(p => p.key === this.areaKey);
    if (!area) return;

    const wrapper = container.createDiv({ cls: "morning-os-scroll" });
    const inner = wrapper.createDiv({ cls: "morning-os-wrapper" });

    // Title
    inner.createEl("h1", { cls: "mos-area-title", text: `${area.icon} ${area.label}` });

    // Area markdown notes section — placeholder created synchronously so order is correct
    const notesSlot = inner.createDiv({ cls: "mos-area-notes-slot" });
    void this.renderAreaNotes(notesSlot, area);

    // Active tab config (for field rendering)
    const activeTabConfig = area.tabs.find(t => t.key === this.activeTab) ?? null;

    // Tabs + sort/filter row together
    const controlRow = inner.createDiv({ cls: "mos-area-control-row" });

    if (area.tabs.length > 0) {
      const tabBar = controlRow.createDiv({ cls: "mos-area-tabs" });
      const allTab = tabBar.createEl("button", { cls: "mos-btn mos-btn-tab" + (!this.activeTab ? " is-active" : ""), text: "All" });
      allTab.addEventListener("click", () => { this.activeTab = null; this.render(); });
      for (const tab of area.tabs) {
        const btn = tabBar.createEl("button", { cls: "mos-btn mos-btn-tab" + (this.activeTab === tab?.key ? " is-active" : ""), text: tab.label });
        btn.addEventListener("click", () => { this.activeTab = tab.key; this.render(); });
      }
    }

    const sortFilterRow = controlRow.createDiv({ cls: "mos-sort-filter-row" });
    this.renderSortControls(sortFilterRow);
    const advancedAreaFeatures = this.plugin.settings.advancedAreaFeatures;
    if (!advancedAreaFeatures) delete this.filters.custom;
    const activeFields = advancedAreaFeatures ? activeTabConfig?.fields : undefined;
    renderFilterSelects(sortFilterRow, this.filters, (f) => { this.filters = f; this.render(); }, false, activeFields);

    // View mode: table vs cards
    if (advancedAreaFeatures && activeTabConfig?.view_mode === "table") {
      this.renderTableView(inner, activeTabConfig, area);
    } else {
      let tasks = this.registry.filter(t =>
        !t.is_deleted &&
        t.parent_id === null &&
        t.areas.includes(this.areaKey) &&
        (this.activeTab === null || t.tags[this.areaKey] === this.activeTab)
      );
      tasks = applyFilters(tasks, this.filters);
      tasks = sortTasks(tasks, this.sortField, this.sortDir);

      if (tasks.length === 0) {
        inner.createEl("p", { cls: "morning-os-empty-state", text: "No tasks here yet." });
      } else {
        const card = inner.createDiv({ cls: "morning-os-card" });
        const fields = activeFields ?? [];
        for (const t of tasks) renderTaskRowShared(card, t, this.app, this, () => void this.refresh(), this.plugin, false, fields, this.registry);
      }

      renderAddTaskInput(inner, this.app, "Capture a task…", async (text) => {
        const activeTab = this.activeTab;
        const tag = activeTab ? { [area.key]: activeTab } : {};
        const task = createTask(text, { areas: [area.key], tags: tag });
        const reg = await loadRegistry(this.app);
        reg.push(task);
        await saveRegistry(this.app, reg);
        await this.refresh();
      });
    }
  }

  private renderTableView(parent: HTMLElement, tabConfig: TabConfig, area: AreaConfig) {
    const fields = tabConfig.fields;
    const allItems = this.registry.filter(t =>
      !t.is_deleted && t.parent_id === null && t.areas.includes(this.areaKey) &&
      t.tags[this.areaKey] === tabConfig.key
    );
    const items = sortTasks(applyFilters(allItems, this.filters), this.sortField, this.sortDir);

    const table = parent.createEl("table", { cls: "mos-table" });
    const thead = table.createEl("thead");
    const headRow = thead.createEl("tr");
    headRow.createEl("th", { cls: "mos-table-th mos-table-check", text: "✓" });
    headRow.createEl("th", { cls: "mos-table-th", text: "Name" });
    for (const f of fields) headRow.createEl("th", { cls: "mos-table-th", text: f.label });
    headRow.createEl("th", { cls: "mos-table-th mos-table-actions", text: "" });

    const tbody = table.createEl("tbody");
    for (const task of items) {
      const tr = tbody.createEl("tr", { cls: "mos-table-row" + (task.status_completion === "done" ? " mos-table-row-done" : "") });

      // Checkbox cell
      const checkTd = tr.createEl("td", { cls: "mos-table-td mos-table-check" });
      const cb = checkTd.createEl("input", { type: "checkbox" });
      cb.checked = task.status_completion === "done";
      cb.addEventListener("change", () => {
        if (cb.checked && task.status_completion !== "done" && this.plugin) {
          cb.checked = false;
          requestTaskCompletion(this.app, this.plugin.settings, task, this.registry, async () => {
            await this.plugin?.autoRefreshBrief();
            await this.plugin?.refreshView();
            await this.refresh();
          });
          return;
        }
        void setTaskStatus(this.app, task._id, cb.checked ? "done" : "open").then(async () => {
          if (this.plugin) { await this.plugin.autoRefreshBrief(); this.plugin.refreshView(); }
          await this.refresh();
        });
      });

      // Name cell (editable on click)
      const nameTd = tr.createEl("td", { cls: "mos-table-td mos-table-name" });
      const nameSpan = renderMdContent(this.app, this, nameTd, "span", "", task.text);
      if (task.notes?.trim() && this.plugin.settings.showNotesIndicator) {
        nameTd.createSpan({ cls: "mos-notes-badge", attr: { title: "Has notes" }, text: "📝" });
      }
      nameSpan.addEventListener("dblclick", () => {
        const input = createEl("input");
        input.type = "text";
        input.value = task.text;
        input.className = "mos-table-inline-edit";
        nameSpan.replaceWith(input);
        attachTaskTextSuggest(this.app, input);
        input.focus();
        const save = async () => {
          const newText = input.value.trim();
          if (newText && newText !== task.text) {
            await updateTask(this.app, task._id, { text: newText });
            await this.refresh();
          } else {
            input.replaceWith(nameSpan);
          }
        };
        input.addEventListener("blur", () => { void save(); });
        input.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") input.replaceWith(nameSpan);
        });
      });

      // Field cells
      for (const f of fields) {
        const td = tr.createEl("td", { cls: "mos-table-td" });
        const val = task.tags[f.key] ?? "";
        if (f.type === "dropdown" && f.options?.length) {
          const sel = td.createEl("select", { cls: "mos-table-select" });
          sel.createEl("option", { value: "", text: "—" });
          for (const opt of f.options) {
            const optEl = sel.createEl("option", { value: opt, text: opt });
            if (val === opt) optEl.selected = true;
          }
          sel.addEventListener("change", () => {
            const newTags = { ...task.tags };
            if (sel.value) newTags[f.key] = sel.value;
            else delete newTags[f.key];
            void updateTask(this.app, task._id, { tags: newTags }).then(() => this.refresh());
          });
        } else if (f.type === "date") {
          const dateIn = td.createEl("input", { type: "date", cls: "mos-table-date-input" });
          dateIn.value = val;
          dateIn.addEventListener("change", () => {
            const newTags = { ...task.tags };
            if (dateIn.value) newTags[f.key] = dateIn.value;
            else delete newTags[f.key];
            void updateTask(this.app, task._id, { tags: newTags }).then(() => this.refresh());
          });
        } else {
          const cellSpan = val
            ? renderMdContent(this.app, this, td, "span", "", val)
            : td.createSpan({ text: "—", cls: "mos-table-empty" });
          cellSpan.addEventListener("dblclick", () => {
            const input = createEl("input");
            input.type = f.type === "url" ? "url" : "text";
            input.value = val;
            input.className = "mos-table-inline-edit";
            cellSpan.replaceWith(input);
            input.focus();
            const save = async () => {
              const newTags = { ...task.tags };
              if (input.value.trim()) newTags[f.key] = input.value.trim();
              else delete newTags[f.key];
              await updateTask(this.app, task._id, { tags: newTags });
              await this.refresh();
            };
            input.addEventListener("blur", () => { void save(); });
            input.addEventListener("keydown", (e: KeyboardEvent) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") input.replaceWith(cellSpan);
            });
          });
        }
      }

      // Actions cell
      const actTd = tr.createEl("td", { cls: "mos-table-td mos-table-actions" });
      const actBar = actTd.createDiv({ cls: "mos-task-action-bar" });

      actBar.createEl("button", { cls: "mos-action-btn", attr: { title: "→ Today (Regular)" }, text: "›" })
        .addEventListener("click", () => {
          void moveTaskToToday(this.app, task._id, "regular").then(async () => {
            if (this.plugin) { await this.plugin.autoRefreshBrief(); this.plugin.refreshView(); }
          });
        });

      actBar.createEl("button", { cls: "mos-action-btn mos-action-btn-red", attr: { title: "→ Today (Red alert)" }, text: "»" })
        .addEventListener("click", () => {
          void moveTaskToToday(this.app, task._id, "red").then(async () => {
            if (this.plugin) { await this.plugin.autoRefreshBrief(); this.plugin.refreshView(); }
          });
        });

      const tableMoreBtn = actBar.createEl("button", { cls: "mos-action-btn", attr: { title: "More actions" }, text: "⋯" });
      tableMoreBtn.addEventListener("click", () => {
        openContextMenu(tableMoreBtn, [
          {
            label: "✎ Edit metadata",
            action: () => {
              new TaskEditModal(this.app, task, async (updated) => {
                const reg = await loadRegistry(this.app);
                const idx = reg.findIndex(t => t._id === updated._id);
                if (idx !== -1) reg[idx] = updated;
                await saveRegistry(this.app, reg);
                if (this.plugin) this.plugin.refreshView();
                void this.refresh();
              }, false, this.plugin?.settings.areas ?? [], this.plugin?.settings.advancedAreaFeatures ?? false, this.plugin?.settings).open();
            },
          },
          {
            label: "🗑 Delete",
            danger: true,
            action: () => { void deleteTask(this.app, task._id).then(() => { if (this.plugin) this.plugin.refreshView(); }); },
          },
        ]);
      });
    }

    // Add row
    const addRow = parent.createDiv({ cls: "mos-table-add-row" });
    renderAddTaskInput(addRow, this.app, "+ Add row…", async (text) => {
      const tag = { [area.key]: tabConfig.key };
      const task = createTask(text, { areas: [area.key], tags: tag });
      const reg = await loadRegistry(this.app);
      reg.push(task);
      await saveRegistry(this.app, reg);
      await this.refresh();
    });
  }

  private async renderAreaNotes(parent: HTMLElement, area: AreaConfig) {
    const userFolder = this.settings.dailyNoteDir.split("/")[0] || "Essential";
    const notesPath = `${userFolder}/Areas/${area.label}.md`;

    const exists = await this.app.vault.adapter.exists(notesPath);
    if (!exists) {
      // Create parent dirs and empty file on first access
      const dir = `${userFolder}/Areas`;
      if (!(await this.app.vault.adapter.exists(dir))) {
        await this.app.vault.adapter.mkdir(dir);
      }
      await this.app.vault.adapter.write(notesPath, "");
    }

    let content = await this.app.vault.adapter.read(notesPath);

    // Strip leading h1 that matches the area label (added by migration, view already shows it)
    content = content.replace(new RegExp(`^#\\s+${area.label}\\s*\\n?`, "i"), "").trimStart();

    // Only render section if file has content
    if (!content.trim()) return;

    const storageKey = `mos-notes-collapsed-${area.key}`;
    let collapsed = this.app.loadLocalStorage(storageKey) === true;

    const section = parent.createDiv({ cls: "mos-area-notes" });
    const header = section.createDiv({ cls: "mos-area-notes-header" });
    const toggle = header.createSpan({ cls: "mos-area-notes-toggle", text: collapsed ? "▶" : "▼" });
    header.createSpan({ cls: "mos-area-notes-title", text: "Notes" });

    const editBtn = header.createEl("button", { cls: "mos-btn mos-btn-icon", attr: { title: "Edit notes" }, text: "✎" });
    editBtn.addEventListener("click", (e) => {
      void (async () => {
        e.stopPropagation();
        const file = this.app.vault.getAbstractFileByPath(notesPath);
        if (file instanceof TFile) {
          const leaf = this.app.workspace.getLeaf("split");
          await leaf.openFile(file);
        }
      })();
    });

    const body = section.createDiv({ cls: "mos-area-notes-body" });
    body.toggleClass("mos-area-notes-body-collapsed", collapsed);

    header.addEventListener("click", () => {
      collapsed = !collapsed;
      this.app.saveLocalStorage(storageKey, collapsed);
      toggle.textContent = collapsed ? "▶" : "▼";
      body.toggleClass("mos-area-notes-body-collapsed", collapsed);
    });

    const component = new Component();
    component.load();
    await MarkdownRenderer.render(this.app, content, body, notesPath, component);
  }

  private renderSortControls(parent: HTMLElement) {
    const wrap = parent.createDiv({ cls: "mos-sort-controls" });
    const fields: SortField[] = ["date_created", "date_modified", "date_completed", "name"];
    const select = wrap.createEl("select", { cls: "mos-btn mos-btn-select" });
    for (const f of fields) {
      const opt = select.createEl("option", { value: f, text: f });
      if (f === this.sortField) opt.selected = true;
    }
    select.addEventListener("change", () => { this.sortField = select.value as SortField; this.render(); });

    const dirBtn = wrap.createEl("button", { cls: "mos-btn mos-btn-icon", text: this.sortDir === "asc" ? "↑" : "↓" });
    dirBtn.addEventListener("click", () => { this.sortDir = this.sortDir === "asc" ? "desc" : "asc"; this.render(); });
  }
}

export class DumpView extends ItemView {
  private settings: MorningOSSettings;
  private plugin: MorningOSPlugin;
  private registry: TaskRegistry = [];
  private sortField: SortField = "date_created";
  private sortDir: SortDir = "desc";
  private floatingCleanup: (() => void) | null = null;
  private filters: FilterState = {};

  constructor(leaf: WorkspaceLeaf, settings: MorningOSSettings, plugin: MorningOSPlugin) {
    super(leaf);
    this.settings = settings;
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_DUMP; }
  getDisplayText(): string { return "Inbox"; }
  getIcon(): string { return "inbox"; }

  async onOpen() { this.registry = await loadRegistry(this.app); this.render(); }
  async refresh() { this.registry = await loadRegistry(this.app); this.render(); }
  async onClose() { this.floatingCleanup?.(); this.floatingCleanup = null; }

  private render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("morning-os");
    this.floatingCleanup?.();
    this.floatingCleanup = mountFloatingPanel(container, this.plugin).cleanup;

    const wrapper = container.createDiv({ cls: "morning-os-scroll" });
    const inner = wrapper.createDiv({ cls: "morning-os-wrapper" });

    const titleRow = inner.createDiv({ cls: "mos-view-title-row" });
    titleRow.createEl("h1", { cls: "morning-os-section-heading", text: "Inbox" });
    this.renderSortControls(titleRow);

    renderAddTaskInput(inner, this.app, "Capture a task…", async (text) => {
      const task = createTask(text);
      const reg = await loadRegistry(this.app);
      reg.push(task);
      await saveRegistry(this.app, reg);
      await this.refresh();
    });

    renderFilterSelects(titleRow, this.filters, (f) => { this.filters = f; this.render(); }, true);

    let tasks = this.registry.filter(t => !t.is_deleted && t.parent_id === null);
    tasks = applyFilters(tasks, this.filters);
    tasks = sortTasks(tasks, this.sortField, this.sortDir);

    if (tasks.length === 0) {
      inner.createEl("p", { cls: "morning-os-empty-state", text: "All clear. Capture fast, organize later." });
    } else {
      const card = inner.createDiv({ cls: "morning-os-card" });
      for (const t of tasks) renderTaskRowShared(card, t, this.app, this, () => void this.refresh(), this.plugin, true, undefined, this.registry);
    }
  }

  private renderSortControls(parent: HTMLElement) {
    const wrap = parent.createDiv({ cls: "mos-sort-controls" });
    const fields: SortField[] = ["date_created", "date_modified", "date_completed", "name"];
    const select = wrap.createEl("select", { cls: "mos-btn mos-btn-select" });
    for (const f of fields) {
      const opt = select.createEl("option", { value: f, text: f });
      if (f === this.sortField) opt.selected = true;
    }
    select.addEventListener("change", () => { this.sortField = select.value as SortField; this.render(); });
    const dirBtn = wrap.createEl("button", { cls: "mos-btn mos-btn-icon", text: this.sortDir === "asc" ? "↑" : "↓" });
    dirBtn.addEventListener("click", () => { this.sortDir = this.sortDir === "asc" ? "desc" : "asc"; this.render(); });
  }
}

import { Modal as ObsidianModal } from "obsidian";

class TaskAssistantModal extends ObsidianModal {
  private resultEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  constructor(
    app: App,
    private settings: MorningOSSettings,
    private tasks: TaskRegistry,
    private projects: ProjectState[],
    private activity: ActivityState,
    private onChanged: () => Promise<void>,
  ) { super(app); }

  onOpen(): void {
    const { contentEl } = this; contentEl.addClass("mos-edit-modal", "mos-task-assistant-modal");
    contentEl.createEl("h2", { text: "Ask AI about tasks" });
    contentEl.createEl("p", { cls: "mos-section-note", text: "The assistant can only change tasks through validated, reversible actions." });
    this.inputEl = contentEl.createEl("textarea", { cls: "mos-edit-input mos-edit-textarea", placeholder: "e.g. Add the figure labels task to Focus" });
    const footer = contentEl.createDiv({ cls: "mos-edit-footer" });
    const send = footer.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Send" });
    footer.createEl("button", { cls: "mos-btn", text: "Close" }).addEventListener("click", () => this.close());
    this.resultEl = contentEl.createDiv({ cls: "mos-task-assistant-results" });
    send.addEventListener("click", () => {
      const command = this.inputEl.value.trim(); if (!command) return;
      send.disabled = true; this.resultEl.empty(); this.resultEl.createEl("p", { cls: "mos-section-note", text: "Interpreting task command…" });
      void requestTaskAssistant(command, this.tasks, this.projects, this.activity.routines, this.settings)
        .then(plan => this.renderPlan(plan))
        .catch(error => { this.resultEl.empty(); this.resultEl.createEl("p", { cls: "mos-feedback-status", text: (error as Error).message }); })
        .finally(() => { send.disabled = false; });
    });
    void this.renderActivityHistory();
    this.inputEl.focus();
  }

  private renderPlan(plan: TaskAssistantPlan): void {
    this.resultEl.empty();
    if (plan.message) this.resultEl.createEl("p", { text: plan.message });
    if (plan.ambiguity) {
      this.resultEl.createEl("p", { text: `I found ${plan.ambiguity.candidates.length} matching tasks. Which one?` });
      for (const candidate of plan.ambiguity.candidates) {
        const choice = this.resultEl.createEl("button", { cls: "mos-btn mos-task-assistant-choice", text: `${candidate.text}${candidate.project ? ` · ${candidate.project}` : ""}` });
        choice.addEventListener("click", () => {
          plan.actions[plan.ambiguity!.actionIndex].task_id = candidate._id;
          delete plan.ambiguity;
          this.renderPlan(plan);
        });
      }
      return;
    }
    const searches = plan.actions.filter(action => action.type === "search_tasks");
    for (const search of searches) {
      const matches = resolveTaskQuery(this.tasks, search.query ?? "");
      const list = this.resultEl.createEl("ul");
      for (const task of matches) list.createEl("li", { text: `${task.text}${task.project ? ` · ${task.project}` : ""} · ${task.execution_state}` });
      if (!matches.length) this.resultEl.createEl("p", { cls: "mos-section-note", text: "No matching tasks." });
    }
    const writes = plan.actions.filter(action => action.type !== "search_tasks");
    if (!writes.length) return;
    const proposal = this.resultEl.createDiv({ cls: "mos-task-assistant-proposal" });
    for (const action of writes) proposal.createEl("p", { text: describeTaskAssistantAction(action, this.tasks) });
    if (plan.requiresConfirmation) {
      const actions = this.resultEl.createDiv({ cls: "mos-edit-footer" });
      actions.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Confirm" }).addEventListener("click", () => void this.execute(writes));
      actions.createEl("button", { cls: "mos-btn", text: "Edit" }).addEventListener("click", () => this.inputEl.focus());
      actions.createEl("button", { cls: "mos-btn", text: "Cancel" }).addEventListener("click", () => this.resultEl.empty());
    } else void this.execute(writes);
  }

  private async execute(actions: TaskAssistantPlan["actions"]): Promise<void> {
    this.resultEl.empty();
    try {
      const activities: TaskAssistantActivity[] = [];
      for (const action of actions) {
        const result = await executeTaskAssistantAction(this.app, action);
        if (result) activities.push(result);
      }
      this.tasks = await loadRegistry(this.app);
      for (const activity of activities) this.renderActivity(activity, this.resultEl);
      await this.onChanged();
    } catch (error) {
      this.resultEl.createEl("p", { cls: "mos-feedback-status", text: (error as Error).message });
    }
  }

  private renderActivity(activity: TaskAssistantActivity, parent: HTMLElement): void {
    const row = parent.createDiv({ cls: "mos-task-assistant-activity" });
    row.createSpan({ text: `AI ${activity.summary}` });
    const undo = row.createEl("button", { cls: "mos-btn mos-btn-inline", text: activity.undoneAt ? "Undone" : "Undo" }); undo.disabled = Boolean(activity.undoneAt);
    undo.addEventListener("click", () => void undoTaskAssistantActivity(this.app, activity.id).then(async () => {
      undo.disabled = true; undo.setText("Undone"); this.tasks = await loadRegistry(this.app); await this.onChanged();
    }).catch(error => new Notice((error as Error).message)));
  }

  private async renderActivityHistory(): Promise<void> {
    const activities = (await loadTaskAssistantActivities(this.app)).slice(-5).reverse();
    if (!activities.length || this.resultEl.childElementCount) return;
    this.resultEl.createEl("h3", { text: "Recent AI activity" });
    for (const activity of activities) this.renderActivity(activity, this.resultEl);
  }
  onClose(): void { this.contentEl.empty(); }
}

class StandaloneFocusModal extends ObsidianModal {
  constructor(app: App, private onStart: (input: { title: string; projectId?: string; type: FocusSession["type"] }) => Promise<void>) { super(app); }
  onOpen(): void {
    const { contentEl } = this; contentEl.addClass("mos-edit-modal");
    contentEl.createEl("h2", { text: "Start independent focus" });
    contentEl.createEl("p", { cls: "mos-section-note", text: "This timer does not need to be linked to a Task or Routine." });
    const title = contentEl.createEl("input", { type: "text", cls: "mos-edit-input", placeholder: "What are you focusing on?" });
    const project = contentEl.createEl("input", { type: "text", cls: "mos-edit-input", placeholder: "Project (optional)" });
    const type = contentEl.createEl("select", { cls: "mos-edit-input" });
    for (const value of ["deep-work", "writing", "reading", "coding", "other"] as const) type.createEl("option", { value, text: value });
    const status = contentEl.createSpan({ cls: "mos-feedback-status" });
    const footer = contentEl.createDiv({ cls: "mos-edit-footer" });
    footer.createEl("button", { cls: "mos-btn", text: "Cancel" }).addEventListener("click", () => this.close());
    const start = footer.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Start focus" });
    start.addEventListener("click", () => {
      const cleanTitle = title.value.trim();
      if (!cleanTitle) { status.setText("Enter a focus title."); title.focus(); return; }
      start.disabled = true;
      void this.onStart({ title: cleanTitle, projectId: project.value.trim() || undefined, type: type.value as FocusSession["type"] })
        .then(() => this.close())
        .catch(error => { start.disabled = false; status.setText((error as Error).message); });
    });
    title.addEventListener("keydown", event => { if (event.key === "Enter") start.click(); });
    title.focus();
  }
  onClose(): void { this.contentEl.empty(); }
}

class TaskCompletionModal extends ObsidianModal {
  constructor(app: App, private task: Task, private onComplete: (note: string) => Promise<void>) { super(app); }
  onOpen(): void {
    const { contentEl } = this; contentEl.addClass("mos-edit-modal");
    contentEl.createEl("h2", { text: "Complete task" });
    contentEl.createEl("p", { cls: "mos-completion-task-title", text: this.task.text });
    if (this.task.notes?.trim()) contentEl.createEl("p", { cls: "mos-section-note", text: "Existing task notes will be preserved. Add an optional completion note below." });
    const note = contentEl.createEl("textarea", { cls: "mos-edit-input mos-edit-textarea", placeholder: "Completion note (optional)" });
    const status = contentEl.createSpan({ cls: "mos-feedback-status" });
    const footer = contentEl.createDiv({ cls: "mos-edit-footer" });
    footer.createEl("button", { cls: "mos-btn", text: "Cancel" }).addEventListener("click", () => this.close());
    const complete = footer.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Complete" });
    complete.addEventListener("click", () => {
      complete.disabled = true;
      void this.onComplete(note.value)
        .then(() => this.close())
        .catch(error => { complete.disabled = false; status.setText((error as Error).message); });
    });
    note.focus();
  }
  onClose(): void { this.contentEl.empty(); }
}

class FocusNoteModal extends ObsidianModal {
  constructor(app: App, private onFinish: (note: string, progressValue?: number) => Promise<void>, private task?: Task) { super(app); }
  onOpen(): void {
    const { contentEl } = this; contentEl.addClass("mos-edit-modal"); contentEl.createEl("h2", { text: "Finish focus session" });
    let progress: HTMLInputElement | null = null;
    if (this.task?.progress) {
      const field = contentEl.createDiv({ cls: "mos-edit-field" });
      field.createEl("label", { cls: "mos-edit-label", text: `Progress added (${this.task.progress.unit ?? "units"})` });
      progress = field.createEl("input", { type: "number", cls: "mos-edit-input", placeholder: "+0" }); progress.min = "0";
    }
    const note = contentEl.createEl("textarea", { cls: "morning-os-wins-input mos-shutdown-thoughts", placeholder: "What moved forward? (optional)" });
    const footer = contentEl.createDiv({ cls: "mos-edit-footer" });
    footer.createEl("button", { cls: "mos-btn", text: "Cancel" }).addEventListener("click", () => this.close());
    footer.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Finish" }).addEventListener("click", () => void this.onFinish(note.value, progress?.value ? Number(progress.value) : undefined).then(() => this.close()).catch(error => new Notice((error as Error).message)));
    window.setTimeout(() => note.focus(), 50);
  }
  onClose(): void { this.contentEl.empty(); }
}

class ProgressUpdateModal extends ObsidianModal {
  constructor(app: App, private task: Task, private onSave: (input: { mode: "add" | "set"; value: number; note?: string }) => Promise<void>) { super(app); }
  onOpen(): void {
    const { contentEl } = this; const progress = this.task.progress!; contentEl.addClass("mos-edit-modal");
    contentEl.createEl("h2", { text: `Update ${this.task.text}` });
    contentEl.createEl("p", { cls: "mos-section-note", text: `Current: ${progress.current} / ${progress.target} ${progress.unit ?? ""}` });
    const mode = contentEl.createEl("select", { cls: "mos-edit-input" }); mode.createEl("option", { value: "add", text: "Add to progress" }); mode.createEl("option", { value: "set", text: "Set total progress" });
    const value = contentEl.createEl("input", { type: "number", cls: "mos-edit-input", placeholder: "Amount" }); value.min = "0";
    const note = contentEl.createEl("textarea", { cls: "morning-os-wins-input mos-shutdown-thoughts", placeholder: "What happened? (optional)" });
    const footer = contentEl.createDiv({ cls: "mos-edit-footer" }); footer.createEl("button", { cls: "mos-btn", text: "Cancel" }).addEventListener("click", () => this.close());
    footer.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Save progress" }).addEventListener("click", () => void this.onSave({ mode: mode.value as "add" | "set", value: Number(value.value), note: note.value.trim() || undefined }).then(() => this.close()).catch(error => new Notice((error as Error).message)));
    window.setTimeout(() => value.focus(), 50);
  }
  onClose(): void { this.contentEl.empty(); }
}

class RoutineLogModal extends ObsidianModal {
  constructor(app: App, private routine: Routine, private onSave: (value: number, note: string) => Promise<void>) { super(app); }
  onOpen(): void {
    const { contentEl } = this; contentEl.addClass("mos-edit-modal");
    contentEl.createEl("h2", { text: `Log ${this.routine.name}` });
    const amount = contentEl.createEl("input", { type: "number", cls: "mos-edit-input", placeholder: this.routine.metric === "duration" ? "Minutes" : "Amount" }); amount.min = "1";
    const note = contentEl.createEl("input", { type: "text", cls: "mos-edit-input", placeholder: "Short note (optional)" });
    const footer = contentEl.createDiv({ cls: "mos-edit-footer" });
    footer.createEl("button", { cls: "mos-btn", text: "Cancel" }).addEventListener("click", () => this.close());
    const save = footer.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Save" });
    save.addEventListener("click", () => void this.onSave(Number(amount.value), note.value).then(() => this.close()).catch(error => new Notice((error as Error).message)));
  }
  onClose(): void { this.contentEl.empty(); }
}

class RoutineProgressModal extends ObsidianModal {
  constructor(app: App, private routine: Routine, private current: number, private onSave: (desired: number, note: string) => Promise<void>) { super(app); }
  onOpen(): void {
    const { contentEl } = this; contentEl.addClass("mos-edit-modal");
    contentEl.createEl("h2", { text: this.routine.metric === "duration" ? `Set ${this.routine.name} time` : `Set ${this.routine.name} progress` });
    contentEl.createEl("p", { cls: "mos-section-note", text: `Current ${this.routine.cadence} progress: ${this.current} ${this.routine.unit ?? ""}` });
    const value = contentEl.createEl("input", { type: "number", cls: "mos-edit-input" }); value.min = "0"; value.value = String(this.current);
    const note = contentEl.createEl("input", { type: "text", cls: "mos-edit-input", placeholder: "Reason for correction (optional)" });
    const footer = contentEl.createDiv({ cls: "mos-edit-footer" });
    footer.createEl("button", { cls: "mos-btn", text: "Cancel" }).addEventListener("click", () => this.close());
    const save = footer.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Save progress" });
    save.addEventListener("click", () => {
      const desired = Math.round(Number(value.value));
      if (!Number.isFinite(desired) || desired < 0) { new Notice("Progress must be zero or greater"); return; }
      void this.onSave(desired, note.value).then(() => this.close()).catch(error => new Notice((error as Error).message));
    });
    window.setTimeout(() => { value.focus(); value.select(); }, 50);
  }
  onClose(): void { this.contentEl.empty(); }
}

class ReadingLogModal extends ObsidianModal {
  constructor(app: App, private focusSessionId: string | undefined, private onSave: (entry: { title: string; level: "skim" | "read"; project?: string; note?: string; focusSessionId?: string }) => Promise<void>) { super(app); }
  onOpen(): void {
    const { contentEl } = this; contentEl.addClass("mos-edit-modal"); contentEl.createEl("h2", { text: "Log paper" });
    const title = contentEl.createEl("input", { type: "text", cls: "mos-edit-input", placeholder: "Title or identifier" });
    const project = contentEl.createEl("input", { type: "text", cls: "mos-edit-input", placeholder: "Project or topic (optional)" });
    const level = contentEl.createEl("select", { cls: "mos-edit-input" });
    level.createEl("option", { value: "read", text: "Read — counts toward weekly goal" });
    level.createEl("option", { value: "skim", text: "Skim — history only" });
    const note = contentEl.createEl("input", { type: "text", cls: "mos-edit-input", placeholder: "Note (optional)" });
    const footer = contentEl.createDiv({ cls: "mos-edit-footer" });
    footer.createEl("button", { cls: "mos-btn", text: "Cancel" }).addEventListener("click", () => this.close());
    const save = footer.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Save" });
    save.addEventListener("click", () => void this.onSave({ title: title.value, project: project.value.trim() || undefined, level: level.value as "skim" | "read", note: note.value.trim() || undefined, focusSessionId: this.focusSessionId }).then(() => this.close()).catch(error => new Notice((error as Error).message)));
    window.setTimeout(() => title.focus(), 50);
  }
  onClose(): void { this.contentEl.empty(); }
}

class RoutineCreateModal extends ObsidianModal {
  constructor(app: App, private onSave: (routine: { name: string; projectId?: string | null; cadence: RoutineCadence; metric: RoutineMetric; target: number; unit?: string }) => Promise<void>) { super(app); }
  onOpen(): void {
    const { contentEl } = this; contentEl.addClass("mos-edit-modal"); contentEl.createEl("h2", { text: "Create routine" });
    const name = contentEl.createEl("input", { type: "text", cls: "mos-edit-input", placeholder: "Routine name" });
    const project = contentEl.createEl("input", { type: "text", cls: "mos-edit-input", placeholder: "Project (optional)" });
    const cadence = contentEl.createEl("select", { cls: "mos-edit-input" }); cadence.createEl("option", { value: "daily", text: "Daily" }); cadence.createEl("option", { value: "weekly", text: "Weekly" });
    const metric = contentEl.createEl("select", { cls: "mos-edit-input" });
    for (const value of ["duration", "count", "check"] as RoutineMetric[]) metric.createEl("option", { value, text: value });
    const target = contentEl.createEl("input", { type: "number", cls: "mos-edit-input", placeholder: "Target" }); target.min = "1";
    const unit = contentEl.createEl("input", { type: "text", cls: "mos-edit-input", placeholder: "Unit (min, papers, sessions…)" });
    const footer = contentEl.createDiv({ cls: "mos-edit-footer" });
    footer.createEl("button", { cls: "mos-btn", text: "Cancel" }).addEventListener("click", () => this.close());
    const save = footer.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Create" });
    save.addEventListener("click", () => void this.onSave({ name: name.value, projectId: project.value.trim() || null, cadence: cadence.value as RoutineCadence, metric: metric.value as RoutineMetric, target: Number(target.value), unit: unit.value.trim() || undefined }).then(() => this.close()).catch(error => new Notice((error as Error).message)));
    window.setTimeout(() => name.focus(), 50);
  }
  onClose(): void { this.contentEl.empty(); }
}

class RoutineEditModal extends ObsidianModal {
  constructor(app: App, private routine: Routine, private onSave: (patch: Partial<Omit<Routine, "id">>) => Promise<void>) { super(app); }
  onOpen(): void {
    const { contentEl } = this; contentEl.addClass("mos-edit-modal"); contentEl.createEl("h2", { text: "Edit routine" });
    const name = contentEl.createEl("input", { type: "text", cls: "mos-edit-input", placeholder: "Routine name" }); name.value = this.routine.name;
    const project = contentEl.createEl("input", { type: "text", cls: "mos-edit-input", placeholder: "Project (optional)" }); project.value = this.routine.projectId ?? "";
    const cadence = contentEl.createEl("select", { cls: "mos-edit-input" });
    for (const value of ["daily", "weekly"] as RoutineCadence[]) { const option = cadence.createEl("option", { value, text: value }); option.selected = value === this.routine.cadence; }
    const metric = contentEl.createEl("select", { cls: "mos-edit-input" });
    for (const value of ["duration", "count", "check"] as RoutineMetric[]) { const option = metric.createEl("option", { value, text: value }); option.selected = value === this.routine.metric; }
    const target = contentEl.createEl("input", { type: "number", cls: "mos-edit-input", placeholder: "Target" }); target.min = "1"; target.value = String(this.routine.target);
    const unit = contentEl.createEl("input", { type: "text", cls: "mos-edit-input", placeholder: "Unit" }); unit.value = this.routine.unit ?? "";
    const footer = contentEl.createDiv({ cls: "mos-edit-footer" });
    footer.createEl("button", { cls: "mos-btn", text: "Cancel" }).addEventListener("click", () => this.close());
    const save = footer.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Save routine" });
    save.addEventListener("click", () => void this.onSave({ name: name.value, projectId: project.value.trim() || null, cadence: cadence.value as RoutineCadence, metric: metric.value as RoutineMetric, target: Math.round(Number(target.value)), unit: unit.value.trim() || undefined }).then(() => this.close()).catch(error => new Notice((error as Error).message)));
    window.setTimeout(() => { name.focus(); name.select(); }, 50);
  }
  onClose(): void { this.contentEl.empty(); }
}

class ProjectCreateModal extends ObsidianModal {
  constructor(
    app: App,
    private onSave: (name: string, nextAction: string) => Promise<void>,
  ) { super(app); }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("mos-edit-modal");
    contentEl.createEl("h2", { cls: "mos-edit-title", text: "Create project" });

    const nameField = contentEl.createDiv({ cls: "mos-edit-field" });
    nameField.createEl("label", { cls: "mos-edit-label", text: "Project name" });
    const nameInput = nameField.createEl("input", { type: "text", cls: "mos-edit-input", placeholder: "e.g. Research project" });

    const actionField = contentEl.createDiv({ cls: "mos-edit-field" });
    actionField.createEl("label", { cls: "mos-edit-label", text: "Next action (optional)" });
    const actionInput = actionField.createEl("input", { type: "text", cls: "mos-edit-input", placeholder: "One concrete next step" });

    const footer = contentEl.createDiv({ cls: "mos-edit-footer" });
    const status = footer.createSpan({ cls: "mos-feedback-status" });
    const cancel = footer.createEl("button", { cls: "mos-btn", text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const save = footer.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Create project" });
    const submit = async () => {
      save.disabled = true;
      status.setText("");
      try {
        await this.onSave(nameInput.value, actionInput.value);
        this.close();
      } catch (error) {
        save.disabled = false;
        status.setText((error as Error).message);
      }
    };
    save.addEventListener("click", () => void submit());
    nameInput.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing) void submit(); });
    window.setTimeout(() => nameInput.focus(), 50);
  }

  onClose(): void { this.contentEl.empty(); }
}

class ProjectEditModal extends ObsidianModal {
  constructor(
    app: App,
    private projectName: string,
    private taskCount: number,
    private routineCount: number,
    private onRename: (newName: string) => Promise<void>,
    private onDelete: () => Promise<void>,
  ) { super(app); }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("mos-edit-modal");
    contentEl.createEl("h2", { cls: "mos-edit-title", text: "Edit project" });
    const nameField = contentEl.createDiv({ cls: "mos-edit-field" });
    nameField.createEl("label", { cls: "mos-edit-label", text: "Project name" });
    const nameInput = nameField.createEl("input", { type: "text", cls: "mos-edit-input" });
    nameInput.value = this.projectName;
    contentEl.createEl("p", {
      cls: "mos-section-note",
      text: `${this.taskCount} task${this.taskCount === 1 ? "" : "s"} · ${this.routineCount} routine${this.routineCount === 1 ? "" : "s"}. Renaming updates their project reference.`,
    });
    const status = contentEl.createSpan({ cls: "mos-feedback-status" });
    const footer = contentEl.createDiv({ cls: "mos-edit-footer" });
    const remove = footer.createEl("button", { cls: "mos-btn mos-btn-danger", text: "Delete project" });
    let deleteArmed = false;
    remove.addEventListener("click", () => {
      if (!deleteArmed) {
        deleteArmed = true;
        remove.setText("Confirm delete project");
        status.setText("Tasks and routines will be kept, but their project assignment will be removed.");
        return;
      }
      remove.disabled = true;
      void this.onDelete().then(() => this.close()).catch(error => {
        remove.disabled = false;
        deleteArmed = false;
        remove.setText("Delete project");
        status.setText((error as Error).message);
      });
    });
    footer.createEl("button", { cls: "mos-btn", text: "Cancel" }).addEventListener("click", () => this.close());
    const save = footer.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Save project" });
    const submit = () => {
      const newName = nameInput.value.trim();
      if (!newName) { status.setText("Project name is required"); nameInput.focus(); return; }
      if (newName === this.projectName) { this.close(); return; }
      save.disabled = true;
      void this.onRename(newName).then(() => this.close()).catch(error => {
        save.disabled = false;
        status.setText((error as Error).message);
      });
    };
    save.addEventListener("click", submit);
    nameInput.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing) submit(); });
    window.setTimeout(() => { nameInput.focus(); nameInput.select(); }, 50);
  }

  onClose(): void { this.contentEl.empty(); }
}

class ProjectPlanningTasksModal extends ObsidianModal {
  private renderer = new Component();

  constructor(
    app: App,
    private project: string,
    private tasks: Task[],
    private projectState: ProjectState | undefined,
    private onChanged: () => Promise<void>,
  ) { super(app); }

  onOpen(): void {
    const { contentEl } = this;
    this.renderer.load();
    contentEl.addClass("mos-edit-modal", "mos-project-picker-modal");
    contentEl.createEl("h2", { cls: "mos-edit-title", text: this.project });
    contentEl.createEl("p", { cls: "mos-section-note", text: "Choose any open project task to add to Today. Waiting and blocked tasks keep their current state." });
    const list = contentEl.createDiv({ cls: "mos-project-picker-list" });
    if (!this.tasks.length) list.createDiv({ cls: "morning-os-card morning-os-card-empty", text: "No open tasks in this project." });
    for (const task of this.tasks) {
      const row = list.createDiv({ cls: "mos-project-picker-row" });
      const copy = row.createDiv({ cls: "mos-project-picker-copy" });
      const title = copy.createDiv({ cls: "mos-project-picker-title" });
      renderMdContent(this.app, this.renderer, title, "span", "mos-project-task-text", task.parent_id ? `↳ ${task.text}` : task.text);
      const isNext = this.projectState?.next_action_task_id
        ? this.projectState.next_action_task_id === task._id
        : Boolean(this.projectState?.next_action.trim() && this.projectState.next_action.trim().toLocaleLowerCase() === task.text.trim().toLocaleLowerCase());
      if (isNext) title.createSpan({ cls: "mos-meta-chip", text: "Next" });
      if (task.execution_state !== "ready") title.createSpan({ cls: `mos-meta-chip is-${task.execution_state}`, text: task.execution_state });
      renderTaskMeta(copy, task);
      const add = row.createEl("button", { cls: "mos-btn mos-btn-primary", text: task.planned_date === todayStr() ? "Already in Today" : "Add Today" });
      add.disabled = task.planned_date === todayStr();
      add.addEventListener("click", () => void applyMutations(this.app, [{ type: "move-to-today", task_id: task._id }]).then(async () => {
        task.planned_date = todayStr();
        task.is_today = true;
        add.disabled = true;
        add.setText("Added ✓");
        await this.onChanged();
      }).catch(error => new Notice((error as Error).message)));
    }
    const footer = contentEl.createDiv({ cls: "mos-edit-footer" });
    footer.createEl("button", { cls: "mos-btn", text: "Close" }).addEventListener("click", () => this.close());
  }

  onClose(): void { this.renderer.unload(); this.contentEl.empty(); }
}

class ProjectTaskModal extends ObsidianModal {
  constructor(
    app: App,
    private projectNames: string[],
    private initialProject: string,
    private onSave: (task: Task) => Promise<void>,
  ) { super(app); }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("mos-edit-modal");
    contentEl.createEl("h2", { cls: "mos-edit-title", text: this.initialProject ? `Add task to ${this.initialProject}` : "Add project task" });

    const taskField = contentEl.createDiv({ cls: "mos-edit-field" });
    taskField.createEl("label", { cls: "mos-edit-label", text: "Task" });
    const taskInput = taskField.createEl("input", { type: "text", cls: "mos-edit-input", placeholder: "What is the next concrete action?" });
    attachTaskTextSuggest(this.app, taskInput);

    const projectField = contentEl.createDiv({ cls: "mos-edit-field" });
    projectField.createEl("label", { cls: "mos-edit-label", text: "Project" });
    const projectInput = projectField.createEl("input", { type: "text", cls: "mos-edit-input", placeholder: "Choose or create a project" });
    projectInput.value = this.initialProject;
    const listId = `mos-projects-${Date.now()}`;
    projectInput.setAttr("list", listId);
    const projectList = projectField.createEl("datalist", { attr: { id: listId } });
    for (const name of this.projectNames) projectList.createEl("option", { value: name });

    const options = contentEl.createDiv({ cls: "mos-project-task-options" });
    const priorityField = options.createDiv({ cls: "mos-edit-field" });
    priorityField.createEl("label", { cls: "mos-edit-label", text: "Priority" });
    const priority = priorityField.createEl("select", { cls: "mos-edit-input" });
    priority.createEl("option", { value: "", text: "No priority" });
    for (const [value, label] of Object.entries(EISENHOWER_LABELS)) priority.createEl("option", { value, text: label });

    const destinationField = options.createDiv({ cls: "mos-edit-field" });
    destinationField.createEl("label", { cls: "mos-edit-label", text: "Add to" });
    const destination = destinationField.createEl("select", { cls: "mos-edit-input" });
    destination.createEl("option", { value: "backlog", text: "Project backlog" });
    destination.createEl("option", { value: "today", text: "Today" });

    const footer = contentEl.createDiv({ cls: "mos-edit-footer" });
    const status = footer.createSpan({ cls: "mos-feedback-status" });
    const cancel = footer.createEl("button", { cls: "mos-btn", text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const save = footer.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Add task" });
    const submit = async () => {
      try {
        const task = createProjectTask(
          taskInput.value,
          projectInput.value,
          priority.value as Task["eisenhower_priority"],
          destination.value as "backlog" | "today",
        );
        save.disabled = true;
        await this.onSave(task);
        this.close();
      } catch (error) {
        save.disabled = false;
        status.setText((error as Error).message);
      }
    };
    save.addEventListener("click", () => void submit());
    taskInput.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing) void submit(); });
    window.setTimeout(() => taskInput.focus(), 50);
  }

  onClose(): void { this.contentEl.empty(); }
}

class ProposalReviewModal extends ObsidianModal {
  constructor(
    app: App,
    private proposal: AgentProposal,
    private tasks: TaskRegistry,
    private onApprove: (mutations: ProposedMutation[]) => Promise<void>,
  ) { super(app); }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("mos-proposal-modal");
    contentEl.createEl("h2", { text: "Review AI proposal" });
    contentEl.createEl("p", { cls: "mos-proposal-summary", text: this.proposal.summary });
    if (this.proposal.rationale.length) {
      const reasons = contentEl.createEl("ul", { cls: "mos-proposal-rationale" });
      for (const reason of this.proposal.rationale) reasons.createEl("li", { text: reason });
    }
    const selected = new Set<number>(this.proposal.mutations.map((_, index) => index));
    for (const [index, mutation] of this.proposal.mutations.entries()) {
      const row = contentEl.createDiv({ cls: "mos-proposal-row" });
      const checkbox = row.createEl("input", { type: "checkbox" }); checkbox.checked = true;
      checkbox.addEventListener("change", () => checkbox.checked ? selected.add(index) : selected.delete(index));
      const description = describeProposalMutation(mutation, this.tasks);
      const copy = row.createDiv({ cls: "mos-proposal-copy" });
      copy.createSpan({ cls: "mos-proposal-action", text: description.action });
      copy.createSpan({ cls: "mos-proposal-task", text: description.taskText ?? "" });
      if (description.metadata.length) copy.createSpan({ cls: "mos-proposal-meta", text: description.metadata.join(" · ") });
    }
    if (!this.proposal.mutations.length) contentEl.createEl("p", { text: "No state changes proposed." });
    const footer = contentEl.createDiv({ cls: "mos-edit-footer" });
    const approve = footer.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Approve selected" });
    approve.disabled = this.proposal.mutations.length === 0;
    approve.addEventListener("click", () => void this.onApprove(this.proposal.mutations.filter((_, index) => selected.has(index))).then(() => this.close()));
    const cancel = footer.createEl("button", { cls: "mos-btn", text: "Reject" });
    cancel.addEventListener("click", () => this.close());
  }
  onClose(): void { this.contentEl.empty(); }
}

class TaskEditModal extends ObsidianModal {
  private task: Task;
  private initialTask: Task;
  private onSave: (task: Task) => Promise<void>;
  private showUrgency: boolean;
  private areaConfigs: AreaConfig[];
  private showAdvancedAreaFeatures: boolean;
  private settings?: MorningOSSettings;
  private closeIntent: TaskEditCloseIntent = "implicit";
  private savePromise: Promise<void> | null = null;
  private saveStatus: HTMLElement | null = null;

  constructor(
    app: App,
    task: Task,
    onSave: (task: Task) => Promise<void>,
    showUrgency = false,
    areaConfigs: AreaConfig[] = [],
    showAdvancedAreaFeatures = false,
    settings?: MorningOSSettings
  ) {
    super(app);
    this.task = { ...task, areas: [...task.areas], tags: { ...task.tags }, progress: task.progress ? { ...task.progress } : null, daily_progress_target: task.daily_progress_target ? { ...task.daily_progress_target } : null };
    this.initialTask = { ...task, areas: [...task.areas], tags: { ...task.tags }, progress: task.progress ? { ...task.progress } : null, daily_progress_target: task.daily_progress_target ? { ...task.daily_progress_target } : null };
    this.onSave = onSave;
    this.showUrgency = showUrgency;
    this.areaConfigs = areaConfigs;
    this.showAdvancedAreaFeatures = showAdvancedAreaFeatures;
    this.settings = settings;
  }

  private async persistTask(): Promise<void> {
    if (!shouldAutoSaveTask(this.initialTask, this.task, "implicit")) return;
    if (this.task.status_completion === "done" && this.task.progress && this.task.progress.current < this.task.progress.target) throw new Error(`Overall progress must reach ${this.task.progress.target} ${this.task.progress.unit ?? ""} before completion.`);
    if (!this.savePromise) {
      const previousDaily = this.initialTask.daily_progress_target ? { ...this.initialTask.daily_progress_target } : null;
      this.savePromise = this.onSave(this.task).then(() => {
        const nextDaily = this.task.daily_progress_target;
        if (this.settings && previousDaily?.date === todayStr() && nextDaily?.date === todayStr() && previousDaily.target !== nextDaily.target) {
          void writeDailyTargetChangeEvent(this.app, this.settings, this.task, previousDaily.target, nextDaily.target, todayStr()).catch(error => console.error("Morning OS daily target event failed", error));
        }
        this.initialTask = { ...this.task, areas: [...this.task.areas], tags: { ...this.task.tags }, progress: this.task.progress ? { ...this.task.progress } : null, daily_progress_target: this.task.daily_progress_target ? { ...this.task.daily_progress_target } : null };
      }).finally(() => { this.savePromise = null; });
    }
    await this.savePromise;
  }

  private closeWithoutAutoSave(intent: "saved" | "discard"): void {
    this.closeIntent = intent;
    super.close();
  }

  override close(): void {
    if (this.closeIntent === "saving") return;
    if (!shouldAutoSaveTask(this.initialTask, this.task, this.closeIntent)) {
      super.close();
      return;
    }
    this.closeIntent = "saving";
    this.saveStatus?.setText("Saving changes…");
    void this.persistTask()
      .then(() => this.closeWithoutAutoSave("saved"))
      .catch(error => {
        this.closeIntent = "implicit";
        const message = `Could not save: ${(error as Error).message}`;
        this.saveStatus?.setText(message);
        new Notice(`Morning OS: ${message}`);
      });
  }

  private field(parent: HTMLElement, label: string): HTMLElement {
    const wrap = parent.createDiv({ cls: "mos-edit-field" });
    wrap.createEl("label", { cls: "mos-edit-label", text: label });
    return wrap;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("mos-edit-modal");
    contentEl.createEl("h2", { cls: "mos-edit-title", text: "Edit task" });

    // Text
    const textWrap = this.field(contentEl, "Text");
    const textInput = textWrap.createEl("input", { type: "text", cls: "mos-edit-input" });
    textInput.value = this.task.text;
    textInput.addEventListener("input", () => { this.task.text = textInput.value.trim(); });
    attachTaskTextSuggest(this.app, textInput);

    // Status
    const statusWrap = this.field(contentEl, "Status");
    const statusGroup = statusWrap.createDiv({ cls: "mos-edit-btn-group" });
    for (const s of ["open", "done", "dismissed"] as const) {
      const btn = statusGroup.createEl("button", {
        cls: "mos-btn mos-btn-seg" + (this.task.status_completion === s ? " is-active" : ""),
        text: s,
      });
      btn.addEventListener("click", () => {
        this.task.status_completion = s;
        statusGroup.querySelectorAll(".mos-btn").forEach(b => b.removeClass("is-active"));
        btn.addClass("is-active");
      });
    }

    const projectWrap = this.field(contentEl, "Project");
    const projectInput = projectWrap.createEl("input", { type: "text", cls: "mos-edit-input", placeholder: "Project name" });
    projectInput.value = this.task.project;
    projectInput.addEventListener("input", () => { this.task.project = projectInput.value.trim(); });

    const effortWrap = this.field(contentEl, "Effort (minutes)");
    const effortInput = effortWrap.createEl("input", { type: "number", cls: "mos-edit-input" });
    effortInput.min = "0";
    effortInput.value = this.task.effort_minutes === null ? "" : String(this.task.effort_minutes);
    effortInput.addEventListener("input", () => { this.task.effort_minutes = effortInput.value ? Math.max(0, Math.round(Number(effortInput.value))) : null; });

    const progressWrap = this.field(contentEl, "Count progress (optional)");
    const progressToggle = progressWrap.createEl("input", { type: "checkbox" }); progressToggle.checked = Boolean(this.task.progress);
    const progressFields = progressWrap.createDiv({ cls: "mos-progress-edit-fields" });
    const currentInput = progressFields.createEl("input", { type: "number", cls: "mos-edit-input", placeholder: "Current" }); currentInput.min = "0"; currentInput.value = String(this.task.progress?.current ?? 0); currentInput.disabled = Boolean(this.task.progress);
    const targetInput = progressFields.createEl("input", { type: "number", cls: "mos-edit-input", placeholder: "Overall target" }); targetInput.min = "1"; targetInput.value = this.task.progress ? String(this.task.progress.target) : "";
    const unitInput = progressFields.createEl("input", { type: "text", cls: "mos-edit-input", placeholder: "Unit, e.g. galaxies" }); unitInput.value = this.task.progress?.unit ?? "";
    const dailyInput = progressFields.createEl("input", { type: "number", cls: "mos-edit-input", placeholder: "Today target (optional)" }); dailyInput.min = "1"; dailyInput.value = this.task.daily_progress_target?.date === todayStr() ? String(this.task.daily_progress_target.target) : "";
    const updateProgress = () => {
      progressFields.toggleClass("is-hidden", !progressToggle.checked);
      if (!progressToggle.checked) { this.task.progress = null; this.task.daily_progress_target = null; return; }
      const target = Math.round(Number(targetInput.value));
      if (target > 0) this.task.progress = { type: "count", current: this.task.progress?.current ?? Math.max(0, Math.round(Number(currentInput.value) || 0)), target, unit: unitInput.value.trim() || undefined };
      const dailyTarget = Math.round(Number(dailyInput.value));
      this.task.daily_progress_target = dailyTarget > 0 && this.task.progress ? { date: todayStr(), target: dailyTarget, startingValue: this.task.daily_progress_target?.date === todayStr() ? this.task.daily_progress_target.startingValue : this.task.progress.current } : null;
    };
    for (const element of [progressToggle, currentInput, targetInput, unitInput, dailyInput]) element.addEventListener("input", updateProgress);
    updateProgress();

    const contextWrap = this.field(contentEl, "Context");
    const contextInput = contextWrap.createEl("input", { type: "text", cls: "mos-edit-input", placeholder: "deep-work, coding, server, reading…" });
    contextInput.value = this.task.context;
    contextInput.addEventListener("input", () => { this.task.context = contextInput.value.trim(); });

    const routineWrap = this.field(contentEl, "Linked routine");
    const routineSelect = routineWrap.createEl("select", { cls: "mos-edit-input" });
    routineSelect.createEl("option", { value: "", text: "None" });
    void loadActivityState(this.app).then(state => {
      for (const routine of state.routines.filter(item => item.enabled)) {
        const option = routineSelect.createEl("option", { value: routine.id, text: routine.name });
        option.selected = routine.id === this.task.routine_id;
      }
    });
    routineSelect.addEventListener("change", () => { this.task.routine_id = routineSelect.value || null; });

    const executionWrap = this.field(contentEl, "Execution state");
    const executionSelect = executionWrap.createEl("select", { cls: "mos-edit-input" });
    for (const value of ["ready", "waiting", "blocked"] as const) {
      const option = executionSelect.createEl("option", { value, text: value }); option.selected = this.task.execution_state === value;
    }
    executionSelect.addEventListener("change", () => { this.task.execution_state = executionSelect.value as Task["execution_state"]; });

    const priorityWrap = this.field(contentEl, "Priority");
    const prioritySelect = priorityWrap.createEl("select", { cls: "mos-edit-input" });
    prioritySelect.createEl("option", { value: "", text: "—" });
    for (const [value, label] of Object.entries(EISENHOWER_LABELS)) {
      const option = prioritySelect.createEl("option", { value, text: label }); option.selected = this.task.eisenhower_priority === value;
    }
    prioritySelect.addEventListener("change", () => {
      this.task.eisenhower_priority = prioritySelect.value as Task["eisenhower_priority"];
      this.task.status_priority = prioritySelect.value === "urgent_important" ? "red" : "regular";
    });

    // Urgency — inbox only
    if (this.showUrgency) {
      const urgWrap = this.field(contentEl, "Urgency");
      const urgGroup = urgWrap.createDiv({ cls: "mos-edit-btn-group" });
      for (const u of ["none", "low", "med", "high"] as const) {
        const btn = urgGroup.createEl("button", {
          cls: "mos-btn mos-btn-seg" + (this.task.status_urgency === u ? " is-active" : ""),
          text: u === "none" ? "—" : u,
        });
        btn.addEventListener("click", () => {
          this.task.status_urgency = u;
          urgGroup.querySelectorAll(".mos-btn").forEach(b => b.removeClass("is-active"));
          btn.addClass("is-active");
        });
      }
    }

    // Areas
    if (this.areaConfigs.length > 0) {
      const areasWrap = this.field(contentEl, "Areas");
      const areasGrid = areasWrap.createDiv({ cls: "mos-edit-areas-grid" });
      for (const area of this.areaConfigs) {
        const cell = areasGrid.createDiv({ cls: "mos-edit-area-cell" });
        const cb = cell.createEl("input", { type: "checkbox" });
        cb.checked = this.task.areas.includes(area.key);
        cell.createSpan({ cls: "mos-edit-area-label", text: area.label });

        if (area.tabs.length > 0) {
          const tabSel = cell.createEl("select", { cls: "mos-edit-select" });
          tabSel.createEl("option", { value: "", text: "— tab —" });
          for (const tab of area.tabs) {
            const opt = tabSel.createEl("option", { value: tab.key, text: tab.label });
            if (this.task.tags[area.key] === tab.key) opt.selected = true;
          }
          tabSel.style.display = cb.checked ? "block" : "none";
          cb.addEventListener("change", () => { tabSel.style.display = cb.checked ? "block" : "none"; });
          tabSel.addEventListener("change", () => { this.task.tags[area.key] = tabSel.value; });
        }

        cb.addEventListener("change", () => {
          if (cb.checked) { if (!this.task.areas.includes(area.key)) this.task.areas.push(area.key); }
          else { this.task.areas = this.task.areas.filter(p => p !== area.key); delete this.task.tags[area.key]; }
        });
      }
    }

    // Custom fields — render based on area/tab context
    const taskArea = this.task.areas[0];
    const areaConfig = taskArea ? this.areaConfigs.find(p => p.key === taskArea) : undefined;
    const taskTabKey = taskArea ? this.task.tags[taskArea] : undefined;
    const tabConfig = taskTabKey ? areaConfig?.tabs.find(t => t.key === taskTabKey) : undefined;
    if (this.showAdvancedAreaFeatures && tabConfig?.fields.length) {
      const fieldsWrap = this.field(contentEl, "Fields");
      for (const fieldDef of tabConfig.fields) {
        const fRow = fieldsWrap.createDiv({ cls: "mos-edit-field-row" });
        fRow.createEl("label", { cls: "mos-edit-label", text: fieldDef.label });
        const currentVal = this.task.tags[fieldDef.key] ?? "";
        if (fieldDef.type === "dropdown" && fieldDef.options?.length) {
          const sel = fRow.createEl("select", { cls: "mos-edit-input" });
          sel.createEl("option", { value: "", text: `— ${fieldDef.label} —` });
          for (const opt of fieldDef.options) {
            const optEl = sel.createEl("option", { value: opt, text: opt });
            if (currentVal === opt) optEl.selected = true;
          }
          sel.addEventListener("change", () => {
            if (sel.value) this.task.tags[fieldDef.key] = sel.value;
            else delete this.task.tags[fieldDef.key];
          });
        } else if (fieldDef.type === "date") {
          const dateIn = fRow.createEl("input", { type: "date", cls: "mos-edit-input" });
          dateIn.value = currentVal;
          dateIn.addEventListener("change", () => {
            if (dateIn.value) this.task.tags[fieldDef.key] = dateIn.value;
            else delete this.task.tags[fieldDef.key];
          });
        } else {
          const textIn = fRow.createEl("input", { type: fieldDef.type === "url" ? "url" : "text", cls: "mos-edit-input" });
          textIn.value = currentVal;
          textIn.placeholder = fieldDef.type === "url" ? "https://..." : "";
          textIn.addEventListener("input", () => {
            if (textIn.value.trim()) this.task.tags[fieldDef.key] = textIn.value.trim();
            else delete this.task.tags[fieldDef.key];
          });
        }
      }
    }

    // Remind date
    const remindWrap = this.field(contentEl, "Remind date");
    const remindInput = remindWrap.createEl("input", { type: "date", cls: "mos-edit-input" });
    remindInput.value = this.task.date_remind ?? "";
    remindInput.addEventListener("change", () => { this.task.date_remind = remindInput.value || null; });

    // Notes
    const notesWrap = this.field(contentEl, "Notes");
    const notesInput = notesWrap.createEl("textarea", { cls: "mos-edit-input mos-edit-textarea" });
    notesInput.value = this.task.notes ?? "";
    notesInput.addEventListener("input", () => { this.task.notes = notesInput.value; });

    const footer = contentEl.createDiv({ cls: "mos-edit-footer" });
    this.saveStatus = footer.createSpan({ cls: "mos-feedback-status" });
    const saveBtn = footer.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Save" });
    const discardBtn = footer.createEl("button", { cls: "mos-btn", text: "Discard" });
    saveBtn.addEventListener("click", () => {
      this.closeIntent = "saving";
      saveBtn.disabled = true;
      discardBtn.disabled = true;
      this.saveStatus?.setText("Saving changes…");
      void this.persistTask()
        .then(() => this.closeWithoutAutoSave("saved"))
        .catch(error => {
          this.closeIntent = "implicit";
          saveBtn.disabled = false;
          discardBtn.disabled = false;
          this.saveStatus?.setText(`Could not save: ${(error as Error).message}`);
        });
    });
    discardBtn.addEventListener("click", () => this.closeWithoutAutoSave("discard"));
  }

  onClose() { this.saveStatus = null; this.contentEl.empty(); }
}

export class TrashView extends ItemView {
  private settings: MorningOSSettings;
  private plugin: MorningOSPlugin;
  private registry: TaskRegistry = [];
  private floatingCleanup: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, settings: MorningOSSettings, plugin: MorningOSPlugin) {
    super(leaf);
    this.settings = settings;
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_TRASH; }
  getDisplayText(): string { return "Trash"; }
  getIcon(): string { return "trash"; }

  async onOpen() { this.registry = await loadRegistry(this.app); this.render(); }
  async refresh() { this.registry = await loadRegistry(this.app); this.render(); }
  async onClose() { this.floatingCleanup?.(); this.floatingCleanup = null; }

  private render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("morning-os");
    this.floatingCleanup?.();
    this.floatingCleanup = mountFloatingPanel(container, this.plugin).cleanup;

    const wrapper = container.createDiv({ cls: "morning-os-scroll" });
    const inner = wrapper.createDiv({ cls: "morning-os-wrapper" });
    inner.createEl("h1", { cls: "morning-os-section-heading", text: "Trash" });

    this.renderTrashSection(inner, this.registry.filter(t => t.is_deleted), "Deleted");
  }

  private renderTrashSection(parent: HTMLElement, tasks: Task[], label: string) {
    parent.createEl("h2", { cls: "morning-os-section-heading", text: `${label} (${tasks.length})` });
    if (tasks.length === 0) {
      parent.createEl("p", { cls: "morning-os-empty-state", text: `No ${label.toLowerCase()} tasks.` });
      return;
    }
    const card = parent.createDiv({ cls: "morning-os-card" });
    for (const task of tasks) {
      const row = card.createDiv({ cls: "morning-os-task-row morning-os-task-done" });
      renderMdContent(this.app, this, row, "span", "morning-os-task-text", task.text);
      row.createSpan({ cls: "morning-os-reminder-badge", text: task.date_modified });

      const restoreBtn = row.createEl("button", { cls: "mos-task-action-btn", text: "Restore" });
      restoreBtn.addEventListener("click", () => {
        void (async () => {
          const reg = await loadRegistry(this.app);
          const idx = reg.findIndex(t => t._id === task._id);
          if (idx !== -1) {
            reg[idx].is_deleted = false;
            reg[idx].status_completion = "open";
            reg[idx].date_modified = todayStr();
          }
          await saveRegistry(this.app, reg);
          this.plugin.refreshView();
          void this.refresh();
        })();
      });

      const permDeleteBtn = row.createEl("button", { cls: "mos-task-action-btn mos-task-action-delete", text: "Delete permanently" });
      permDeleteBtn.addEventListener("click", () => {
        void (async () => {
          const reg = await loadRegistry(this.app);
          await saveRegistry(this.app, reg.filter(t => t._id !== task._id));
          this.plugin.refreshView();
          void this.refresh();
        })();
      });
    }
  }
}

export class CaptureModal extends ObsidianModal {
  private onCapture: (text: string) => Promise<void>;

  constructor(app: App, onCapture: (text: string) => Promise<void>) {
    super(app);
    this.onCapture = onCapture;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("mos-feedback-modal");
    contentEl.createEl("h2", { text: "Capture task" });

    const input = contentEl.createEl("input", {
      type: "text",
      cls: "morning-os-wins-input mos-capture-input",
    });
    input.placeholder = "Capture a task…";
    attachTaskTextSuggest(this.app, input);

    const footer = contentEl.createDiv({ cls: "mos-feedback-modal-footer" });
    const hint = footer.createSpan({ cls: "mos-feedback-status", text: "Enter to save" });
    void hint;

    const save = async () => {
      const text = input.value.trim();
      if (!text) return;
      await this.onCapture(text);
      this.close();
    };

    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") void save();
      if (e.key === "Escape") this.close();
    });

    // Focus immediately so user can type without clicking
    window.setTimeout(() => input.focus(), 50);
  }

  onClose() { this.contentEl.empty(); }
}

class FeedbackModal extends Modal {
  private type: "bug" | "feature" | null = null;
  private description = "";

  constructor(app: App) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("mos-feedback-modal");

    contentEl.createEl("h2", { cls: "mos-feedback-modal-title", text: "Share feedback" });
    contentEl.createEl("p", { cls: "mos-feedback-modal-sub", text: "Your feedback shapes what gets built next." });

    const typeRow = contentEl.createDiv({ cls: "mos-feedback-type-row" });
    const bugBtn = typeRow.createEl("button", { cls: "mos-btn mos-btn-seg", text: "🐛 Report a bug" });
    const featBtn = typeRow.createEl("button", { cls: "mos-btn mos-btn-seg", text: "✨ Request a feature" });

    const select = (selected: "bug" | "feature") => {
      this.type = selected;
      bugBtn.toggleClass("is-active", selected === "bug");
      featBtn.toggleClass("is-active", selected === "feature");
    };

    bugBtn.addEventListener("click", () => select("bug"));
    featBtn.addEventListener("click", () => select("feature"));

    const textarea = contentEl.createEl("textarea", { cls: "mos-feedback-textarea" });
    textarea.placeholder = "Describe briefly…";
    textarea.rows = 4;
    textarea.addEventListener("input", () => { this.description = textarea.value.trim(); });

    const footer = contentEl.createDiv({ cls: "mos-feedback-modal-footer" });
    const status = footer.createSpan({ cls: "mos-feedback-status" });
    const submitBtn = footer.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Submit →" });

    submitBtn.addEventListener("click", () => {
      void (async () => {
        if (!this.type) { status.setText("Please select bug or feature request."); return; }
        if (!this.description) { status.setText("Please add a short description."); return; }
        if (!FEEDBACK_PROXY_URL) { status.setText("Feedback not configured."); return; }

        submitBtn.setAttr("disabled", "true");
        submitBtn.setText("Sending…");
        status.setText("");

        try {
          const res = await requestUrl({
            url: FEEDBACK_PROXY_URL,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${FEEDBACK_SECRET}`,
            },
            body: JSON.stringify({ type: this.type, description: this.description }),
            throw: false,
          });

          if (res.status === 429) {
            status.setText("Slow down — try again in a few minutes.");
            submitBtn.removeAttribute("disabled");
            submitBtn.setText("Submit →");
            return;
          }
          if (res.status < 200 || res.status >= 300) throw new Error(`${res.status}`);

          contentEl.empty();
          contentEl.addClass("mos-feedback-modal");
          contentEl.createDiv({ cls: "mos-feedback-success", text: "✓ Thanks! Feedback received." });
          const closeBtn = contentEl.createEl("button", { cls: "mos-btn mos-btn-primary", text: "Close" });
          closeBtn.addEventListener("click", () => this.close());
        } catch {
          submitBtn.removeAttribute("disabled");
          submitBtn.setText("Submit →");
          status.setText("Failed to send. Check your connection.");
        }
      })();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

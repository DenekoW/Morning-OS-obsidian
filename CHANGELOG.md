# Changelog

# 0.6.2

- Added linked and standalone Focus sessions with pause/resume, completion notes, daily totals, and Daily Note work-log syncing.
- Added daily/weekly Routines with check, duration, and count metrics, plus reading history and weekly activity summaries.
- Added count-based task progress, daily increment targets, guarded completion, and persistent progress events.
- Added an AI task assistant with task-query disambiguation, risk-based confirmation, activity history, and undo for supported writes.
- Expanded project continuity with editable Next actions, project rename/delete flows, and task/Routine association preservation.
- Added completion notes and idempotent task-completion Work Log entries in Daily Notes.
- Added automatic view refreshes after external edits to the Markdown task registry.
- Replaced personal examples with generic defaults and excluded local settings, credentials, dependencies, and proxy configuration from the public source tree.

# 0.6.1

- Added an `obsidian://morning-os` URL handler so external tools (like the Morning OS Float desktop widget) can jump straight to the Morning OS dashboard.

# 0.6.0

- Added a per-task pipeline bar (Start → Working → Collecting → Complete) on every Today task; click a segment to set the stage, click the final segment to complete the task through the normal completion flow.
- Added an "In flight" summary card above Today that lists every task currently in the pipeline, with per-stage counts — one glance shows everything in progress.
- Completing or reopening a task keeps its pipeline stage in sync automatically.

# 0.5.2

- Today now expands to the full dashboard width whenever the Rules/Suggestions support column is empty.
- Preserved the existing two-column layout when support content is actually visible.

# 0.5.1

- Task edits now auto-save before closing via X, Escape, or the modal backdrop.
- Renamed Cancel to Discard so abandoning changes is always explicit.
- Save failures keep the editor open and surface an error.

## v0.4.0

### Research operating system
- Added Focus as an ordered 1–3 task subset of Today.
- Added optional effort, context, execution state, project, and Focus metadata with backward-compatible Markdown persistence.
- Added deterministic Today workload and deep-work capacity summaries.
- Added collapsible Morning Planning completion state, compact project health/recency, and Shutdown continuity.
- Added provider-independent agent requests, structured proposals, scope validation, and explicit mutation review.
- Kept DeepSeek behind the shared provider boundary and added Plan my day, Review project, and Weekly review entry points.

## v0.2.0

### Personal

When I saw 53 people had downloaded Morning OS, I was genuinely happy. This started as my own morning app — knowing 53 of you use it made me sit down and fix every rough edge. Thank you.

### Changes

- New onboarding flow — setup is now guided and automatic
- Agent runs when you open the panel, not on a fixed schedule
- Carry detection survives skipped days
- Plugin works properly on mobile
- Reminders and backup system completely overhauled

---
---

## v0.2.2

### Personal

125 people now start their day with Morning OS. That number still surprises me every time I check.

This release is about feel. The plugin works - it has since v0.2.0 - but it felt like a settings panel. I wanted to open it every morning and actually enjoy looking at it. So I rebuilt the whole visual layer from scratch, added a way for you to tell me what's broken or what you want next, and made sure your reminders never silently disappear again.

If you're one of the 125 - thank you. Keep the feedback coming.

Next up: smarter agents, better personalization, and features I haven't told anyone about yet.

### Changes

- Completely overhauled UI — adapts to your Obsidian theme, amber accent for task signals
- Reminders now recover automatically from backup when the file is lost or corrupted
- Plugin re-runs the agent when today's brief is deleted and you reopen the panel
- What's New card — you're reading it right now
- Feedback button — tell me what's broken or what you want built next
- Goals collapse correctly on mobile, action buttons accessible via touch

---
---

## v0.3.1

### Personal

This one's bigger than it looks in a bullet list. Daily notes are gone as the way you manage tasks, the whole UI is rebuilt, and Areas replace the old rules/goals/tasks files - it's the biggest change since v0.2.0.

I'm not going to tell you the "right" way to use any of it. Areas, Inbox, sub-tasks, notes on tasks, the table view - take what's useful and skip what isn't. I'd rather ship something wide enough to bend to how you actually work than force one workflow on everyone.

If you're coming from 0.2.x, run the migration first (Settings → Vault → Migrate) - it's safe, idempotent, and brings your rules, goals, tasks, and full wins history over for you.

And I want to hear from you - what you use, what you ignore, what's confusing, what's missing. The feedback button actually reaches me now, so use it.

### Changes

- **No more daily notes.** In 0.2.2, tasks were checkboxes you typed into that day's note by hand — the plugin just read and displayed them. That's gone. Tasks now live in a real, persistent task list inside the plugin: check them off, add new ones, edit the text, split any task into sub-tasks, and attach notes — all directly in the UI, all saved on its own. Nothing to write into markdown anymore.
- **The whole app is reorganized around Areas.** The old setup — separate Tactical Rules, Emotional Rules, Goals, Technical Tasks, and Hobby Tasks files — is replaced by Areas: each part of your life gets one place with its own tasks, goals, and notes. Plus a proper Inbox for capturing things on the fly and a Trash so deleting is never permanent by accident.
- **Full visual redesign** — new floating glass panel, unified buttons, right-click context menus everywhere, urgency dots that flag tasks needing attention, and a table view with filters and sorting per Area.
- **One-time vault migration** (Settings → Vault → Migrate) moves everything — rules, goals, tasks, and your *entire* wins history, not just today's — into the new system for you. Paced so it won't overwhelm mobile file sync on large vaults, and safe to re-run if you're not sure it finished.
- **`[[links]]` and `#tags` in your tasks actually work now.** They used to just sit there as plain text even if you typed them — now they render as real links/tags and autocomplete as you type.
- **Wins are a real log now**, not text buried in a daily note that eventually gets archived and forgotten — yesterday's wins show up on the dashboard the next morning
- Feedback button now goes to a real inbox instead of just sitting there — the old channel got flooded by a bot and none of what you sent was actually getting through; that's fixed now
- A round of smaller fixes: wins log formatting cleaned up, migration no longer chokes on large vaults, and the API key banner only shows up when you're actually using AI mode
- Fixed a batch of code-quality issues flagged by Obsidian's community plugin review: type-safety gaps around date formatting, duplicate CSS properties, and a stale build artifact that didn't match the last release's source
- Known limitation: settings aren't searchable via Obsidian's new global settings search (added in 1.13) — the settings panel itself works exactly as before on every version, this only affects the new cross-plugin search box

### Note for people upgrading from 0.2.x

Run the migration from Settings → Vault before you start using Areas/Inbox/Trash — it moves your old daily-note tasks and rules into the new task registry and archives your daily notes. It's idempotent, so it's safe to run more than once if you're not sure it fully finished.
# 0.4.1

- Added a Home setting to hide AI Suggestions; Suggestions are hidden by default.
- Made DeepSeek planning request strict JSON with non-thinking mode.
- Added tolerant JSON extraction and a reviewable local fallback for Plan my day.
# 0.4.2

- Added a project-aware task composer from the Projects header and each project detail.
- Project tasks now choose an Eisenhower priority and an explicit Backlog or Today destination.
- Added direct editing for tasks listed inside Projects.
# 0.4.3

- Replaced internal task IDs in AI proposal review with task titles, projects, and priorities.
- Added a safe unavailable-task label when proposal state becomes stale.
# 0.4.4

- Added an explicit Create project entry in the Projects header.
- Projects now persist and display before they contain any tasks.
- Added validation for blank and case-insensitive duplicate project names.
# 0.5.0

- Separated Focus into a compact execution queue while keeping Today as the complete commitment inventory.
- Added quiet hover/focus controls to reorder or remove Focus items without affecting Today.
- Reworded Today effort summaries into human-readable estimation states.

# Morning OS

**Language: English | [中文](README.md)**

> An Obsidian morning workspace built around execution, reflection, and continuity.

This is a research- and workflow-focused customization of [Satya Akhil Galla's Morning OS](https://github.com/satyagalla/Morning-OS-obsidian). Building on the original Home, Inbox, Areas, and Trash, it adds Focus, a task pipeline, project continuity, focus timers, Routines, progress tracking, Daily Note work logs, and AI assistants that require review before making changes.

**Current version: 0.6.2 · Requires Obsidian 1.8.7 or later · Supports desktop and mobile**

## 1. Installation and setup

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the repository's `research-workflow` branch.
2. Create `.obsidian/plugins/morning-os/` in your vault and place the three files there.
3. Restart Obsidian and enable Morning OS under **Settings → Community plugins**.
4. Click the sun icon in the ribbon, choose an initialization root folder (`Essential` by default), and click **Initialize system**.
5. Under **Settings → Morning OS**, adjust paths, Home modules, task behavior, and AI services as needed.

The repository intentionally does not include `data.json`. On first launch, the plugin uses generic defaults and generates this file locally. Your paths, Areas, API keys, and runtime state are not published with the source code.

### Build from source

```bash
npm install
npm test
npm run build
```

After building, copy `main.js`, `manifest.json`, and `styles.css` to the plugin directory above.

For development, you can also run:

```bash
npm run dev      # Watch builds; copies automatically when OBSIDIAN_PLUGIN_DIR is set
npm run deploy   # Production build and copy to OBSIDIAN_PLUGIN_DIR
```

## 2. Recommended daily workflow

1. **Capture**: Add tasks quickly in Inbox, then assign them to an Area or Project later.
2. **Plan**: In Morning Planning, review unfinished tasks, project suggestions, and continuable progress tasks. Move the work you intend to do into Today.
3. **Focus**: Choose 1–3 ready tasks from Today and place them in an ordered Focus queue.
4. **Advance**: Update stages with the Start / Working / Collecting / Complete pipeline. Use progress and daily targets for quantifiable work.
5. **Log**: Focus sessions, reading, Routines, task progress, and completions can be written to the Daily Note's Work Log.
6. **Close**: In Shutdown, record what is still on your mind and choose a candidate for tomorrow's first task.

## 3. Core features

### Focus: an execution queue of 1–3 tasks

- Focus is an ordered subset of Today, not a separate task list.
- Focus is intended for Today tasks marked **Ready**. Waiting or Blocked tasks are removed from Focus.
- Use the task menu to assign `Focus #1`, `Focus #2`, or `Focus #3`, or reorder tasks with the up/down controls.
- **Remove** removes a task from Focus only; it remains in Today.
- Click **Start** to time a linked task, or use **+ Focus** to start a standalone session that is not linked to a task.
- Sessions support pause, resume, finish, finish with a note, and discard. Home shows total focus time and session count for the day.

### Today and the task pipeline

- Today is the complete inventory of daily commitments, divided into Red alert and Regular.
- Every task has a **Start → Working → Collecting → Complete** stage bar.
- **In flight** summarizes unfinished tasks that have entered the pipeline, with counts by stage.
- Clicking Complete uses the normal task-completion flow. Reopening a task also returns its pipeline to an incomplete state.
- Tasks support subtasks, notes, reminders, projects, Eisenhower priority, effort estimates, context, and execution state.
- Closing the task editor with X, Escape, or the backdrop saves changes first. Only **Discard** explicitly abandons them.

### Morning Planning

- Collects unfinished tasks from previous days, suggested project next actions, and continuable progress tasks.
- Set a daily increment target for a progress task or move a Backlog task into Today.
- If you selected a first-task candidate during last night's Shutdown, you can start it directly from here.
- **Complete planning** records planning completion and writes `Today's Plan` when Daily Note syncing is enabled.
- **Plan my day** generates a reviewable planning proposal. A deterministic local fallback is available when AI is unavailable.

### Projects

- Projects exist independently of tasks, so empty projects are preserved.
- Each project can have one explicit **Next action**, linked to an editable task.
- When creating a project task, choose an Eisenhower priority and whether it goes to Backlog or Today.
- Projects can be edited, renamed, or deleted. Deleting a project does not delete its tasks or Routines; it only removes their project association.
- **Review project** and **Weekly review** use AI proposals to assist reflection, with confirmation required before changes are applied.

### Routines, reading, and progress

- Routines support Daily / Weekly cadences and Check / Duration / Count metrics.
- Set targets and units, link Routines to projects, log progress, and correct accumulated values.
- Reading entries distinguish **Read** from **Skim**. Only Read entries count toward weekly reading goals.
- Tasks can have total progress (current value, target, and unit) plus a daily increment target.
- **Log progress** can add progress or set the total directly. A progress task cannot be completed before its overall target is reached.

### Shutdown and next-day continuity

- Summarizes focus time and session count for the day.
- Records `Still on my mind` and selects `Tomorrow’s first task candidate`.
- **Close the day** saves this state and writes the Shutdown section when Daily Note syncing is enabled.

### Inbox, Areas, and Trash

- **Inbox**: Capture quickly and organize later.
- **Areas**: Organize tasks, goals, and notes by life or work area, with custom tabs, fields, and card or table views.
- **Trash**: Soft-delete tasks to avoid immediate accidental loss.
- `[[links]]` and `#tags` in task text are rendered and supported by input completion.

## 4. AI features and safety boundaries

### Supported providers

OpenAI, DeepSeek, Google Gemini, Groq, and AWS Bedrock.

Choose a provider and enter credentials under **Settings → Morning OS → AI provider**. Adjust the model ID when required by your service.

### Without an API key

- Turn off **Use AI for briefings** to build briefings directly from local vault content without contacting an AI service.
- Local tasks, Focus, Projects, Routines, timers, progress, and Daily Note features remain available.
- Plan my day has a local fallback. Other features that require model interpretation or generation need working credentials.

### Review before writes

- Plan my day, Review project, and Weekly review return structured proposals instead of directly rewriting tasks.
- Proposals display task titles, projects, and priorities rather than internal task IDs.
- Changes are applied only after validation and confirmation in the review window.
- **Ask AI** in Morning Planning supports task queries and actions. Writes are confirmed according to risk, recorded in Recent AI activity, and can be undone where supported.

### Data and credentials

- With AI disabled, briefings are generated locally.
- With AI enabled, tasks, projects, goals, or configured Area content relevant to the current feature are sent to the selected provider. The plugin does not upload the entire vault as a prompt.
- API keys are stored in Obsidian's local `data.json`. **Never commit, share, or publicly screenshot this file.**
- The repository ignores `data.json`, and credential fields in the source are empty.

## 5. Files and syncing

The main files are listed below. All paths are relative to the vault root:

```text
00-MOC/Morning OS Tasks.md       # Markdown task registry
_generated/briefs/               # Daily briefs
_generated/activity-state.json   # Routine, focus, and reading state
_generated/progress-events.json  # Task progress events
_generated/project-state.json    # Project state and Next actions
_generated/workflow/             # Daily Planning / Shutdown state
_generated/ai-task-activity.json # AI task actions and undo history
_generated/backups/              # Migration and recovery backups
Essential/Daily/YYYY-MM-DD.md    # Default Daily Note directory; configurable
```

Daily Note syncing is controlled by **Task behavior → Sync tasks to today’s Daily Note**. The task block updates only an existing Daily Note for the current day; planning, work-log, and Shutdown services create the note when required by the feature. If Obsidian's Daily Notes core plugin has a configured folder, that folder takes precedence over the Morning OS fallback directory.

The task registry is human-readable Markdown. When editing it manually, preserve the `morning-os` metadata comments beneath each item. When an external tool or sync process changes the registry, the plugin automatically reloads it and refreshes its views.

External tools can also open Morning OS with this URL:

```text
obsidian://morning-os?vault=<URL-encoded vault name>
```

## 6. Migrating from an older version

If you are upgrading from 0.2.x or another early Daily Note-based version:

1. Back up the entire vault first.
2. Under **Settings → Morning OS → Vault migration**, run **Migrate vault to areas**.
3. Check that your Areas, tasks, goals, and Wins are complete.

Migration is idempotent, and old files are archived to `_archive/pre-migration/`. An existing `_generated/tasks.json` is migrated to the Markdown registry. A backup is retained before Area information is recovered.

## 7. Privacy-friendly repository conventions

- `data.json`, dependency directories, environment files, and local proxy configuration are excluded from version control.
- Documentation and tests use generic examples only, without personal vault paths, real project names, task content, or credentials.
- Run `npm test` and `npm run build` before publishing, and check build artifacts for proxy URLs or secrets injected through environment variables.

See [CHANGELOG.md](CHANGELOG.md) for the complete version history. The original project and license belong to their original author; this branch retains the MIT License.

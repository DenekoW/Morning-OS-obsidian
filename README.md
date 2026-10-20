# Morning OS

[![Obsidian Plugin](https://img.shields.io/badge/Obsidian-Plugin-7c3aed?logo=obsidian&logoColor=white)](https://community.obsidian.md/plugins/morning-os)
[![Downloads](https://img.shields.io/badge/dynamic/json?url=https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json&query=%24%5B%22morning-os%22%5D.downloads&label=downloads&color=7c3aed)](https://community.obsidian.md/plugins/morning-os)

Manage your tasks, notes, and life areas inside Obsidian, then bring your priorities together on a focused Home dashboard. Add your rules and goals for a daily briefing, with optional AI curation.

[![Morning OS dashboard in dark mode](images/dashboard-dark.png)](images/dashboard-dark.png)

## What you can do

| Feature | How it works |
|---|---|
| **Home** | See your Today items alongside identity, goals, rules, suggestions, and wins. Identity, goals, and rules have visibility settings. |
| **Inbox** | Capture tasks and notes, then organize them into Areas and tabs. Unorganized groups stay in Inbox while the parent or a child is active. |
| **All Items** | Browse non-deleted tasks and notes, with search and filters. |
| **Areas** | Organize work and personal life with configurable Areas, tabs, card or table views, and custom fields. Advanced Area features are optional. |
| **Tasks and notes** | Add sub-tasks, priority, reminders, and metadata. Complete or dismiss tasks; archive notes. |
| **Today** | Explicitly select the items you want to focus on. Red alert and regular priorities keep urgent work visible. |
| **Reminders** | Due date reminders bring active items into Today when the plugin processes them. Each reminder occurrence is handled once. |
| **Wins** | Record wins from Home into your configured Wins log. |
| **Trash and recovery** | Restore deleted items, permanently delete them, or recover item state from verified snapshots. |

Today is a persistent selection. Items stay selected across days until you complete, dismiss, archive, delete, or explicitly remove them. Removing a reminder-promoted item from Today does not bring that same reminder occurrence back; explicitly reset the reminder to create another occurrence.

Tasks and notes are stored in `_generated/data/state.json`. You manage them directly in the plugin; a daily note is not required for everyday task management.

[![Morning OS dashboard in light mode](images/dashboard-light.png)](images/dashboard-light.png)

## Setup

Requires **Obsidian 1.11.4 or later**. The core plugin works on desktop, iOS, and Android without a terminal, subprocesses, or native dependencies.

1. Install and enable **Morning OS** from **Settings → Community plugins → Browse**.
2. Click or tap the sun icon to open Morning OS.
3. Choose a root folder during onboarding. Morning OS creates Area notes, an Identity Anchor, and a Wins log, with sample rules and goals to get started. Existing files are preserved.
4. Add tasks or notes in Inbox, organize them into Areas, and select your priorities for Today.
5. Edit your Area notes with your own rules and goals, then use **Regenerate briefing** to update Home.

**No API key is required.** You can manage items and generate a briefing directly from your configured notes. For AI curation and new suggestions, enable **Use AI for briefings** in Morning OS settings, select a provider, and enter its credentials.

Supported providers: **OpenAI, Google Gemini, Groq, and AWS Bedrock**.

## Briefings and optional AI

Onboarding generates an initial briefing. After setup, **Regenerate briefing** is the explicit action that rebuilds it. Opening a view, editing a task, or receiving synced state does not trigger an AI call or regenerate the briefing.

The briefing reads mapped sections from your Area Markdown notes and recent entries from your Wins log. With AI enabled and credentials configured, it also uses task context to curate rules and goals, order wins, and generate suggestions. You can choose AI or direct mode for individual briefing sections and adjust the displayed counts.

Area **Feed to LLM** permissions control Area-note input and item context. An item assigned to multiple Areas is eligible only when every assigned Area permits it; selecting it for Today does not override those permissions. The prompt also includes yesterday's wins and completed-task text, so Area permissions should not be treated as a blanket exclusion for all historical content.

With AI disabled or no credentials available, briefing fields use your source content directly. New AI suggestions require a provider call. AI output supplies briefing content; it does not edit your source notes or task state.

Briefings are saved to `_generated/briefs/YYYY-MM-DD.json`. They contain rules, goals, suggestions, and wins. Home reads tasks and notes separately from the current item state, so item changes appear without regenerating a briefing.

## Your vault files

With the default onboarding root, the structure looks like this:

```text
Essential/
  Areas/
    Health.md                     # Example tactical and emotional rules
    Career.md                     # Example short- and long-term goals
    ...                           # Other configured Areas
  Identity-Anchor.md
  Wins.md                         # Wins entered from Home
_generated/
  data/
    state.json                    # Authoritative tasks and notes
    settings.json                 # Optional, explicitly initialized shared settings
  briefs/
    YYYY-MM-DD.json
  snapshots/                      # Verified item-state backups
  recovery/                       # Preserved recovery files
  widgets/                        # Default widget-note destinations
  feedback/
    reactions/
```

The default briefing section mappings are `Tactical Rules`, `Emotional Rules`, `Short Term`, and `Long Term`. For example, an Area note can contain:

```markdown
## Tactical Rules
- Start the hardest task within 15 minutes of sitting down

## Short Term
- Finish the portfolio update this week

## Long Term
- Build a sustainable independent career
```

Configure Area briefing sources, section mappings, source paths, and output paths in settings. Daily-note and older source-file settings remain for legacy migration; daily-note checkboxes are not the current task store. If present, `_generated/tasks.json` is retained as a legacy migration source.

## Mobile and sync

[![Morning OS mobile view](images/mobile.png)](images/mobile.png)

Install Morning OS on each device and use your vault sync provider to transfer its data. Sync must include `_generated/data/state.json` for tasks and notes to travel between devices, plus your source notes and briefing files for the same Home content.

| Data | What to sync |
|---|---|
| `_generated/data/state.json` | Tasks, notes, Today selections, reminders, and occurrence acknowledgements. |
| Area notes, Identity Anchor, Wins log, and `_generated/briefs/` | Briefing sources and saved briefing content. |
| `_generated/data/settings.json` | Shared preferences, once explicitly initialized. |
| Widget Markdown destinations | Display notes for widgets on other devices. |
| `_generated/snapshots/` and `_generated/recovery/` | Recovery files, if included by your sync rules. These are not a complete vault backup. |

Plugin configuration under `.obsidian/plugins/morning-os/` contains device-local credentials, widget export configuration, and runtime settings. Keep it out of sync; configure credentials and widget exports separately on each device.

### Sharing preferences across devices

Shared settings are optional. They include Areas, tabs, fields, privacy permissions, Home and briefing preferences, and source paths. Credentials, widget exports, onboarding, and runtime bookkeeping remain local.

1. Update Morning OS on every device. Older plugin versions cannot read the current schema 4 item state.
2. Choose a baseline device and open **Settings → Morning OS → General → Shared vault settings → Initialize from this device**.
3. Sync `_generated/data/settings.json` before opening the updated plugin on the other devices. They adopt the delivered configuration without initializing their own defaults.

Initialization preserves a credential-free configuration backup. If an adopted shared settings file becomes missing or invalid, the plugin retains its last-good configuration and blocks shared edits until the valid file returns. Concurrent edits to the same shared field report conflicts. Vault sync does not guarantee lossless concurrent offline edits; test your setup in a disposable two-device vault first.

### Remotely Save configuration

On each device, keep **Sync config directory** disabled and enable **Sync underscore items**. Check include/exclude rules for all source and output paths you use.

If using **Regex of paths to allow**, this example includes the default source folder and all generated content:

```regex
^Essential(?:/|$)
^_generated(?:/|$)
```

This is an allowlist: add rules for any other source folders or widget destinations. It includes snapshots, recovery files, feedback, and transaction artifacts under `_generated/` as well as active state. Transaction artifacts are not cross-device locks.

Morning OS refreshes views when delivered item state or shared settings change. Remotely Save transfers vault files; it does not run Morning OS while Obsidian is closed or deliver calendar alerts. See [shared settings behavior](docs/architecture.md#shared-settings) for details.

## Home Screen widget notes

Export Identity, short- or long-term goals, Today tasks, Inbox tasks, or All tasks to an owned Markdown note through **Settings → Morning OS → General → Widget notes**. Add an export, choose its source and destination, and enable it. Use **Refresh widget notes** from the command palette for a manual refresh.

On iPhone or iPad, select the exported note in Obsidian's **View Note** Home Screen widget, bookmarking it first if required by the installed app's picker. Widget notes are display-only: editing their text or checkboxes does not update items.

A synced note can be selected on another device, but its export configuration stays local. Configure a local export there if that device should refresh it. Refresh timing depends on Obsidian running and your sync provider. See [widget setup and limitations](docs/widgets.md).

## Backups and recovery

Open **Settings → Morning OS → Advanced → Data safety & recovery** to create a verified backup, export item state, or restore a supported snapshot. Restore replaces the whole Morning OS item state rather than merging changes.

The plugin also snapshots before migration and at most once per changed local day. It retains the latest 20 automatic snapshots; manual and recovery copies are protected. Invalid or unsupported active state blocks ordinary writes instead of being replaced with an empty task list. Snapshots cover item state, so keep your normal vault backup as well. See [generated files and retention](docs/generated-files.md).

## Experimental Google Calendar reminders

An optional, disabled-by-default publisher is available under **Settings → Morning OS → Calendar (experimental)**. It requires an operator-controlled HTTPS OAuth relay, one explicitly selected publishing device, and a plugin-created dedicated test calendar.

This integration remains experimental and has not passed the device acceptance gates for general use. Mobile login and calendar-client notification behavior still need real-device verification. Google credentials stay in device-local Obsidian SecretStorage. See [calendar setup and acceptance limits](docs/calendar.md) before testing it in a disposable vault.

## Privacy and feedback

The plugin reads configured source notes and its own item state for briefings; it does not scan the whole vault for AI context. Provider calls require AI to be enabled, an AI section to need a call, and credentials to be available. The prompt includes the selected briefing inputs described above, rather than your full vault.

Optional calendar publishing sends reminder titles and schedules with ownership metadata to Google through the configured integration. Submitting in-app feedback posts to an external proxy only when that build has feedback proxy configuration; otherwise the form reports that feedback is not configured. You can always [open a GitHub issue](https://github.com/satyagalla/Morning-OS-obsidian/issues).

## Development

```bash
npm install
npm run build    # Type-check and create a production build
npm test         # Run state, UI, widget, and integration tests
npm run dev      # Watch, build, and copy to the configured vault
npm run deploy   # Type-check, build, and copy to the configured vault
```

`npm run dev` and `npm run deploy` write to the vault selected by `OBSIDIAN_PLUGIN_DIR`; the build configuration includes a default path. Set it to a disposable test vault before using those commands. `npm run build` and `npm test` do not deploy the plugin.

See [commands](docs/commands.md), [architecture](docs/architecture.md), and [extending the briefing agent](docs/extending-the-agent.md) for contributor details.

---

Built by [@satyagalla](https://github.com/satyagalla) · [Report an issue](https://github.com/satyagalla/Morning-OS-obsidian/issues)

# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-09-06
- Primary product surfaces: Home dashboard, task editor, proposal review, settings
- Evidence reviewed: current deployed `main.js`, `styles.css`, task registry, historical local patch scripts, upstream TypeScript source

## Brand
- Personality: calm, research-oriented, decisive, lightweight
- Trust signals: deterministic counts, explicit state, review-before-write AI
- Avoid: Jira density, gamification, fake progress, decorative analytics, generic chat

## Product goals
- Goals: answer what to do now, preserve daily commitments, expose project health, close the day cleanly
- Non-goals: habit tracker, time tracker, project-management suite, autonomous vault editor
- Success signals: Focus stays at 1–3 ready tasks; stale projects are visible; planning and shutdown can be completed without opening another view

## Personas and jobs
- Primary personas: a researcher managing several uncertain, non-linear projects
- User jobs: choose executable work, control Today scope, expose blockers, preserve tomorrow's continuity
- Key contexts of use: morning planning, task execution, project review, end-of-day shutdown

## Information architecture
- Primary navigation: Home, Inbox, Areas, Trash
- Core Home order: Focus, Today, Planning, Projects, Shutdown; optional support modules such as Suggestions stay hidden unless explicitly enabled
- Content hierarchy: current execution before commitments; commitments before review; review before historical/supporting content

## Design principles
- One source of truth: Focus is an ordered Today subset, never a parallel task state
- Distinct information density: Focus is a quiet execution queue; Today is the complete commitment inventory and owns priority/status detail
- Show uncertainty honestly: known effort and unknown counts are separate
- Require consent: agent proposals never mutate state before review
- Human-readable review: proposal rows show task titles and relevant metadata; internal record IDs never appear in the interface
- Fail usefully: planning falls back to a deterministic, reviewable local proposal when the AI provider is unavailable
- Tradeoffs: compact project summaries hide task detail until expanded

## Visual language
- Color: warm Obsidian surface, green primary actions, red only for alerts/blocked state
- Typography: existing interface font with clear size/weight hierarchy
- Spacing/layout rhythm: generous 16–24px section spacing
- Shape/radius/elevation: restrained existing radii, borders over shadows
- Motion: short existing transitions; no celebratory motion
- Imagery/iconography: functional symbols only

## Components
- Existing components to reuse: cards, task rows, chips, settings controls, modals
- New/changed components: compact Focus queue, workload summary, planning disclosure, project health row, project creator, project-task composer, shutdown form, proposal review modal
- Variants and states: empty, ready, waiting, blocked, stale, completed, AI error
- Token/component ownership: `styles/styles.css` Morning OS tokens and component classes

## Accessibility
- Target standard: practical WCAG 2.1 AA
- Keyboard/focus behavior: native buttons, inputs, selects, details/summary; visible focus states
- Contrast/readability: red is not the only blocked indicator; text labels accompany state
- Screen-reader semantics: headings follow dashboard hierarchy; controls use explicit text
- Reduced motion and sensory considerations: honor Obsidian motion preferences; no essential animated state

## Responsive behavior
- Supported breakpoints/devices: Obsidian desktop and mobile, minimum 320px width
- Layout adaptations: Today/support uses two columns only when support content exists; an empty support column is removed and Today expands to full width; metadata wraps
- Touch/hover differences: all primary actions remain visible/tappable without hover

## Interaction states
- Loading: Obsidian notice for agent work
- Empty: actionable copy for Focus, Today, Projects, and proposals
- Error: concise notice; no partial mutations
- Save failure: keep the task editor open and show the error instead of silently dismissing the draft
- Success: state refresh plus restrained check label
- Disabled: proposal approval disabled when no mutations exist
- Offline/slow network: deterministic dashboard remains usable; Plan my day offers a clearly labelled local fallback

## Content voice
- Tone: concise, neutral, operational
- Terminology: Focus, Today, Morning Planning, Projects, Shutdown; use “candidate” when tomorrow is not committed
- Microcopy rules: do not call multi-day carryover “yesterday”; never imply unknown effort is zero
- Task creation rules: project tasks default to Backlog; moving them into Today requires an explicit destination choice
- Project creation rules: projects have an explicit creation entry and persist independently of tasks; names are unique ignoring case
- Focus copy rules: show rank, title, and only optional project/context/effort; priority remains in Today; reorder/remove actions appear on hover or keyboard focus
- Task editor close rules: closing via X, Escape, or backdrop saves dirty edits before dismissal; only the explicitly labelled Discard action abandons changes

## Implementation constraints
- Framework/styling system: Obsidian TypeScript plugin, DOM APIs, esbuild
- Design-token constraints: extend existing `--mos-*` variables
- Performance constraints: selectors operate on the task registry only; no whole-vault prompt or scan
- Compatibility constraints: Obsidian 1.11.4+; missing metadata defaults safely; current Markdown task registry remains readable/editable
- Test/screenshot expectations: domain unit tests, existing regression tests, desktop/mobile visual smoke check

## Open questions
- [ ] Whether project recency should later include configured project-note file activity; current release uses project/task state changes only.

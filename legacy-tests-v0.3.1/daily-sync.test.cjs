const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const bundle = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

function dailySyncApi() {
  const start = bundle.indexOf('var mt = "00-MOC/Morning OS Tasks.md"');
  const end = bundle.indexOf("function ke(", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const source = bundle.slice(start, end);
  return Function(
    "H",
    `${source};return {ae,G,configureDailyTaskSync,upsertDailyTaskBlock};`,
  )(() => "2026-09-04");
}

function mockApp(withDailyNote = true) {
  const files = new Map([
    [".obsidian/daily-notes.json", JSON.stringify({ folder: "Daily" })],
  ]);
  if (withDailyNote) {
    files.set("Daily/2026-09-04.md", "## Thoughts\n\nExisting text\n");
  }
  const adapter = {
    exists: async (file) =>
      files.has(file) || file === "00-MOC" || file === "Daily",
    read: async (file) => {
      if (!files.has(file)) throw new Error(`missing ${file}`);
      return files.get(file);
    },
    write: async (file, value) => files.set(file, value),
    mkdir: async () => {},
    remove: async (file) => files.delete(file),
  };
  return { app: { vault: { adapter } }, files };
}

test("saving today's tasks adds one managed block to the configured Daily Note", async () => {
  const { ae, G, configureDailyTaskSync } = dailySyncApi();
  configureDailyTaskSync({
    dailyNoteDir: "fallback",
    syncTasksToDailyNote: true,
    dailyTaskHeading: "Morning OS Tasks",
  });
  const { app, files } = mockApp();
  const todayTask = ae("Finish draft", {
    project: "Paper",
    eisenhower_priority: "urgent_important",
    planned_date: "2026-09-04",
  });
  const backlogTask = ae("Later task", { project: "Paper" });
  await G(app, [todayTask, backlogTask]);
  let note = files.get("Daily/2026-09-04.md");
  assert.match(note, /- \[ \] Finish draft — Project: Paper · 紧急且重要/);
  assert.doesNotMatch(note, /Later task/);
  assert.equal(note.split("<!-- morning-os:tasks:start -->").length - 1, 1);

  todayTask.status_completion = "done";
  todayTask.date_completed = "2026-09-04";
  await G(app, [todayTask, backlogTask]);
  note = files.get("Daily/2026-09-04.md");
  assert.match(note, /- \[x\] Finish draft/);
  assert.equal(note.split("<!-- morning-os:tasks:start -->").length - 1, 1);
  assert.match(note, /Existing text/);
});

test("sync does not create a Daily Note before the user's template does", async () => {
  const { ae, G, configureDailyTaskSync } = dailySyncApi();
  configureDailyTaskSync({ syncTasksToDailyNote: true, dailyNoteDir: "Daily" });
  const { app, files } = mockApp(false);
  await G(app, [ae("Today", { planned_date: "2026-09-04" })]);
  assert.ok(!files.has("Daily/2026-09-04.md"));
});

test("bundle exposes Daily Note sync settings", () => {
  assert.ok(bundle.includes("syncTasksToDailyNote:!0"));
  assert.ok(bundle.includes('setName("Sync tasks to today’s Daily Note")'));
  assert.ok(bundle.includes("configureDailyTaskSync(this.settings)"));
});

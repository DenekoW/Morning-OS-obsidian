const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const bundle = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

function storageApi() {
  const start = bundle.indexOf('var mt = "00-MOC/Morning OS Tasks.md"');
  const end = bundle.indexOf("function ke(", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const source = bundle.slice(start, end);
  return Function("H", `${source};return {ln,ae,O,G,parseTaskMarkdown,serializeTaskMarkdown}`)(
    () => "2026-09-04",
  );
}

test("Markdown task registry round-trips project and planning metadata", () => {
  const { ae, parseTaskMarkdown, serializeTaskMarkdown } = storageApi();
  const task = ae("Write the paper", {
    areas: ["career"],
    project: "Paper revision",
    eisenhower_priority: "important_not_urgent",
    planned_date: "2026-09-04",
  });
  const markdown = serializeTaskMarkdown([task]);
  assert.match(markdown, /## Project: Paper revision/);
  assert.match(markdown, /- \[ \] Write the paper/);
  const restored = parseTaskMarkdown(markdown)[0];
  assert.equal(restored.project, "Paper revision");
  assert.deepEqual(restored.areas, ["career"]);
  assert.equal(restored.eisenhower_priority, "important_not_urgent");
  assert.equal(restored.planned_date, "2026-09-04");
  assert.equal(restored.is_today, true);
});

test("legacy JSON migrates once to Markdown without deleting the source", async () => {
  const { O } = storageApi();
  const files = new Map([
    [
      "_generated/tasks.json",
      JSON.stringify([
        {
          _id: "legacy-1",
          text: "Migrated task",
          project: "Thesis",
          is_today: true,
        },
      ]),
    ],
  ]);
  const adapter = {
    exists: async (file) => files.has(file) || file === "00-MOC",
    read: async (file) => {
      if (!files.has(file)) throw new Error(`missing ${file}`);
      return files.get(file);
    },
    write: async (file, value) => files.set(file, value),
    mkdir: async () => {},
    remove: async (file) => files.delete(file),
  };
  const tasks = await O({ vault: { adapter } });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].planned_date, "2026-09-04");
  assert.ok(files.has("00-MOC/Morning OS Tasks.md"));
  assert.ok(files.has("_generated/tasks.json"));
  assert.ok(!files.has("00-MOC/Morning OS Tasks.md.tmp"));
});

test("legacy is_today becomes today's planned_date and old plans become carryover", () => {
  const { ln } = storageApi();
  const migrated = ln({ text: "legacy", is_today: true });
  assert.equal(migrated.planned_date, "2026-09-04");
  assert.equal(migrated.is_today, true);
  const carryover = ln({ text: "old", planned_date: "2026-09-03" });
  assert.equal(carryover.is_today, false);
  assert.equal(carryover.planned_date, "2026-09-03");
});

test("plain Markdown checkbox tasks are accepted", () => {
  const { parseTaskMarkdown } = storageApi();
  const tasks = parseTaskMarkdown("# Tasks\n\n- [ ] Manually added task\n");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].text, "Manually added task");
  assert.equal(tasks[0].status_completion, "open");
});

test("moving a checkbox between Project headings changes its project", () => {
  const { parseTaskMarkdown } = storageApi();
  const tasks = parseTaskMarkdown(
    "## Project: New project\n\n- [x] Moved task\n" +
      '  <!-- morning-os {"_id":"moved-1","project":"Old project"} -->\n',
  );
  assert.equal(tasks[0].project, "New project");
  assert.equal(tasks[0].status_completion, "done");
  assert.equal(tasks[0].date_completed, "2026-09-04");
});

test("planning UI and project editing are wired", () => {
  assert.ok(bundle.includes("renderMorningPlanning(a)"));
  assert.ok(bundle.includes('text:"Morning planning"'));
  assert.ok(bundle.includes('text:"昨日未完成"'));
  assert.ok(bundle.includes('text:"Project backlog"'));
  assert.ok(bundle.includes('this.field(t,"Project")'));
  assert.ok(bundle.includes('planned_date:H()'));
});

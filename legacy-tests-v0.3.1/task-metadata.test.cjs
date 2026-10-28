const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const bundle = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

function extract(startMarker, endMarker) {
  const start = bundle.indexOf(startMarker);
  const end = bundle.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return bundle.slice(start, end);
}

test("task metadata keeps Project separate from Area and maps Eisenhower priority", () => {
  const source = extract("var EisenhowerLabels", "function renderTaskMeta");
  const applyTaskMetadata = Function(`${source};return applyTaskMetadata`)();

  assert.deepEqual(
    applyTaskMetadata(
      { project: "Paper revision", eisenhower_priority: "urgent_important" },
      { is_today: true, areas: ["career"] },
    ),
    {
      eisenhower_priority: "urgent_important",
      status_priority: "red",
      is_today: true,
      areas: ["career"],
      project: "Paper revision",
    },
  );
  assert.equal(
    applyTaskMetadata(
      { project: "Paper revision", eisenhower_priority: "important_not_urgent" },
      { status_priority: "regular", areas: ["health"] },
    ).status_priority,
    "regular",
  );
  assert.deepEqual(
    applyTaskMetadata(
      { project: "Paper revision", eisenhower_priority: "important_not_urgent" },
      { areas: ["health"] },
    ).areas,
    ["health"],
  );
});

test("task registry creation and normalization preserve Project, priority, and Area", () => {
  const source = extract('var mt = "00-MOC/Morning OS Tasks.md"', "function ke(");
  const { ae, ln } = Function("H", `${source};return {ae,ln}`)(
    () => "2026-09-04",
  );
  const created = ae("Write tests", {
    areas: ["career"],
    project: "Paper revision",
    eisenhower_priority: "urgent_not_important",
  });
  assert.deepEqual(created.areas, ["career"]);
  assert.equal(created.project, "Paper revision");
  assert.equal(created.eisenhower_priority, "urgent_not_important");

  const normalized = ln(created);
  assert.deepEqual(normalized.areas, ["career"]);
  assert.equal(normalized.project, "Paper revision");
  assert.equal(normalized.eisenhower_priority, "urgent_not_important");
  assert.equal(ln({ text: "legacy task" }).eisenhower_priority, "");
  assert.equal(ln({ text: "legacy task" }).project, "");
});

test("bundle contains board link and metadata-enabled capture surfaces", () => {
  assert.ok(bundle.includes('taskBoardPath:"00-MOC/Morning OS Tasks.md"'));
  assert.ok(bundle.includes("workspace.openLinkText(this.settings.taskBoardPath"));
  assert.equal(bundle.split("{metadata:!0").length - 1, 4);
  for (const label of ["重要不紧急", "紧急不重要", "紧急且重要"]) {
    assert.ok(bundle.includes(label));
  }
  assert.ok(bundle.includes('this.field(t,"优先级")'));
  assert.ok(bundle.includes("renderTaskMeta(g,t,n&&n.settings?n.settings.areas:[])"));
  assert.ok(bundle.includes("renderTaskMeta(r,n,this.settings.areas)"));
  assert.ok(bundle.includes('this.field(t,"Project")'));
});

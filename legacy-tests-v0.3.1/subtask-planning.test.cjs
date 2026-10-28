const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const bundle = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

test("new subtasks inherit their parent's planned date in both creation flows", () => {
  assert.equal(bundle.split("planned_date:n.planned_date").length - 1, 1);
  assert.equal(bundle.split("planned_date:t.planned_date").length - 1, 1);
});

test("subtask rows can independently enter and leave Today", () => {
  assert.ok(bundle.includes('attr:{title:"Remove from Today"}'));
  assert.ok(bundle.includes("await se(e,t._id,{planned_date:D})"));
  assert.ok(bundle.includes('attr:{title:"→ Today (Regular)"}'));
  assert.ok(bundle.includes('attr:{title:"→ Today (Red alert)"}'));
});

test("Project lists and Morning planning include visible subtasks", () => {
  assert.ok(bundle.includes('a=this.registry.filter(d=>!d.is_deleted&&d.status_completion==="open")'));
  assert.ok(bundle.includes('x.parent_id?" mos-project-subtask-row":""'));
  assert.ok(bundle.includes('w.parent_id?`↳ ${w.text}`:w.text'));
  assert.ok(!bundle.includes('d.parent_id===null&&d.status_completion==="open"'));
});

test("Today nests only subtasks that are independently planned for today", () => {
  assert.ok(bundle.includes("ke(this.registry,n._id).filter(h=>h.planned_date===H())"));
});

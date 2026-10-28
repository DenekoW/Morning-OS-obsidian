const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const bundle = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

test("Project choices are derived, deduplicated, and sorted from tasks", () => {
  const start = bundle.indexOf("function projectNamesFromTasks(");
  const end = bundle.indexOf("async function resolveDailyTaskNotePath", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const projectNamesFromTasks = Function(`${bundle.slice(start, end)};return projectNamesFromTasks`)();
  assert.deepEqual(projectNamesFromTasks([
    { project: "Paper" }, { project: "Code" }, { project: " Paper " }, { project: "" },
  ]), ["Code", "Paper"]);
});

test("task capture and editor expose existing Project choices", () => {
  assert.ok(bundle.includes('createEl("datalist"'));
  assert.equal(bundle.split("projects:this.registry").length - 1, 4);
  assert.ok(bundle.includes("projectNamesFromTasks(this.projectOptions)"));
  assert.ok(bundle.includes('placeholder:"选择或新建 Project"'));
});

test("Project task lists and Today are separate home sections", () => {
  assert.ok(bundle.includes("renderProjectTaskLists(a)"));
  assert.ok(bundle.includes('text:"Project task lists"'));
  assert.ok(bundle.includes('text:"Today"'));
  assert.ok(bundle.includes('text:S?"移出 Today":"加入 Today"'));
  assert.ok(bundle.includes('text:S?"Today":"Backlog"'));
});

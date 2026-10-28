const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const bundle = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

test("Today and Wins render before Morning planning", () => {
  const renderStart = bundle.indexOf('this.renderHeader(a),this.renderIdentityStrip(a)');
  const renderEnd = bundle.indexOf('this.renderFeedbackFooter(a)', renderStart);
  assert.notEqual(renderStart, -1);
  assert.notEqual(renderEnd, -1);
  const sequence = bundle.slice(renderStart, renderEnd);
  const today = sequence.indexOf("this.renderTasks(o)");
  const wins = sequence.indexOf("this.renderWins(a)");
  const planning = sequence.indexOf("this.renderMorningPlanning(a)");
  const projects = sequence.indexOf("this.renderProjectTaskLists(a)");
  assert.ok(today !== -1 && wins !== -1 && planning !== -1 && projects !== -1);
  assert.ok(today < planning);
  assert.ok(wins < planning);
  assert.ok(planning < projects);
});

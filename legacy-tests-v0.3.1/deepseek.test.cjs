const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const bundle = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

test("DeepSeek adapter sends an OpenAI-compatible request and returns content", async () => {
  const start = bundle.indexOf("async function deepseekCall");
  const end = bundle.indexOf("async function fn", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  let captured;
  const $e = {
    requestUrl: async (request) => {
      captured = request;
      return { json: { choices: [{ message: { content: "brief-json" } }] } };
    },
  };
  const factory = Function("$e", `${bundle.slice(start, end)}; return deepseekCall;`);
  const callDeepSeek = factory($e);

  const result = await callDeepSeek("system prompt", "user prompt", "secret-key", "deepseek-v4-flash");
  assert.equal(result, "brief-json");
  assert.equal(captured.url, "https://api.deepseek.com/chat/completions");
  assert.equal(captured.method, "POST");
  assert.equal(captured.headers.Authorization, "Bearer secret-key");
  assert.equal(captured.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(captured.body), {
    model: "deepseek-v4-flash",
    messages: [
      { role: "system", content: "system prompt" },
      { role: "user", content: "user prompt" },
    ],
    temperature: 0.7,
    max_tokens: 2048,
  });
});

test("DeepSeek is wired through settings, key checks, and provider dispatch", () => {
  for (const expected of [
    'case"deepseek":return deepseekCall(i,t,e.deepseekApiKey,e.intelligenceModel)',
    'case"deepseek":return!!i.deepseekApiKey',
    's==="deepseek"?!!e.deepseekApiKey',
    'deepseek:"deepseek-v4-flash"',
    'deepseekApiKey:""',
    'deepseek:"DeepSeek"',
    'setName("DeepSeek API Key")',
  ]) {
    assert.ok(bundle.includes(expected), `missing bundle contract: ${expected}`);
  }
});

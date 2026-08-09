import test from "node:test";
import assert from "node:assert/strict";
import { LlmClient, parseJsonContent } from "../src/llm.mjs";

test("parses plain and fenced JSON", () => {
  assert.deepEqual(parseJsonContent('{"intent":"help"}'), { intent: "help" });
  assert.deepEqual(parseJsonContent('```json\n{"intent":"status"}\n```'), { intent: "status" });
});

test("uses an OpenAI-compatible endpoint without requiring a local API key", async () => {
  let request;
  const fakeFetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"intent":"help","reply":"ok"}' } }] }), { status: 200 });
  };
  const client = new LlmClient({ provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "local", apiKey: "", jsonMode: true }, fakeFetch);
  const result = await client.plan({ message: "help", catalog: [], summary: {} });
  assert.equal(result.reply, "ok");
  assert.equal(request.url, "http://localhost:11434/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, undefined);
});

test("maps Anthropic Messages responses to the common planner contract", async () => {
  const fakeFetch = async (url, options) => {
    assert.equal(url, "https://api.anthropic.test/v1/messages");
    assert.equal(options.headers["x-api-key"], "secret");
    return new Response(JSON.stringify({ content: [{ type: "text", text: '{"intent":"help","reply":"anthropic"}' }] }), { status: 200 });
  };
  const client = new LlmClient({ provider: "anthropic", baseUrl: "https://api.anthropic.test", model: "claude", apiKey: "secret", anthropicVersion: "2023-06-01" }, fakeFetch);
  const result = await client.plan({ message: "help", catalog: [], summary: {} });
  assert.equal(result.reply, "anthropic");
});

test("maps Gemini generateContent responses to the common planner contract", async () => {
  const fakeFetch = async (url, options) => {
    assert.equal(url, "https://generativelanguage.test/v1beta/models/gemini:generateContent");
    assert.equal(options.headers["x-goog-api-key"], "secret");
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"intent":"help","reply":"gemini"}' }] } }] }), { status: 200 });
  };
  const client = new LlmClient({ provider: "gemini", baseUrl: "https://generativelanguage.test", model: "gemini", apiKey: "secret" }, fakeFetch);
  const result = await client.plan({ message: "help", catalog: [], summary: {} });
  assert.equal(result.reply, "gemini");
});

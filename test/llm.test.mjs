import test from "node:test";
import assert from "node:assert/strict";
import { LlmClient, parseJsonContent, studioPromptContract } from "../src/llm.mjs";

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
  const result = await client.plan({
    message: "help",
    catalog: [],
    summary: {},
    skills: [{ id: "quality", name: "Quality", instructions: "Prefer stable settings." }],
    tools: [{ plugin_id: "cloud", tool: "status", configured: true }],
  });
  assert.equal(result.reply, "ok");
  assert.equal(request.url, "http://localhost:11434/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, undefined);
  const body = JSON.parse(request.options.body);
  assert.match(body.messages[0].content, /Prefer stable settings/);
  assert.match(body.messages[0].content, /cloud/);
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

test("summarizes long-form studio input into structured source reports", async () => {
  let requestBody;
  const fakeFetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"segment":1,"summary":"港口相遇","characters_or_entities":[],"events_or_claims":[],"locations_or_context":[],"conflicts_or_selling_points":[],"clues_or_constraints":[],"uncertainties":[]}' } }] }), { status: 200 });
  };
  const client = new LlmClient({ provider: "openai-compatible", baseUrl: "http://local/v1", model: "test", apiKey: "", jsonMode: true }, fakeFetch);
  const result = await client.summarizeStudioChunk({ chunk: "主角来到港口。", index: 0, total: 2, projectType: "drama" });
  assert.equal(result.summary, "港口相遇");
  assert.match(requestBody.messages[0].content, /第 1\/2 段/);
  assert.match(requestBody.messages[1].content, /主角来到港口/);
});

test("produces media execution specifications without claiming execution", async () => {
  let requestBody;
  const fakeFetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"summary":"关键帧任务","data":{"shots":[]},"decisions":[],"continuity":[],"risks":[],"execution":{"executor":"comfyui","ready":false,"missing":["节点缺失"],"jobs":[]}}' } }] }), { status: 200 });
  };
  const client = new LlmClient({ provider: "openai-compatible", baseUrl: "http://local/v1", model: "test", apiKey: "", jsonMode: true }, fakeFetch);
  const result = await client.produceStudioArtifact({
    project: { id: "project", type: "drama", title: "雾港", settings: {}, source: { filename: "novel.txt", text: "原文" } },
    stage: { id: "image_generation", name: "图像生成", executor: "comfyui", instruction: "生成关键帧任务" },
    capabilities: { ready: false, missing: ["后端未连接"] },
  });
  assert.equal(result.execution.ready, false);
  assert.match(requestBody.messages[0].content, /不得声称已经生成媒体/);
  assert.match(requestBody.messages[0].content, /后端未连接/);
});

test("requires structured video and voice prompt contracts", () => {
  const video = studioPromptContract({ id: "video_generation" });
  assert.match(video, /video_prompt/);
  assert.match(video, /source_image_ref/);
  assert.match(video, /compiled/);
  const voice = studioPromptContract({ id: "voice_synthesis" });
  assert.match(voice, /voice_prompt/);
  assert.match(voice, /scene_context/);
  assert.match(voice, /emotional_cause/);
  assert.match(voice, /synthesis_text/);
  assert.match(voice, /performance_beats/);
  assert.match(voice, /emphasis/);
  assert.match(voice, /tail_tone/);
  assert.match(voice, /compiled_instruction/);
  assert.match(voice, /engine_instruction/);
  assert.match(voice, /真人声音/);
});

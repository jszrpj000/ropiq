import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, parseEnv, publicConfig, saveSettings } from "../src/config.mjs";

test("parses quoted env values without exposing them", () => {
  assert.deepEqual(parseEnv("A=one\nB=\"two words\"\n# comment\n"), { A: "one", B: "two words" });
});

test("loads a provider-neutral model configuration", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ropiq-"));
  fs.writeFileSync(path.join(root, ".env.local"), "LLM_PROVIDER=anthropic\nLLM_BASE_URL=https://api.example\nLLM_MODEL=model-x\nBACKEND_TYPE=comfyui\nBACKEND_BASE_URL=http://127.0.0.1:8188\nROPIQ_PORT=9001\n");
  const config = loadConfig(root, { PATH: process.env.PATH || "" });
  assert.equal(config.llm.provider, "anthropic");
  assert.equal(config.llm.model, "model-x");
  assert.equal(config.backend.type, "comfyui");
  assert.equal(config.backend.baseUrl, "http://127.0.0.1:8188");
  assert.equal(config.port, 9001);
});

test("persists guided settings without returning stored secrets", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ropiq-project-"));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ropiq-data-"));
  saveSettings(dataRoot, {
    llm: { provider: "openai-compatible", baseUrl: "https://api.deepseek.com/v1", apiKey: "secret", model: "deepseek-chat" },
    backend: { baseUrl: "http://127.0.0.1:8188" },
    extensions: { catalogUrl: "https://raw.githubusercontent.com/example/catalog/main/ropiq-catalog.json" },
    plugins: { cloudLifecycle: { statusUrl: "https://cloud.example/status", stopUrl: "https://cloud.example/stop", token: "cloud-secret" } },
  });
  const config = loadConfig(projectRoot, { ROPIQ_DATA_DIR: dataRoot });
  assert.equal(config.llm.model, "deepseek-chat");
  assert.equal(config.llm.apiKey, "secret");
  const safe = publicConfig(config);
  assert.equal(safe.llm.hasApiKey, true);
  assert.equal("apiKey" in safe.llm, false);
  assert.equal("token" in safe.plugins.cloudLifecycle, false);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, parseEnv } from "../src/config.mjs";

test("parses quoted env values without exposing them", () => {
  assert.deepEqual(parseEnv("A=one\nB=\"two words\"\n# comment\n"), { A: "one", B: "two words" });
});

test("loads a provider-neutral model configuration", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "comfy-agent-"));
  fs.writeFileSync(path.join(root, ".env.local"), "LLM_PROVIDER=anthropic\nLLM_BASE_URL=https://api.example\nLLM_MODEL=model-x\nCOMFY_AGENT_PORT=9001\n");
  const config = loadConfig(root, { PATH: process.env.PATH || "" });
  assert.equal(config.llm.provider, "anthropic");
  assert.equal(config.llm.model, "model-x");
  assert.equal(config.port, 9001);
});

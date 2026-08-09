import fs from "node:fs";
import path from "node:path";

export function parseEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export function loadConfig(projectRoot, overrides = {}) {
  const envPath = path.join(projectRoot, ".env.local");
  const fileEnv = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, "utf8")) : {};
  const env = { ...fileEnv, ...process.env, ...overrides };
  const port = Number.parseInt(env.COMFY_AGENT_PORT || "8787", 10);

  return {
    projectRoot,
    port: Number.isInteger(port) && port > 0 ? port : 8787,
    comfyui: {
      baseUrl: (env.COMFYUI_BASE_URL || "").replace(/\/$/, ""),
      token: env.COMFYUI_API_TOKEN || "",
      home: env.COMFYUI_HOME || "",
      python: env.COMFYUI_PYTHON || "",
      port: Number.parseInt(env.COMFYUI_PORT || "8188", 10),
    },
    llm: {
      provider: env.LLM_PROVIDER || "openai-compatible",
      apiKey: env.LLM_API_KEY || "",
      baseUrl: (env.LLM_BASE_URL || "").replace(/\/$/, ""),
      model: env.LLM_MODEL || "",
      jsonMode: !/^(0|false|no)$/i.test(env.LLM_JSON_MODE || "true"),
      anthropicVersion: env.LLM_ANTHROPIC_VERSION || "2023-06-01",
    },
  };
}

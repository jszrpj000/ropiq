import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function parseEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

export function dataRootFor(env = process.env) {
  if (env.ROPIQ_DATA_DIR) return path.resolve(env.ROPIQ_DATA_DIR);
  if (process.platform === "win32") return path.join(env.LOCALAPPDATA || os.homedir(), "Ropiq");
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "ropiq");
}

export function readSettings(dataRoot) {
  const file = path.join(dataRoot, "settings.json");
  if (!fs.existsSync(file)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    throw new Error(`配置文件不是有效 JSON：${file}`);
  }
}

function cleanUrl(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

function settingEnv(settings) {
  return {
    ROPIQ_PORT: settings.port,
    LLM_PROVIDER: settings.llm?.provider,
    LLM_BASE_URL: settings.llm?.baseUrl,
    LLM_API_KEY: settings.llm?.apiKey,
    LLM_MODEL: settings.llm?.model,
    LLM_JSON_MODE: settings.llm?.jsonMode,
    LLM_ANTHROPIC_VERSION: settings.llm?.anthropicVersion,
    BACKEND_TYPE: settings.backend?.type,
    BACKEND_BASE_URL: settings.backend?.baseUrl,
    BACKEND_API_TOKEN: settings.backend?.token,
  };
}

export function loadConfig(projectRoot, overrides = {}) {
  const dataRoot = dataRootFor({ ...process.env, ...overrides });
  const envPath = path.join(projectRoot, ".env.local");
  const fileEnv = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, "utf8")) : {};
  const settings = readSettings(dataRoot);
  const storedEnv = Object.fromEntries(Object.entries(settingEnv(settings)).filter(([, value]) => value !== undefined && value !== null));
  const env = { ...fileEnv, ...storedEnv, ...process.env, ...overrides };
  const port = Number.parseInt(env.ROPIQ_PORT || env.COMFY_AGENT_PORT || "8787", 10);

  return {
    projectRoot,
    dataRoot,
    port: Number.isInteger(port) && port > 0 ? port : 8787,
    backend: {
      type: env.BACKEND_TYPE || "comfyui",
      baseUrl: cleanUrl(env.BACKEND_BASE_URL || env.COMFYUI_BASE_URL),
      token: env.BACKEND_API_TOKEN || env.COMFYUI_API_TOKEN || "",
    },
    llm: {
      provider: env.LLM_PROVIDER || "openai-compatible",
      apiKey: env.LLM_API_KEY || "",
      baseUrl: cleanUrl(env.LLM_BASE_URL),
      model: String(env.LLM_MODEL || "").trim(),
      jsonMode: !/^(0|false|no)$/i.test(String(env.LLM_JSON_MODE ?? "true")),
      anthropicVersion: env.LLM_ANTHROPIC_VERSION || "2023-06-01",
    },
    extensions: settings.extensions || {},
    plugins: settings.plugins || {},
  };
}

function validateHttpUrl(value, label, optional = true) {
  const text = String(value || "").trim();
  if (!text && optional) return "";
  let parsed;
  try { parsed = new URL(text); } catch { throw new Error(`${label}不是有效网址`); }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) throw new Error(`${label}必须是无内嵌账号的 HTTP(S) 地址`);
  return text.replace(/\/$/, "");
}

export function saveSettings(dataRoot, input) {
  const previous = readSettings(dataRoot);
  const provider = String(input.llm?.provider || previous.llm?.provider || "openai-compatible");
  if (!new Set(["openai-compatible", "anthropic", "gemini"]).has(provider)) throw new Error("不支持的大模型接口类型");
  const apiKeyInput = String(input.llm?.apiKey || "").trim();
  const pluginKeyInput = String(input.plugins?.cloudLifecycle?.token || "").trim();
  const next = {
    version: 1,
    port: previous.port || 8787,
    llm: {
      provider,
      baseUrl: validateHttpUrl(input.llm?.baseUrl, "大模型 API 地址", false),
      apiKey: apiKeyInput || previous.llm?.apiKey || "",
      model: String(input.llm?.model || "").trim(),
      jsonMode: true,
      anthropicVersion: "2023-06-01",
    },
    backend: {
      type: "comfyui",
      baseUrl: validateHttpUrl(input.backend?.baseUrl, "生成后端地址"),
      token: String(input.backend?.token || "").trim() || previous.backend?.token || "",
    },
    extensions: {
      catalogUrl: validateHttpUrl(input.extensions?.catalogUrl || previous.extensions?.catalogUrl || "https://raw.githubusercontent.com/jszrpj000/ropiq/main/ropiq-catalog.json", "扩展目录地址", false),
      autoInstallSkills: input.extensions?.autoInstallSkills !== false,
    },
    plugins: {
      cloudLifecycle: {
        statusUrl: validateHttpUrl(input.plugins?.cloudLifecycle?.statusUrl, "云实例状态地址"),
        stopUrl: validateHttpUrl(input.plugins?.cloudLifecycle?.stopUrl, "云实例停止地址"),
        token: pluginKeyInput || previous.plugins?.cloudLifecycle?.token || "",
      },
    },
  };
  if (!next.llm.model) throw new Error("请填写大模型名称");
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "settings.json"), `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return next;
}

export function publicConfig(config) {
  return {
    dataRoot: config.dataRoot,
    llm: { provider: config.llm.provider, baseUrl: config.llm.baseUrl, model: config.llm.model, hasApiKey: Boolean(config.llm.apiKey) },
    backend: { type: config.backend.type, baseUrl: config.backend.baseUrl, hasToken: Boolean(config.backend.token) },
    extensions: {
      catalogUrl: config.extensions.catalogUrl || "https://raw.githubusercontent.com/jszrpj000/ropiq/main/ropiq-catalog.json",
      autoInstallSkills: config.extensions.autoInstallSkills !== false,
    },
    plugins: {
      cloudLifecycle: {
        statusUrl: config.plugins.cloudLifecycle?.statusUrl || "",
        stopUrl: config.plugins.cloudLifecycle?.stopUrl || "",
        hasToken: Boolean(config.plugins.cloudLifecycle?.token),
      },
    },
  };
}

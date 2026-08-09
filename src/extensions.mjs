import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { basicScan, scanDirectory, writeScanReport } from "./security.mjs";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const GITHUB_RAW_PREFIX = "https://raw.githubusercontent.com/";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function validateManifest(manifest, kind) {
  if (!manifest || !ID_PATTERN.test(String(manifest.id || ""))) throw new Error(`${kind} 清单缺少有效 id`);
  if (!manifest.name || !manifest.version) throw new Error(`${kind} 清单缺少 name 或 version`);
  return manifest;
}

function discover(root, kind) {
  if (!fs.existsSync(root)) return [];
  const manifestName = kind === "skill" ? "skill.json" : "plugin.json";
  return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
    const directory = path.join(root, entry.name);
    const manifestFile = path.join(directory, manifestName);
    if (!fs.existsSync(manifestFile)) return [];
    try {
      const manifest = validateManifest(readJson(manifestFile), kind);
      if (kind === "skill") {
        const instructionsFile = path.join(directory, "SKILL.md");
        if (!fs.existsSync(instructionsFile)) return [];
        return [{ ...manifest, kind, directory, instructions: fs.readFileSync(instructionsFile, "utf8").slice(0, 24000) }];
      }
      return [{ ...manifest, kind, directory }];
    } catch {
      return [];
    }
  });
}

function scoreKeywords(message, extension) {
  const text = message.toLowerCase();
  return (extension.keywords || []).reduce((score, keyword) => score + (text.includes(String(keyword).toLowerCase()) ? 1 : 0), 0);
}

export class ExtensionRegistry {
  constructor({ projectRoot, dataRoot, pluginConfig = {}, fetchImpl = fetch }) {
    this.projectRoot = projectRoot;
    this.dataRoot = dataRoot;
    this.pluginConfig = pluginConfig;
    this.fetch = fetchImpl;
    this.refresh();
  }

  refresh() {
    this.skills = [
      ...discover(path.join(this.projectRoot, "skills"), "skill"),
      ...discover(path.join(this.dataRoot, "extensions", "skills"), "skill"),
    ];
    this.plugins = [
      ...discover(path.join(this.projectRoot, "plugins"), "plugin"),
      ...discover(path.join(this.dataRoot, "extensions", "plugins"), "plugin"),
    ];
  }

  summary() {
    return {
      skills: this.skills.map(({ id, name, version, description }) => ({ id, name, version, description })),
      plugins: this.plugins.map((plugin) => ({ id: plugin.id, name: plugin.name, version: plugin.version, description: plugin.description, configured: this.isPluginConfigured(plugin) })),
    };
  }

  selectSkills(message, limit = 3) {
    return this.skills.map((skill) => ({ skill, score: scoreKeywords(message, skill) }))
      .filter((item) => item.score > 0 || item.skill.always === true)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .slice(0, limit).map((item) => item.skill);
  }

  tools() {
    return this.plugins.flatMap((plugin) => (plugin.tools || []).map((tool) => ({
      plugin_id: plugin.id,
      plugin_name: plugin.name,
      tool: tool.name,
      description: tool.description,
      side_effect: Boolean(tool.sideEffect),
      configured: this.isPluginConfigured(plugin),
    })));
  }

  isPluginConfigured(plugin) {
    const config = this.pluginConfig[plugin.configKey || plugin.id] || {};
    return (plugin.tools || []).some((tool) => Boolean(config[tool.urlSetting]));
  }

  resolveTool(pluginId, toolName) {
    const plugin = this.plugins.find((item) => item.id === pluginId);
    const tool = plugin?.tools?.find((item) => item.name === toolName);
    if (!plugin || !tool) throw new Error("插件工具不存在");
    const config = this.pluginConfig[plugin.configKey || plugin.id] || {};
    const endpoint = config[tool.urlSetting];
    if (!endpoint) throw new Error(`插件 ${plugin.name} 尚未配置 ${tool.urlSetting}`);
    return { plugin, tool, config, endpoint };
  }

  async execute(pluginId, toolName) {
    const { plugin, tool, config, endpoint } = this.resolveTool(pluginId, toolName);
    const headers = { Accept: "application/json" };
    if (config.token) headers.Authorization = `Bearer ${config.token}`;
    if (tool.method !== "GET") headers["Content-Type"] = "application/json";
    const response = await this.fetch(endpoint, {
      method: tool.method || "GET",
      headers,
      body: tool.method === "GET" ? undefined : "{}",
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${plugin.name} 调用失败 (${response.status})`);
    let data = text;
    try { data = text ? JSON.parse(text) : {}; } catch { /* plain text is valid */ }
    return { plugin: plugin.name, tool: tool.name, data };
  }

  async fetchCatalog(catalogUrl) {
    if (!String(catalogUrl).startsWith(GITHUB_RAW_PREFIX)) throw new Error("扩展目录只允许 GitHub raw.githubusercontent.com 地址");
    const response = await this.fetch(catalogUrl, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`GitHub 扩展目录下载失败 (${response.status})`);
    const catalog = await response.json();
    if (!Array.isArray(catalog.extensions)) throw new Error("GitHub 扩展目录格式无效");
    return catalog.extensions.filter((item) => ["skill", "plugin"].includes(item.kind) && ID_PATTERN.test(String(item.id || "")));
  }

  async install(entry) {
    if (!["skill", "plugin"].includes(entry.kind) || !ID_PATTERN.test(String(entry.id || ""))) throw new Error("扩展条目无效");
    if (!Array.isArray(entry.files) || entry.files.length === 0 || entry.files.length > 8) throw new Error("扩展文件清单无效");
    const allowedNames = entry.kind === "skill" ? new Set(["skill.json", "SKILL.md"]) : new Set(["plugin.json"]);
    const downloaded = [];
    let total = 0;
    for (const file of entry.files) {
      const name = path.basename(String(file.name || ""));
      if (!allowedNames.has(name) || !String(file.url || "").startsWith(GITHUB_RAW_PREFIX) || !/^[a-f0-9]{64}$/.test(String(file.sha256 || ""))) throw new Error("扩展文件来源或校验信息无效");
      const response = await this.fetch(file.url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`扩展文件下载失败 (${response.status})`);
      const content = Buffer.from(await response.arrayBuffer());
      total += content.length;
      if (total > 256 * 1024) throw new Error("扩展包超过 256 KB 安全上限");
      const actual = createHash("sha256").update(content).digest("hex");
      if (actual !== file.sha256) throw new Error(`扩展文件校验失败：${name}`);
      downloaded.push({ name, content });
    }
    const basicReport = basicScan(downloaded);
    if (!basicReport.safe) {
      writeScanReport(this.dataRoot, entry.id, { basic: basicReport, accepted: false });
      throw new Error(`扩展未通过基础安全扫描：${basicReport.severity} ${basicReport.score}/100`);
    }
    const manifestName = entry.kind === "skill" ? "skill.json" : "plugin.json";
    const manifestFile = downloaded.find((file) => file.name === manifestName);
    if (!manifestFile) throw new Error("扩展缺少清单文件");
    const manifest = validateManifest(JSON.parse(manifestFile.content.toString("utf8")), entry.kind);
    if (manifest.id !== entry.id || manifest.version !== entry.version) throw new Error("扩展清单与目录条目不一致");
    const base = path.join(this.dataRoot, "extensions", `${entry.kind}s`);
    const staging = path.join(base, `.${entry.id}-${Date.now()}`);
    const root = path.join(base, entry.id);
    fs.mkdirSync(staging, { recursive: true });
    for (const file of downloaded) fs.writeFileSync(path.join(staging, file.name), file.content, { mode: 0o600 });
    const nvidiaReport = entry.kind === "skill" ? await scanDirectory(staging) : { available: false };
    const accepted = !nvidiaReport.available || nvidiaReport.safe;
    writeScanReport(this.dataRoot, entry.id, { basic: basicReport, nvidia: nvidiaReport, accepted });
    if (!accepted) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new Error(`扩展未通过 NVIDIA SkillSpector：${nvidiaReport.severity} ${nvidiaReport.score}/100`);
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.renameSync(staging, root);
    this.refresh();
    return { id: entry.id, kind: entry.kind, version: entry.version, scan: nvidiaReport.available ? "nvidia-skillspector" : "ropiq-basic" };
  }
}

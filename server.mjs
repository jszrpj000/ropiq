import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig, publicConfig, saveSettings } from "./src/config.mjs";
import { ComfyUiClient, summarizeSnapshot } from "./src/comfyui.mjs";
import { ExtensionRegistry } from "./src/extensions.mjs";
import { LlmClient } from "./src/llm.mjs";
import { skillSpectorStatus } from "./src/security.mjs";
import { StudioStore, STUDIO_PIPELINES, splitLongText } from "./src/studio.mjs";
import { buildNodeCatalog, rankCandidates, validateWorkflow } from "./src/workflow.mjs";

const agentRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = agentRoot;
const publicRoot = path.join(agentRoot, "public");
let config;
let backend;
let llm;
let extensions;
let studio;
const plans = new Map();
const sessions = new Map();
let snapshotCache = null;
let catalogCache = null;

function applyConfig() {
  config = loadConfig(projectRoot);
  if (config.backend.type !== "comfyui") throw new Error(`暂不支持的 BACKEND_TYPE: ${config.backend.type}`);
  backend = new ComfyUiClient(config.backend);
  llm = new LlmClient(config.llm);
  extensions = new ExtensionRegistry({ projectRoot, dataRoot: config.dataRoot, pluginConfig: config.plugins });
  studio = new StudioStore(config.dataRoot);
  fs.mkdirSync(path.join(config.dataRoot, "assets", "approved"), { recursive: true });
  fs.mkdirSync(path.join(config.dataRoot, "runs"), { recursive: true });
  snapshotCache = null;
  catalogCache = null;
}

applyConfig();

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

function sendError(response, status, error) {
  sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
}

async function readJson(request, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function contentType(filePath) {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" })[path.extname(filePath)] || "application/octet-stream";
}

function serveStatic(requestPath, response) {
  const relative = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const resolved = path.resolve(publicRoot, relative);
  if (!resolved.startsWith(`${path.resolve(publicRoot)}${path.sep}`) && resolved !== path.join(path.resolve(publicRoot), "index.html")) return false;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return false;
  response.writeHead(200, { "Content-Type": contentType(resolved), "Cache-Control": "no-cache" });
  fs.createReadStream(resolved).pipe(response);
  return true;
}

async function getSnapshot(force = false, timeoutMs = 30000) {
  if (!config.backend.baseUrl) throw new Error("未配置 BACKEND_BASE_URL");
  if (!force && snapshotCache && Date.now() - snapshotCache.at < 30000) return snapshotCache.value;
  const value = await backend.snapshot(timeoutMs);
  snapshotCache = { at: Date.now(), value };
  return value;
}

function getSession(id) {
  const key = id || randomUUID();
  if (!sessions.has(key)) sessions.set(key, []);
  return { id: key, history: sessions.get(key) };
}

function remember(session, role, content) {
  session.history.push({ role, content: String(content).slice(0, 4000) });
  if (session.history.length > 12) session.history.splice(0, session.history.length - 12);
}

function listApprovedAssets() {
  const root = path.resolve(config.dataRoot, "assets", "approved");
  const allowed = new Set([".png", ".jpg", ".jpeg", ".webp"]);
  const results = [];
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile() && allowed.has(path.extname(entry.name).toLowerCase())) results.push(path.relative(root, fullPath).replaceAll("\\", "/"));
    }
  }
  walk(root);
  return results.sort();
}

function approvedAssetPath(relativePath) {
  const root = path.resolve(config.dataRoot, "assets", "approved");
  const resolved = path.resolve(root, String(relativePath || ""));
  if (!resolved.startsWith(`${root}${path.sep}`) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error("素材不在 assets/approved/ 中");
  }
  return resolved;
}

function writeRunRecord(plan, status, extra = {}) {
  const date = new Date().toISOString().slice(0, 10);
  const directory = path.join(config.dataRoot, "runs", date);
  fs.mkdirSync(directory, { recursive: true });
  const workflowPath = plan.workflow ? path.join(directory, `${plan.id}.workflow.json`) : "";
  if (workflowPath) fs.writeFileSync(workflowPath, `${JSON.stringify(plan.workflow, null, 2)}\n`, "utf8");
  const record = {
    task_id: plan.id,
    status,
    recorded_at: new Date().toISOString(),
    user_request: plan.message,
    agent_driver: `${config.llm.provider}:${config.llm.model}`,
    workflow_path: workflowPath ? path.relative(config.dataRoot, workflowPath).replaceAll("\\", "/") : "",
    validation: plan.validation || null,
    action: plan.actionName || "workflow",
    ...extra,
  };
  fs.writeFileSync(path.join(directory, `${plan.id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function safeInfoIntent(message) {
  const text = message.trim();
  if (/^(检查|查看|显示)?(系统|连接|环境|显存)(状态|信息)?[？?。]?$/.test(text)) return "status";
  if (/^(检查|查看|显示)?队列(状态|信息)?[？?。]?$/.test(text)) return "queue";
  const historyMatch = text.match(/^(?:检查|查看|查询)?任务\s+([a-zA-Z0-9-]+)(?:\s*状态)?[？?。]?$/);
  return historyMatch ? { history: historyMatch[1] } : null;
}

async function getExtensionCatalog(force = false) {
  const catalogUrl = config.extensions.catalogUrl;
  if (!catalogUrl) return [];
  if (!force && catalogCache && Date.now() - catalogCache.at < 5 * 60 * 1000) return catalogCache.value;
  try {
    const value = await extensions.fetchCatalog(catalogUrl);
    catalogCache = { at: Date.now(), value };
    return value;
  } catch {
    return [];
  }
}

async function preparePluginAction(message, pluginId, toolName, sessionId = "") {
  const resolved = extensions.resolveTool(pluginId, toolName);
  if (!resolved.tool.sideEffect) {
    return { sessionId, kind: "info", reply: `${resolved.plugin.name} 已返回结果。`, data: await extensions.execute(pluginId, toolName), usedPlugin: `${pluginId}/${toolName}` };
  }
  const id = randomUUID();
  const plan = { id, message, actionName: "plugin", action: { pluginId, toolName } };
  plans.set(id, plan);
  writeRunRecord(plan, "awaiting_approval", { plugin_id: pluginId, tool: toolName });
  return { sessionId, kind: "approval", planId: id, action: `${resolved.plugin.name} / ${resolved.tool.description}`, reply: "该操作会改变云实例状态，确认后才会执行。" };
}

async function handleChat(body) {
  const message = String(body.message || "").trim();
  if (!message) throw new Error("请输入需求");
  const session = getSession(body.sessionId);
  const safeIntent = safeInfoIntent(message);
  if (safeIntent) {
    if (safeIntent === "queue") return { sessionId: session.id, kind: "info", reply: "这是当前生成后端的队列状态。", data: await backend.queue() };
    if (typeof safeIntent === "object") return { sessionId: session.id, kind: "info", reply: `这是任务 ${safeIntent.history} 的历史状态。`, data: await backend.history(safeIntent.history) };
    if (!config.backend.baseUrl) return { sessionId: session.id, kind: "info", reply: "生成后端尚未配置。请在“连接与配置”中填写后端地址。", data: { connected: false, backendType: config.backend.type } };
    const snapshot = await getSnapshot(true);
    return { sessionId: session.id, kind: "info", reply: "生成后端已连接，以下信息来自当前实例。", data: summarizeSnapshot(snapshot) };
  }

  if (!llm.configured) throw new Error("未配置 LLM_BASE_URL 和 LLM_MODEL，无法进行智能工作流规划");
  const snapshot = config.backend.baseUrl ? await getSnapshot() : { objectInfo: {}, systemStats: {}, templates: [] };
  const summary = config.backend.baseUrl ? summarizeSnapshot(snapshot) : { backend_connected: false, node_count: 0, model_count: 0 };
  summary.approved_assets = listApprovedAssets();
  const catalog = buildNodeCatalog(snapshot.objectInfo, message);
  const selectedSkills = extensions.selectSkills(message);
  const installedIds = new Set([...extensions.skills, ...extensions.plugins].map((item) => item.id));
  const availableExtensions = (await getExtensionCatalog()).filter((item) => !installedIds.has(item.id));
  const result = await llm.plan({
    message,
    history: session.history,
    catalog,
    summary,
    skills: selectedSkills,
    tools: extensions.tools().filter((tool) => tool.configured),
    availableExtensions: availableExtensions.map(({ id, kind, name, version, description, keywords }) => ({ id, kind, name, version, description, keywords })),
  });
  remember(session, "user", message);
  remember(session, "assistant", result.reply || result.intent || "已生成计划");

  if (result.intent === "plugin") {
    return preparePluginAction(message, String(result.action?.plugin_id || ""), String(result.action?.tool || ""), session.id);
  }

  if (result.intent === "extension_install") {
    const entry = availableExtensions.find((item) => item.id === result.action?.extension_id);
    if (!entry) throw new Error("智能体选择的扩展不在已验证 GitHub 目录中");
    if (entry.kind === "skill" && config.extensions.autoInstallSkills !== false) {
      const installed = await extensions.install(entry);
      return { sessionId: session.id, kind: "info", reply: result.reply || `已从 GitHub 安装并启用 Skill：${entry.name}。`, data: installed };
    }
    const id = randomUUID();
    const plan = { id, message, actionName: "extension_install", action: { entry } };
    plans.set(id, plan);
    writeRunRecord(plan, "awaiting_approval", { extension_id: entry.id, extension_version: entry.version });
    return { sessionId: session.id, kind: "approval", planId: id, action: `从 GitHub 安装 ${entry.kind}：${entry.name} ${entry.version}`, reply: result.reply || "已找到匹配扩展；确认后将下载、校验并进行安全扫描。" };
  }

  if (result.intent !== "workflow") {
    const supported = new Set(["interrupt", "clear_queue", "free_memory", "upload_asset", "download_output", "status", "help"]);
    if (!supported.has(result.intent)) throw new Error("智能体返回了不支持的操作");
    if (result.intent === "status" || result.intent === "help") {
      return { sessionId: session.id, kind: "info", reply: result.reply || "当前环境信息如下。", data: summary };
    }
    if (result.intent === "download_output") {
      const filename = String(result.action?.filename || "");
      if (!filename || filename.includes("..")) throw new Error("下载文件名无效");
      const params = new URLSearchParams({ filename, subfolder: result.action?.subfolder || "", type: result.action?.type || "output" });
      return { sessionId: session.id, kind: "download", reply: result.reply || "输出已准备下载。", downloadUrl: `/api/output?${params}` };
    }
    const id = randomUUID();
    const plan = { id, message, actionName: result.intent, action: result.action || {} };
    plans.set(id, plan);
    writeRunRecord(plan, "awaiting_approval");
    return { sessionId: session.id, kind: "approval", planId: id, action: result.intent, reply: result.reply || "该操作需要人工确认。" };
  }

  const ranked = rankCandidates(result.candidates, snapshot.objectInfo, snapshot.systemStats);
  if (ranked.length === 0) throw new Error("大模型没有返回工作流候选");
  const recommended = ranked[0];
  if (!recommended.validation.valid) {
    const details = ranked.flatMap((item) => item.validation.errors).slice(0, 8).join("；");
    throw new Error(`候选工作流均未通过本地校验：${details}`);
  }
  const id = randomUUID();
  const plan = { id, message, workflow: recommended.workflow, validation: recommended.validation, title: recommended.title || "推荐工作流", skills: selectedSkills.map((skill) => skill.id) };
  plans.set(id, plan);
  writeRunRecord(plan, "planned");
  return {
    sessionId: session.id,
    kind: "workflow",
    planId: id,
    reply: result.reply || "已生成并校验推荐工作流。",
    assumptions: result.assumptions || [],
    usedSkills: plan.skills,
    recommended: { title: plan.title, rationale: recommended.rationale || "", workflow: recommended.workflow, validation: recommended.validation },
    alternatives: ranked.slice(1).map((item) => ({ title: item.title || "备选方案", rationale: item.rationale || "", validation: item.validation })),
  };
}

async function confirmPlan(body) {
  if (body.approved !== true) throw new Error("必须明确确认后才能执行");
  const plan = plans.get(String(body.planId || ""));
  if (!plan) throw new Error("计划不存在或服务已重启，请重新生成");

  let result;
  if (plan.workflow) {
    const snapshot = await getSnapshot(true);
    const validation = validateWorkflow(plan.workflow, snapshot.objectInfo, snapshot.systemStats);
    if (!validation.valid) throw new Error(`执行前校验失败：${validation.errors.join("；")}`);
    result = await backend.submit(plan.workflow, randomUUID());
    writeRunRecord(plan, "submitted", { prompt_id: result.prompt_id || "" });
  } else if (plan.actionName === "interrupt") {
    result = await backend.interrupt();
    writeRunRecord(plan, "executed");
  } else if (plan.actionName === "clear_queue") {
    result = await backend.clearQueue();
    writeRunRecord(plan, "executed");
  } else if (plan.actionName === "free_memory") {
    result = await backend.freeMemory();
    writeRunRecord(plan, "executed");
  } else if (plan.actionName === "upload_asset") {
    const filePath = approvedAssetPath(plan.action.relative_path);
    result = await backend.uploadImage(path.basename(filePath), fs.readFileSync(filePath));
    writeRunRecord(plan, "uploaded", { source_assets: [plan.action.relative_path] });
  } else if (plan.actionName === "plugin") {
    result = await extensions.execute(plan.action.pluginId, plan.action.toolName);
    writeRunRecord(plan, "executed", { plugin_id: plan.action.pluginId, tool: plan.action.toolName });
  } else if (plan.actionName === "extension_install") {
    result = await extensions.install(plan.action.entry);
    writeRunRecord(plan, "installed", { extension_id: result.id, extension_version: result.version, security_scan: result.scan });
  } else {
    throw new Error("该操作不支持确认执行");
  }
  plans.delete(plan.id);
  return { ok: true, result };
}

const executorKeywords = {
  "plugin:tts": ["tts", "voice", "speech", "配音"],
  "plugin:lipsync": ["lipsync", "lip_sync", "lip-sync", "口型"],
  "plugin:audio": ["audio", "music", "caption", "subtitle", "音频", "字幕"],
  "plugin:editor": ["editor", "editing", "render", "timeline", "剪辑"],
};

function matchingExecutorTools(executor) {
  const keywords = executorKeywords[executor] || [];
  return extensions.tools().filter((tool) => {
    if (!tool.configured) return false;
    const text = `${tool.plugin_id || ""} ${tool.tool || ""} ${tool.description || ""}`.toLowerCase();
    return keywords.some((keyword) => text.includes(keyword));
  });
}

function stageCapability(stage, snapshot = null, connectionError = "") {
  if (stage.executor === "llm") {
    return { executor: "llm", ready: llm.configured, missing: llm.configured ? [] : ["未配置大模型接口"] };
  }
  if (stage.executor === "comfyui") {
    const ready = Boolean(config.backend.baseUrl && snapshot);
    return {
      executor: "comfyui",
      ready,
      missing: ready ? [] : [connectionError || (config.backend.baseUrl ? "生成后端当前无法连接" : "未配置本地或云端节点图后端")],
      backend: snapshot ? summarizeSnapshot(snapshot) : null,
    };
  }
  const tools = matchingExecutorTools(stage.executor);
  return {
    executor: stage.executor,
    ready: tools.length > 0,
    missing: tools.length ? [] : [`未安装或配置 ${stage.executor.slice(7)} 执行插件`],
    tools: tools.map((tool) => ({ plugin_id: tool.plugin_id, tool: tool.tool, description: tool.description })),
  };
}

async function runStudioStage(projectId, stageId) {
  const project = studio.get(projectId);
  const stage = project.stages.find((item) => item.id === stageId);
  if (!stage) throw new Error("制作阶段不存在");
  if (!llm.configured) throw new Error("请先配置大模型接口，再生成阶段产物");
  studio.markRunning(projectId, stageId);
  try {
    let snapshot = null;
    let connectionError = "";
    if (stage.executor === "comfyui" && config.backend.baseUrl) {
      try { snapshot = await getSnapshot(false, 10000); }
      catch (error) { connectionError = error.message; }
    }
    const capability = stageCapability(stage, snapshot, connectionError);
    if (snapshot) capability.nodeCatalog = buildNodeCatalog(snapshot.objectInfo, `${project.title} ${stage.name}`).slice(0, 120);

    let sourceReports = project.artifacts?.novel_analysis?.data?.source_reports
      || project.artifacts?.product_analysis?.data?.source_reports
      || [];
    if (stage.order === 1) {
      const chunks = splitLongText(project.source.text);
      sourceReports = [];
      for (let index = 0; index < chunks.length; index += 1) {
        sourceReports.push(await llm.summarizeStudioChunk({ chunk: chunks[index], index, total: chunks.length, projectType: project.type }));
      }
    }

    const artifact = await llm.produceStudioArtifact({
      project,
      stage,
      previousContext: studio.stageContext(projectId, stageId),
      sourceReports,
      capabilities: capability,
    });
    if (!artifact.data || typeof artifact.data !== "object" || Array.isArray(artifact.data)) artifact.data = {};
    if (stage.order === 1) artifact.data.source_reports = sourceReports;
    const proposedExecution = artifact.execution && typeof artifact.execution === "object" ? artifact.execution : {};
    artifact.execution = {
      ...proposedExecution,
      executor: stage.executor,
      ready: capability.ready,
      missing: capability.missing,
      jobs: Array.isArray(proposedExecution.jobs) ? proposedExecution.jobs : [],
      mode: stage.executor === "llm" ? "artifact" : "specification_only",
      requiresApproval: stage.executor !== "llm",
    };
    return studio.saveArtifact(projectId, stageId, artifact, stage.executor === "llm" ? "complete" : "specified");
  } catch (error) {
    studio.markError(projectId, stageId, error.message);
    throw error;
  }
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    let connected = false;
    let summary = null;
    let connectionError = "";
    if (config.backend.baseUrl) {
      try { summary = summarizeSnapshot(await getSnapshot(false, 5000)); connected = true; } catch (error) { connectionError = error.message; }
    }
    return sendJson(response, 200, {
      llmConfigured: llm.configured,
      backendConfigured: Boolean(config.backend.baseUrl),
      backendType: config.backend.type,
      connected,
      connectionError,
      provider: config.llm.provider,
      model: config.llm.model,
      summary,
      approvedAssets: listApprovedAssets(),
      config: publicConfig(config),
      extensions: extensions.summary(),
      tools: extensions.tools(),
      security: await skillSpectorStatus(),
      studioProjects: studio.list().slice(0, 8),
    });
  }
  if (request.method === "GET" && url.pathname === "/api/studio/pipelines") {
    const pipelines = Object.fromEntries(Object.entries(STUDIO_PIPELINES).map(([id, pipeline]) => [id, {
      id,
      name: pipeline.name,
      stages: pipeline.stages.map(([stageId, name, executor, instruction], index) => ({ id: stageId, name, executor, instruction, order: index + 1 })),
    }]));
    return sendJson(response, 200, { pipelines });
  }
  if (request.method === "GET" && url.pathname === "/api/studio/projects") {
    return sendJson(response, 200, { projects: studio.list() });
  }
  if (request.method === "POST" && url.pathname === "/api/studio/projects") {
    return sendJson(response, 201, { project: studio.create(await readJson(request, 5 * 1024 * 1024)) });
  }
  const studioProjectMatch = url.pathname.match(/^\/api\/studio\/projects\/([a-f0-9-]{36})$/);
  if (request.method === "GET" && studioProjectMatch) {
    return sendJson(response, 200, { project: studio.get(studioProjectMatch[1]) });
  }
  const studioStageMatch = url.pathname.match(/^\/api\/studio\/projects\/([a-f0-9-]{36})\/stages\/([a-z0-9_-]+)\/(run|artifact)$/);
  if (request.method === "POST" && studioStageMatch) {
    const [, projectId, stageId, action] = studioStageMatch;
    if (action === "run") return sendJson(response, 200, { project: await runStudioStage(projectId, stageId) });
    const body = await readJson(request, 2 * 1024 * 1024);
    return sendJson(response, 200, { project: studio.saveArtifact(projectId, stageId, body.artifact, body.status === "specified" ? "specified" : "complete") });
  }
  const studioNextMatch = url.pathname.match(/^\/api\/studio\/projects\/([a-f0-9-]{36})\/run-next$/);
  if (request.method === "POST" && studioNextMatch) {
    const next = studio.nextStage(studioNextMatch[1]);
    if (!next) throw new Error("所有制作阶段都已完成");
    return sendJson(response, 200, { project: await runStudioStage(studioNextMatch[1], next.id) });
  }
  if (request.method === "POST" && url.pathname === "/api/setup") {
    saveSettings(config.dataRoot, await readJson(request));
    applyConfig();
    return sendJson(response, 200, { ok: true, config: publicConfig(config) });
  }
  if (request.method === "POST" && url.pathname === "/api/setup/test") {
    const body = await readJson(request);
    const results = {};
    if (body.scope === "llm" || body.scope === "all") {
      if (!llm.configured) throw new Error("请先保存大模型配置");
      const content = await llm.generate("只返回单个 JSON 对象。", [{ role: "user", content: "返回 {\"ok\":true}，不要添加其他内容。" }]);
      results.llm = Boolean(content);
    }
    if (body.scope === "backend" || body.scope === "all") {
      if (!config.backend.baseUrl) throw new Error("请先保存生成后端地址");
      results.backend = Boolean(await getSnapshot(true, 10000));
    }
    return sendJson(response, 200, { ok: true, results });
  }
  if (request.method === "GET" && url.pathname === "/api/extensions/catalog") {
    return sendJson(response, 200, { extensions: await getExtensionCatalog(true) });
  }
  if (request.method === "POST" && url.pathname === "/api/extensions/prepare") {
    const body = await readJson(request);
    const entry = (await getExtensionCatalog()).find((item) => item.id === body.extensionId);
    if (!entry) throw new Error("扩展不在当前 GitHub 目录中");
    const id = randomUUID();
    const plan = { id, message: `安装扩展 ${entry.id}`, actionName: "extension_install", action: { entry } };
    plans.set(id, plan);
    writeRunRecord(plan, "awaiting_approval", { extension_id: entry.id, extension_version: entry.version });
    return sendJson(response, 200, { kind: "approval", planId: id, action: `从 GitHub 安装 ${entry.kind}：${entry.name} ${entry.version}`, reply: "确认后会下载固定文件、核对 SHA-256，并在启用前执行安全扫描。" });
  }
  if (request.method === "POST" && url.pathname === "/api/plugins/prepare") {
    const body = await readJson(request);
    return sendJson(response, 200, await preparePluginAction("界面快捷操作", String(body.pluginId || ""), String(body.tool || "")));
  }
  if (request.method === "POST" && url.pathname === "/api/chat") return sendJson(response, 200, await handleChat(await readJson(request)));
  if (request.method === "POST" && url.pathname === "/api/confirm") return sendJson(response, 200, await confirmPlan(await readJson(request)));
  if (request.method === "GET" && url.pathname === "/api/queue") return sendJson(response, 200, await backend.queue());
  if (request.method === "GET" && url.pathname.startsWith("/api/history/")) return sendJson(response, 200, await backend.history(decodeURIComponent(url.pathname.slice(13))));
  if (request.method === "GET" && url.pathname === "/api/output") {
    const filename = url.searchParams.get("filename") || "";
    if (!filename || filename.includes("..")) throw new Error("下载文件名无效");
    const query = new URLSearchParams({ filename, subfolder: url.searchParams.get("subfolder") || "", type: url.searchParams.get("type") || "output" });
    const upstream = await backend.request(`view?${query}`);
    response.writeHead(200, {
      "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${path.basename(filename).replaceAll('"', "")}"`,
    });
    response.end(Buffer.from(await upstream.arrayBuffer()));
    return;
  }
  return false;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  try {
    if (request.method === "POST" && request.headers.origin) {
      const allowed = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`]);
      if (!allowed.has(request.headers.origin)) throw new Error("拒绝来自非本地页面的写入请求");
    }
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(request, response, url);
      if (handled !== false) return;
      return sendJson(response, 404, { error: "接口不存在" });
    }
    if (!serveStatic(url.pathname, response)) sendJson(response, 404, { error: "页面不存在" });
  } catch (error) {
    sendError(response, error instanceof SyntaxError ? 400 : 422, error);
  }
});

server.listen(config.port, "127.0.0.1", () => {
  const processFile = path.join(config.dataRoot, "server.json");
  fs.writeFileSync(processFile, `${JSON.stringify({ pid: process.pid, executable: process.execPath, startedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  process.on("exit", () => { try { fs.rmSync(processFile, { force: true }); } catch { /* best effort */ } });
  console.log(`Ropiq: http://127.0.0.1:${config.port}`);
  console.log(`LLM: ${llm.configured ? `${config.llm.provider}:${config.llm.model}` : "未配置"}; Backend: ${config.backend.baseUrl ? config.backend.type : "未配置"}`);
});

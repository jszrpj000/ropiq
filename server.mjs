import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./src/config.mjs";
import { ComfyUiClient, summarizeSnapshot } from "./src/comfyui.mjs";
import { LlmClient } from "./src/llm.mjs";
import { buildNodeCatalog, rankCandidates, validateWorkflow } from "./src/workflow.mjs";

const agentRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = agentRoot;
const publicRoot = path.join(agentRoot, "public");
const config = loadConfig(projectRoot);
if (config.backend.type !== "comfyui") throw new Error(`暂不支持的 BACKEND_TYPE: ${config.backend.type}`);
const backend = new ComfyUiClient(config.backend);
const llm = new LlmClient(config.llm);
const plans = new Map();
const sessions = new Map();
let snapshotCache = null;

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
  const root = path.resolve(projectRoot, "assets", "approved");
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
  const root = path.resolve(projectRoot, "assets", "approved");
  const resolved = path.resolve(root, String(relativePath || ""));
  if (!resolved.startsWith(`${root}${path.sep}`) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error("素材不在 assets/approved/ 中");
  }
  return resolved;
}

function writeRunRecord(plan, status, extra = {}) {
  const date = new Date().toISOString().slice(0, 10);
  const directory = path.join(projectRoot, "runs", date);
  fs.mkdirSync(directory, { recursive: true });
  const workflowPath = plan.workflow ? path.join(directory, `${plan.id}.workflow.json`) : "";
  if (workflowPath) fs.writeFileSync(workflowPath, `${JSON.stringify(plan.workflow, null, 2)}\n`, "utf8");
  const record = {
    task_id: plan.id,
    status,
    recorded_at: new Date().toISOString(),
    user_request: plan.message,
    agent_driver: `${config.llm.provider}:${config.llm.model}`,
    workflow_path: workflowPath ? path.relative(projectRoot, workflowPath).replaceAll("\\", "/") : "",
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

async function handleChat(body) {
  const message = String(body.message || "").trim();
  if (!message) throw new Error("请输入需求");
  const session = getSession(body.sessionId);
  const safeIntent = safeInfoIntent(message);
  if (safeIntent) {
    if (safeIntent === "queue") return { sessionId: session.id, kind: "info", reply: "这是当前生成后端的队列状态。", data: await backend.queue() };
    if (typeof safeIntent === "object") return { sessionId: session.id, kind: "info", reply: `这是任务 ${safeIntent.history} 的历史状态。`, data: await backend.history(safeIntent.history) };
    const snapshot = await getSnapshot(true);
    return { sessionId: session.id, kind: "info", reply: "生成后端已连接，以下信息来自当前实例。", data: summarizeSnapshot(snapshot) };
  }

  if (!llm.configured) throw new Error("未配置 LLM_BASE_URL 和 LLM_MODEL，无法进行智能工作流规划");
  const snapshot = await getSnapshot();
  const summary = summarizeSnapshot(snapshot);
  summary.approved_assets = listApprovedAssets();
  const catalog = buildNodeCatalog(snapshot.objectInfo, message);
  const result = await llm.plan({ message, history: session.history, catalog, summary });
  remember(session, "user", message);
  remember(session, "assistant", result.reply || result.intent || "已生成计划");

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
  const plan = { id, message, workflow: recommended.workflow, validation: recommended.validation, title: recommended.title || "推荐工作流" };
  plans.set(id, plan);
  writeRunRecord(plan, "planned");
  return {
    sessionId: session.id,
    kind: "workflow",
    planId: id,
    reply: result.reply || "已生成并校验推荐工作流。",
    assumptions: result.assumptions || [],
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
  } else {
    throw new Error("该操作不支持确认执行");
  }
  plans.delete(plan.id);
  return { ok: true, result };
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
    });
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
  console.log(`Ropiq: http://127.0.0.1:${config.port}`);
  console.log(`LLM: ${llm.configured ? `${config.llm.provider}:${config.llm.model}` : "未配置"}; Backend: ${config.backend.baseUrl ? config.backend.type : "未配置"}`);
});

const conversation = document.querySelector("#conversation");
const form = document.querySelector("#composer");
const promptInput = document.querySelector("#prompt");
const sendButton = document.querySelector("#send");
const setupDialog = document.querySelector("#setup-dialog");
const setupForm = document.querySelector("#setup-form");
const extensionsDialog = document.querySelector("#extensions-dialog");
let sessionId = sessionStorage.getItem("ropiq-session") || "";
let bootstrapData = null;

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function scrollToBottom() { conversation.scrollTop = conversation.scrollHeight; }

function addUserMessage(text) {
  const article = element("article", "message user");
  const body = element("div", "message-body");
  body.append(element("p", "", text));
  article.append(body);
  conversation.append(article);
  scrollToBottom();
}

function addAssistantMessage(reply, className = "") {
  const article = element("article", `message assistant ${className}`.trim());
  article.append(element("div", "assistant-mark", "R"));
  const body = element("div", "message-body");
  body.append(element("span", "message-label", "ROPIQ"), element("p", "", reply));
  article.append(body);
  conversation.append(article);
  scrollToBottom();
  return { article, body };
}

function addJsonDetails(parent, label, data) {
  const details = document.createElement("details");
  details.append(element("summary", "", label), element("pre", "", JSON.stringify(data, null, 2)));
  parent.append(details);
}

function addPills(parent, values, prefix = "Skill") {
  if (!values?.length) return;
  const row = element("div", "pill-row");
  values.forEach((value) => row.append(element("span", "pill", `${prefix} · ${value}`)));
  parent.append(row);
}

function renderWorkflow(result) {
  const { body } = addAssistantMessage(result.reply);
  addPills(body, result.usedSkills);
  const card = element("section", "card");
  const head = element("div", "card-head");
  head.append(element("strong", "", result.recommended.title), element("span", "score", `${result.recommended.validation.score}/100`));
  card.append(head);
  if (result.recommended.rationale) card.append(element("p", "muted", result.recommended.rationale));
  if (result.assumptions?.length) {
    const list = element("ul", "assumption-list");
    result.assumptions.forEach((item) => list.append(element("li", "", item)));
    card.append(list);
  }
  if (result.recommended.validation.warnings?.length) {
    const list = element("ul", "warning-list");
    result.recommended.validation.warnings.forEach((item) => list.append(element("li", "", item)));
    card.append(list);
  }
  const actions = element("div", "card-actions");
  const execute = element("button", "primary", "确认并发送到生成后端");
  execute.addEventListener("click", () => confirmPlan(result.planId, execute));
  actions.append(execute);
  card.append(actions);
  addJsonDetails(card, "查看工作流 JSON", result.recommended.workflow);
  if (result.alternatives?.length) addJsonDetails(card, "查看备选方案评分", result.alternatives);
  body.append(card);
}

function renderApproval(result) {
  const { body } = addAssistantMessage(result.reply);
  const card = element("section", "card approval-card");
  card.append(element("strong", "", `待确认：${result.action}`));
  const actions = element("div", "card-actions");
  const approve = element("button", "primary", "确认执行");
  approve.addEventListener("click", () => confirmPlan(result.planId, approve));
  actions.append(approve);
  card.append(actions);
  body.append(card);
}

function renderResult(result) {
  if (result.sessionId) {
    sessionId = result.sessionId;
    sessionStorage.setItem("ropiq-session", sessionId);
  }
  if (result.kind === "workflow") return renderWorkflow(result);
  if (result.kind === "approval") return renderApproval(result);
  const { body } = addAssistantMessage(result.reply || "完成");
  if (result.usedPlugin) addPills(body, [result.usedPlugin], "插件");
  if (result.kind === "download") {
    const link = element("a", "primary", "下载输出文件");
    link.href = result.downloadUrl;
    body.append(link);
  } else if (result.data) addJsonDetails(body, "查看详细信息", result.data);
}

async function confirmPlan(planId, button) {
  if (!window.confirm("确认执行该操作？它可能使用本地或云端算力、产生费用、安装扩展或改变实例状态。")) return;
  button.disabled = true;
  try {
    const result = await api("/api/confirm", { method: "POST", body: JSON.stringify({ planId, approved: true }) });
    addAssistantMessage(`操作已完成。${result.result?.prompt_id ? `任务 ID：${result.result.prompt_id}` : ""}`);
    button.textContent = "已执行";
    await loadBootstrap();
  } catch (error) {
    addAssistantMessage(error.message, "error");
    button.disabled = false;
  }
}

async function sendMessage(text) {
  const value = text.trim();
  if (!value) return;
  addUserMessage(value);
  const thinking = addAssistantMessage("正在选择 Skills、插件与节点，并校验候选方案…", "thinking");
  sendButton.disabled = true;
  try {
    const result = await api("/api/chat", { method: "POST", body: JSON.stringify({ message: value, sessionId }) });
    thinking.article.remove();
    renderResult(result);
  } catch (error) {
    thinking.article.remove();
    addAssistantMessage(error.message, "error");
    if (/配置/.test(error.message)) openSetup();
  } finally {
    sendButton.disabled = false;
    promptInput.focus();
  }
}

function metric(parent, label, value) {
  const row = element("div", "metric");
  row.append(element("span", "", label), element("span", "", String(value)));
  parent.append(row);
}

function renderExtensionSummary(data) {
  const target = document.querySelector("#extension-summary");
  target.replaceChildren();
  metric(target, "Skills", data.extensions?.skills?.length || 0);
  metric(target, "插件", data.extensions?.plugins?.length || 0);
  metric(target, "安全扫描", data.security?.installed ? "NVIDIA SkillSpector" : "Ropiq 基础扫描");
}

function renderBootstrap(data) {
  bootstrapData = data;
  const backendDot = document.querySelector("#backend-dot");
  const llmDot = document.querySelector("#llm-dot");
  backendDot.className = `status-dot ${data.connected ? "ok" : "bad"}`;
  llmDot.className = `status-dot ${data.llmConfigured ? "ok" : "bad"}`;
  document.querySelector("#backend-status").textContent = data.connected ? "生成后端已连接" : "生成后端未连接";
  document.querySelector("#llm-status").textContent = data.llmConfigured ? "模型接口已配置" : "模型接口未配置";
  document.querySelector("#model-label").textContent = data.llmConfigured ? `${data.provider} · ${data.model}` : "未配置模型";

  const environment = document.querySelector("#environment");
  environment.replaceChildren();
  [
    ["状态", data.connected ? "在线" : (data.connectionError || "未配置")],
    ["适配器", data.backendType === "comfyui" ? "节点图后端" : (data.backendType || "—")],
    ["节点", data.summary?.node_count ?? "—"], ["模型", data.summary?.model_count ?? "—"],
    ["设备", data.summary?.devices?.[0]?.name ?? "—"],
    ["显存", data.summary?.devices?.[0]?.vram_total_gb ? `${data.summary.devices[0].vram_total_gb} GB` : "—"],
  ].forEach(([label, value]) => metric(environment, label, value));

  const assets = document.querySelector("#assets");
  assets.replaceChildren();
  if (!data.approvedAssets?.length) assets.append(element("p", "muted", "暂无已授权图片"));
  else data.approvedAssets.forEach((asset) => assets.append(element("div", "asset", asset)));
  renderExtensionSummary(data);

  const stopTool = data.tools?.find((tool) => tool.plugin_id === "cloud-lifecycle" && tool.tool === "instance_stop" && tool.configured);
  document.querySelector("#cloud-stop").hidden = !stopTool;
}

async function loadBootstrap() {
  const data = await api("/api/bootstrap");
  renderBootstrap(data);
  return data;
}

function populateSetup() {
  if (!bootstrapData?.config) return;
  const cfg = bootstrapData.config;
  setupForm.elements.llmProvider.value = cfg.llm.provider;
  setupForm.elements.llmBaseUrl.value = cfg.llm.baseUrl || "https://api.deepseek.com/v1";
  setupForm.elements.llmModel.value = cfg.llm.model || "deepseek-chat";
  setupForm.elements.llmApiKey.value = "";
  setupForm.elements.backendBaseUrl.value = cfg.backend.baseUrl;
  setupForm.elements.cloudStatusUrl.value = cfg.plugins.cloudLifecycle.statusUrl;
  setupForm.elements.cloudStopUrl.value = cfg.plugins.cloudLifecycle.stopUrl;
  setupForm.elements.cloudToken.value = "";
  setupForm.elements.catalogUrl.value = cfg.extensions.catalogUrl;
}

function openSetup() {
  populateSetup();
  if (!setupDialog.open) setupDialog.showModal();
}

function setupPayload() {
  const values = new FormData(setupForm);
  return {
    llm: { provider: values.get("llmProvider"), baseUrl: values.get("llmBaseUrl"), apiKey: values.get("llmApiKey"), model: values.get("llmModel") },
    backend: { baseUrl: values.get("backendBaseUrl") },
    extensions: { catalogUrl: values.get("catalogUrl"), autoInstallSkills: true },
    plugins: { cloudLifecycle: { statusUrl: values.get("cloudStatusUrl"), stopUrl: values.get("cloudStopUrl"), token: values.get("cloudToken") } },
  };
}

async function saveSetup() {
  const result = document.querySelector("#setup-result");
  result.textContent = "正在保存…";
  await api("/api/setup", { method: "POST", body: JSON.stringify(setupPayload()) });
  result.textContent = "配置已安全保存到本机。";
  await loadBootstrap();
}

function extensionRow(item, installed = false) {
  const row = element("div", "extension-row");
  const copy = element("div", "extension-copy");
  copy.append(element("strong", "", item.name || item.id), element("small", "", `${item.kind === "plugin" || item.tools ? "PLUGIN" : "SKILL"} · ${item.version}`), element("p", "", item.description || ""));
  row.append(copy);
  if (installed) row.append(element("span", "installed-badge", "已安装"));
  else {
    const install = element("button", "secondary", "安装");
    install.addEventListener("click", async () => {
      install.disabled = true;
      try {
        const prepared = await api("/api/extensions/prepare", { method: "POST", body: JSON.stringify({ extensionId: item.id }) });
        extensionsDialog.close();
        renderApproval(prepared);
      } catch (error) {
        install.disabled = false;
        window.alert(error.message);
      }
    });
    row.append(install);
  }
  return row;
}

function openExtensions() {
  const target = document.querySelector("#installed-extensions");
  target.replaceChildren();
  const installed = [...(bootstrapData?.extensions?.skills || []).map((item) => ({ ...item, kind: "skill" })), ...(bootstrapData?.extensions?.plugins || []).map((item) => ({ ...item, kind: "plugin" }))];
  installed.forEach((item) => target.append(extensionRow(item, true)));
  const scanner = bootstrapData?.security;
  document.querySelector("#scanner-dot").className = `status-dot ${scanner?.installed ? "ok" : ""}`;
  document.querySelector("#scanner-title").textContent = scanner?.installed ? "NVIDIA SkillSpector 已启用" : "Ropiq 基础扫描已启用";
  document.querySelector("#scanner-copy").textContent = scanner?.installed ? "GitHub Skill 会经过完整静态安全扫描。" : "可选安装 NVIDIA SkillSpector 以获得完整扫描。";
  if (!extensionsDialog.open) extensionsDialog.showModal();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = promptInput.value;
  promptInput.value = "";
  promptInput.style.height = "auto";
  sendMessage(text);
});

promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
});

promptInput.addEventListener("input", () => {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 170)}px`;
});

document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => sendMessage(button.dataset.prompt)));
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => document.querySelector(`#${button.dataset.close}`).close()));
document.querySelector("#new-chat").addEventListener("click", () => { sessionId = ""; sessionStorage.removeItem("ropiq-session"); window.location.reload(); });
document.querySelector("#open-setup").addEventListener("click", openSetup);
document.querySelector("#open-extensions").addEventListener("click", openExtensions);
document.querySelector("#cloud-stop").addEventListener("click", async () => renderResult(await api("/api/plugins/prepare", { method: "POST", body: JSON.stringify({ pluginId: "cloud-lifecycle", tool: "instance_stop" }) })));

setupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try { await saveSetup(); setupDialog.close(); } catch (error) { document.querySelector("#setup-result").textContent = error.message; }
});

document.querySelector("#test-llm").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try { await saveSetup(); await api("/api/setup/test", { method: "POST", body: JSON.stringify({ scope: "llm" }) }); document.querySelector("#setup-result").textContent = "模型连接测试通过。"; }
  catch (error) { document.querySelector("#setup-result").textContent = error.message; }
  finally { button.disabled = false; }
});

document.querySelector("#refresh-catalog").addEventListener("click", async (event) => {
  const target = document.querySelector("#catalog-extensions");
  event.currentTarget.disabled = true;
  target.replaceChildren(element("p", "muted", "正在从 GitHub 读取并验证目录…"));
  try {
    const data = await api("/api/extensions/catalog");
    target.replaceChildren();
    const installedIds = new Set([...(bootstrapData?.extensions?.skills || []), ...(bootstrapData?.extensions?.plugins || [])].map((item) => item.id));
    data.extensions.filter((item) => !installedIds.has(item.id)).forEach((item) => target.append(extensionRow(item)));
    if (!target.children.length) target.append(element("p", "muted", "当前目录没有需要安装的新扩展。"));
  } catch (error) { target.replaceChildren(element("p", "error", error.message)); }
  finally { event.currentTarget.disabled = false; }
});

loadBootstrap().then((data) => { if (!data.llmConfigured) openSetup(); }).catch((error) => addAssistantMessage(error.message, "error"));

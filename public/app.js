const conversation = document.querySelector("#conversation");
const form = document.querySelector("#composer");
const promptInput = document.querySelector("#prompt");
const sendButton = document.querySelector("#send");
let sessionId = sessionStorage.getItem("ropiq-session") || "";

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
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

function scrollToBottom() {
  conversation.scrollTop = conversation.scrollHeight;
}

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

function renderWorkflow(result) {
  const { body } = addAssistantMessage(result.reply);
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
  const card = element("section", "card");
  card.append(element("strong", "", `待确认操作：${result.action}`));
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
  if (result.kind === "download") {
    const link = element("a", "primary", "下载输出文件");
    link.href = result.downloadUrl;
    body.append(link);
  } else if (result.data) {
    addJsonDetails(body, "查看详细信息", result.data);
  }
}

async function confirmPlan(planId, button) {
  if (!window.confirm("确认执行该操作？这可能使用本地或云端算力、产生费用或改变生成队列。")) return;
  button.disabled = true;
  try {
    const result = await api("/api/confirm", { method: "POST", body: JSON.stringify({ planId, approved: true }) });
    addAssistantMessage(`操作已提交。${result.result?.prompt_id ? `任务 ID：${result.result.prompt_id}` : ""}`);
    button.textContent = "已执行";
  } catch (error) {
    addAssistantMessage(error.message, "error");
    button.disabled = false;
  }
}

async function sendMessage(text) {
  const value = text.trim();
  if (!value) return;
  addUserMessage(value);
  const thinking = addAssistantMessage("正在盘点节点、模型和资源，并校验候选工作流…", "thinking");
  sendButton.disabled = true;
  try {
    const result = await api("/api/chat", { method: "POST", body: JSON.stringify({ message: value, sessionId }) });
    thinking.article.remove();
    renderResult(result);
  } catch (error) {
    thinking.article.remove();
    addAssistantMessage(error.message, "error");
  } finally {
    sendButton.disabled = false;
    promptInput.focus();
  }
}

function renderBootstrap(data) {
  const backendDot = document.querySelector("#backend-dot");
  const llmDot = document.querySelector("#llm-dot");
  backendDot.className = `status-dot ${data.connected ? "ok" : "bad"}`;
  llmDot.className = `status-dot ${data.llmConfigured ? "ok" : "bad"}`;
  document.querySelector("#backend-status").textContent = data.connected ? "生成后端已连接" : "生成后端未连接";
  document.querySelector("#llm-status").textContent = data.llmConfigured ? "模型接口已配置" : "模型接口未配置";
  document.querySelector("#model-label").textContent = data.llmConfigured ? `${data.provider} · ${data.model}` : "未配置模型";

  const environment = document.querySelector("#environment");
  environment.replaceChildren();
  const metrics = [
    ["状态", data.connected ? "在线" : (data.connectionError || "未配置")],
    ["适配器", data.backendType === "comfyui" ? "节点图后端" : (data.backendType || "—")],
    ["节点", data.summary?.node_count ?? "—"],
    ["模型", data.summary?.model_count ?? "—"],
    ["模板", data.summary?.template_count ?? "—"],
    ["设备", data.summary?.devices?.[0]?.name ?? "—"],
    ["显存", data.summary?.devices?.[0]?.vram_total_gb ? `${data.summary.devices[0].vram_total_gb} GB` : "—"],
  ];
  for (const [label, value] of metrics) {
    const row = element("div", "metric");
    row.append(element("span", "", label), element("span", "", String(value)));
    environment.append(row);
  }

  const assets = document.querySelector("#assets");
  assets.replaceChildren();
  if (!data.approvedAssets?.length) assets.append(element("p", "muted", "暂无已授权图片"));
  else data.approvedAssets.forEach((asset) => assets.append(element("div", "asset", asset)));
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = promptInput.value;
  promptInput.value = "";
  promptInput.style.height = "auto";
  sendMessage(text);
});

promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

promptInput.addEventListener("input", () => {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 170)}px`;
});

document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => sendMessage(button.dataset.prompt)));
document.querySelector("#new-chat").addEventListener("click", () => {
  sessionId = "";
  sessionStorage.removeItem("ropiq-session");
  window.location.reload();
});

api("/api/bootstrap").then(renderBootstrap).catch((error) => addAssistantMessage(error.message, "error"));

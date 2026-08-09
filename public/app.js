const conversation = document.querySelector("#conversation");
const form = document.querySelector("#composer");
const promptInput = document.querySelector("#prompt");
const sendButton = document.querySelector("#send");
const setupDialog = document.querySelector("#setup-dialog");
const setupForm = document.querySelector("#setup-form");
const extensionsDialog = document.querySelector("#extensions-dialog");
const studioDialog = document.querySelector("#studio-dialog");
const studioCreateForm = document.querySelector("#studio-create-form");
let sessionId = sessionStorage.getItem("ropiq-session") || "";
let bootstrapData = null;
let studioPipelines = null;
let studioProjects = [];
let currentStudioType = "drama";
let currentStudioProject = null;
let selectedStudioStageId = "";
let studioPendingExecution = null;

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

const studioStatusLabels = {
  pending: "待生成",
  running: "生成中",
  complete: "已完成",
  specified: "规格已就绪",
  stale: "需重做",
  error: "生成失败",
};

function studioTypeCopy(type) {
  return type === "drama"
    ? { title: "AI 短剧工坊", heading: "创建 AI 短剧项目", copy: "导入有权使用的小说或故事，智能体会按完整 17 阶段生产链逐步处理。", tag: "AI DRAMA" }
    : { title: "商品视频工坊", heading: "创建商品宣传视频", copy: "填写商品事实、素材、受众和平台要求，智能体会建立不夸大功效的宣传视频生产链。", tag: "PRODUCT VIDEO" };
}

function showStudioCreate() {
  currentStudioProject = null;
  selectedStudioStageId = "";
  studioCreateForm.hidden = false;
  document.querySelector("#studio-workspace").hidden = true;
  studioCreateForm.reset();
  studioCreateForm.elements.type.value = currentStudioType;
  studioCreateForm.elements.episodes.value = 1;
  studioCreateForm.elements.episodeSeconds.value = currentStudioType === "drama" ? 90 : 30;
  studioCreateForm.elements.style.value = currentStudioType === "drama" ? "写实电影感" : "干净棚拍、商品质感清晰";
  studioCreateForm.elements.previewFirst.checked = true;
  document.querySelector("#studio-source-count").textContent = "0 / 400000 字符";
  document.querySelector("#studio-create-result").textContent = "";
  studioDialog.scrollTop = 0;
  document.querySelector(".studio-main").scrollTop = 0;
  renderStudioProjectList();
}

function renderStudioProjectList() {
  const target = document.querySelector("#studio-project-list");
  target.replaceChildren();
  const projects = studioProjects.filter((project) => project.type === currentStudioType);
  if (!projects.length) target.append(element("p", "muted", "还没有项目"));
  projects.forEach((project) => {
    const button = element("button", `studio-project-card ${project.id === currentStudioProject?.id ? "active" : ""}`.trim());
    button.append(element("strong", "", project.title), element("small", "", `${project.progress.done}/${project.progress.total} 阶段 · ${new Date(project.updatedAt).toLocaleDateString()}`));
    button.addEventListener("click", () => loadStudioProject(project.id));
    target.append(button);
  });
}

function inferredStageCapability(stage, artifact) {
  if (artifact?.execution) {
    const execution = artifact.execution;
    return execution.ready
      ? { ready: true, text: `执行器 ${execution.executor} 已就绪${execution.mode === "specification_only" ? "；当前保存的是待确认任务规格" : ""}` }
      : { ready: false, text: (execution.missing || []).join("；") || `执行器 ${execution.executor} 尚未就绪` };
  }
  if (stage.executor === "llm") return { ready: Boolean(bootstrapData?.llmConfigured), text: bootstrapData?.llmConfigured ? "大模型可生成并保存本阶段内容" : "请先配置大模型接口" };
  if (stage.executor === "comfyui") return { ready: Boolean(bootstrapData?.connected), text: bootstrapData?.connected ? "节点图后端已连接；生成后会先保存待确认任务规格" : "请连接本地或云端节点图后端" };
  const keyword = stage.executor.slice(7);
  const ready = bootstrapData?.tools?.some((tool) => tool.configured && `${tool.plugin_id} ${tool.tool}`.toLowerCase().includes(keyword));
  return { ready: Boolean(ready), text: ready ? `${keyword} 插件已配置；执行前仍需确认` : `缺少 ${keyword} 执行插件；本阶段仍可先生成任务规格` };
}

function selectStudioStage(stageId) {
  if (!currentStudioProject) return;
  selectedStudioStageId = stageId;
  if (studioPendingExecution?.stageId !== stageId) studioPendingExecution = null;
  renderStudioProject(currentStudioProject);
}

function renderStudioRuns(artifact) {
  const target = document.querySelector("#studio-run-list");
  target.replaceChildren();
  const runs = [...(artifact?.execution?.runs || [])].reverse();
  if (!runs.length) {
    target.append(element("p", "muted", "暂无执行记录"));
    return;
  }
  runs.slice(0, 8).forEach((run) => {
    const row = element("div", "studio-run-row");
    const copy = element("div", "");
    copy.append(element("strong", "", run.title || `任务 ${run.promptId.slice(0, 8)}`), element("small", "", `${run.promptId} · ${new Date(run.updatedAt || run.submittedAt).toLocaleString()}`));
    if (run.error) copy.append(element("small", "error", run.error));
    if (run.outputs?.length) {
      const links = element("div", "studio-output-links");
      run.outputs.forEach((output, index) => {
        const link = element("a", "", `下载输出 ${index + 1}`);
        const params = new URLSearchParams({ filename: output.filename || "", subfolder: output.subfolder || "", type: output.type || "output" });
        link.href = output.downloadUrl || `/api/output?${params}`;
        link.target = "_blank";
        link.rel = "noopener";
        links.append(link);
      });
      copy.append(links);
    }
    const state = element("div", "studio-run-state");
    state.append(element("span", `studio-run-status ${run.status || ""}`, run.status === "success" ? "已完成" : run.status === "error" ? "失败" : run.status === "running" ? "运行中" : "已提交"));
    if (!new Set(["success", "error"]).has(run.status)) {
      const sync = element("button", "studio-run-sync", "同步状态");
      sync.type = "button";
      sync.addEventListener("click", async () => {
        sync.disabled = true;
        await pollStudioExecution(currentStudioProject.id, selectedStudioStageId, run.promptId, true);
        sync.disabled = false;
      });
      state.append(sync);
    }
    row.append(copy, state);
    target.append(row);
  });
}

function renderStudioExecutionPlan(plan) {
  studioPendingExecution = { ...plan, projectId: currentStudioProject.id, stageId: selectedStudioStageId };
  const panel = document.querySelector("#studio-execution-panel");
  panel.hidden = false;
  document.querySelector("#studio-execution-title").textContent = plan.recommended.title;
  document.querySelector("#studio-execution-score").textContent = `${plan.recommended.validation.score}/100`;
  document.querySelector("#studio-execution-reply").textContent = plan.reply || "节点图已通过本地校验，等待确认。";
  document.querySelector("#studio-execution-workflow").textContent = JSON.stringify(plan.recommended.workflow, null, 2);
}

function renderStudioProject(project) {
  currentStudioProject = project;
  studioCreateForm.hidden = true;
  document.querySelector("#studio-workspace").hidden = false;
  studioDialog.scrollTop = 0;
  document.querySelector(".studio-main").scrollTop = 0;
  const typeCopy = studioTypeCopy(project.type);
  document.querySelector("#studio-project-type").textContent = typeCopy.tag;
  document.querySelector("#studio-project-name").textContent = project.title;
  document.querySelector("#studio-project-meta").textContent = `${project.settings.episodes} 集 · ${project.settings.episodeSeconds} 秒 · ${project.settings.aspectRatio} · 预算 ${project.settings.budgetCny || 0} 元`;
  document.querySelector("#studio-progress-label").textContent = `${project.progress.done} / ${project.progress.total}`;
  document.querySelector("#studio-progress-bar").style.width = `${project.progress.percent}%`;

  const stages = document.querySelector("#studio-stages");
  stages.replaceChildren();
  if (!selectedStudioStageId || !project.stages.some((stage) => stage.id === selectedStudioStageId)) {
    selectedStudioStageId = project.stages.find((stage) => ["pending", "stale", "error"].includes(stage.status))?.id || project.stages[0].id;
  }
  project.stages.forEach((stage) => {
    const button = element("button", `studio-stage-button ${stage.id === selectedStudioStageId ? "active" : ""}`.trim());
    button.type = "button";
    button.append(element("span", "studio-stage-number", String(stage.order).padStart(2, "0")), element("small", "", stage.name), element("i", `stage-dot ${stage.status}`));
    button.addEventListener("click", () => selectStudioStage(stage.id));
    stages.append(button);
  });

  const stage = project.stages.find((item) => item.id === selectedStudioStageId);
  const artifact = project.artifacts?.[stage.id];
  if (!studioPendingExecution || studioPendingExecution.projectId !== project.id || studioPendingExecution.stageId !== stage.id) {
    document.querySelector("#studio-execution-panel").hidden = true;
  }
  document.querySelector("#studio-stage-order").textContent = `STAGE ${String(stage.order).padStart(2, "0")} · ${stage.executor.toUpperCase()}`;
  document.querySelector("#studio-stage-name").textContent = stage.name;
  document.querySelector("#studio-stage-instruction").textContent = stage.instruction;
  const status = document.querySelector("#studio-stage-status");
  status.className = `stage-status ${stage.status}`;
  status.textContent = studioStatusLabels[stage.status] || stage.status;
  const capability = inferredStageCapability(stage, artifact);
  const capabilityNode = document.querySelector("#studio-stage-capability");
  capabilityNode.className = `capability-note ${capability.ready ? "ready" : "missing"}`;
  capabilityNode.textContent = capability.text;
  document.querySelector("#studio-artifact").value = artifact ? JSON.stringify(artifact, null, 2) : "";
  renderStudioRuns(artifact);
  document.querySelector("#studio-action-result").textContent = stage.summary || "";
  document.querySelector("#studio-run-stage").textContent = ["complete", "specified", "stale", "error"].includes(stage.status) ? "重新生成当前阶段" : "生成当前阶段";
  const prepareExecution = document.querySelector("#studio-prepare-execution");
  prepareExecution.hidden = stage.executor !== "comfyui" || !artifact;
  prepareExecution.disabled = !bootstrapData?.connected || stage.status === "running";
  prepareExecution.title = bootstrapData?.connected ? "生成并校验可执行节点图" : "生成后端当前离线";
  renderStudioProjectList();
}

async function loadStudioProject(id) {
  try {
    const data = await api(`/api/studio/projects/${id}`);
    renderStudioProject(data.project);
  } catch (error) {
    document.querySelector("#studio-create-result").textContent = error.message;
  }
}

async function refreshStudioProjects() {
  const [pipelineData, projectData] = await Promise.all([
    studioPipelines ? Promise.resolve({ pipelines: studioPipelines }) : api("/api/studio/pipelines"),
    api("/api/studio/projects"),
  ]);
  studioPipelines = pipelineData.pipelines;
  studioProjects = projectData.projects;
  renderStudioProjectList();
}

async function openStudio(type) {
  currentStudioType = type;
  const copy = studioTypeCopy(type);
  document.querySelector("#studio-title").textContent = copy.title;
  document.querySelector("#studio-create-heading").textContent = copy.heading;
  document.querySelector("#studio-create-copy").textContent = copy.copy;
  if (!studioDialog.open) studioDialog.showModal();
  try {
    await refreshStudioProjects();
    const recent = studioProjects.find((project) => project.type === type);
    if (recent) await loadStudioProject(recent.id);
    else showStudioCreate();
  } catch (error) {
    showStudioCreate();
    document.querySelector("#studio-create-result").textContent = error.message;
  }
}

async function runStudio(action, button) {
  if (!currentStudioProject) return;
  if (action === "next") {
    const next = currentStudioProject.stages.find((stage) => ["pending", "stale", "error"].includes(stage.status));
    if (next) selectedStudioStageId = next.id;
  }
  button.disabled = true;
  const result = document.querySelector("#studio-action-result");
  result.textContent = "正在生成并保存结构化阶段产物…长文本首次解析可能需要数分钟。";
  try {
    const url = action === "next"
      ? `/api/studio/projects/${currentStudioProject.id}/run-next`
      : `/api/studio/projects/${currentStudioProject.id}/stages/${selectedStudioStageId}/run`;
    const data = await api(url, { method: "POST", body: "{}" });
    currentStudioProject = data.project;
    const summary = data.project.artifacts?.[selectedStudioStageId]?.summary;
    renderStudioProject(data.project);
    document.querySelector("#studio-action-result").textContent = summary || "阶段产物已保存。";
    await refreshStudioProjects();
  } catch (error) {
    result.textContent = error.message;
    if (/配置大模型/.test(error.message)) openSetup();
    if (currentStudioProject) await loadStudioProject(currentStudioProject.id);
  } finally {
    button.disabled = false;
  }
}

async function prepareStudioExecution(button) {
  if (!currentStudioProject) return;
  const result = document.querySelector("#studio-action-result");
  button.disabled = true;
  result.textContent = "正在根据阶段产物选择真实节点、模型并校验节点图…";
  try {
    const plan = await api(`/api/studio/projects/${currentStudioProject.id}/stages/${selectedStudioStageId}/prepare-execution`, { method: "POST", body: "{}" });
    renderStudioExecutionPlan(plan);
    result.textContent = `节点图已通过校验：${plan.recommended.validation.score}/100。请检查后确认执行。`;
  } catch (error) {
    result.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function pollStudioExecution(projectId, stageId, promptId, immediate = false) {
  const result = document.querySelector("#studio-action-result");
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (!immediate || attempt > 0) await wait(2000);
    try {
      const data = await api(`/api/studio/projects/${projectId}/stages/${stageId}/runs/${promptId}/sync`, { method: "POST", body: "{}" });
      if (data.completed) {
        if (currentStudioProject?.id === projectId) {
          currentStudioProject = data.project;
          selectedStudioStageId = stageId;
          renderStudioProject(data.project);
        }
        result.textContent = data.run.status === "success" ? `云端执行完成，已登记 ${data.run.outputs.length} 个输出。` : `云端执行失败：${data.run.error}`;
        await refreshStudioProjects();
        return;
      }
      result.textContent = `云端任务 ${promptId.slice(0, 8)} 正在运行…`;
    } catch (error) {
      result.textContent = `状态同步失败：${error.message}`;
      return;
    }
  }
  result.textContent = "任务仍在云端运行；项目已保存任务 ID，稍后可继续同步。";
}

async function confirmStudioExecution(button) {
  if (!studioPendingExecution) return;
  if (!window.confirm("确认发送这个已校验节点图？它会使用本地或云端 GPU，并可能产生费用。")) return;
  button.disabled = true;
  const result = document.querySelector("#studio-action-result");
  result.textContent = "正在执行前重新校验并提交…";
  try {
    const pending = studioPendingExecution;
    const confirmed = await api("/api/confirm", { method: "POST", body: JSON.stringify({ planId: pending.planId, approved: true }) });
    const promptId = confirmed.result?.prompt_id;
    if (!promptId || !confirmed.studioProject) throw new Error("云端没有返回有效任务 ID");
    currentStudioProject = confirmed.studioProject;
    studioPendingExecution = null;
    renderStudioProject(currentStudioProject);
    result.textContent = `任务 ${promptId.slice(0, 8)} 已提交，正在等待输出…`;
    await pollStudioExecution(pending.projectId, pending.stageId, promptId);
  } catch (error) {
    result.textContent = error.message;
    button.disabled = false;
  }
}

studioCreateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = studioCreateForm.querySelector("button[type=submit]");
  const result = document.querySelector("#studio-create-result");
  button.disabled = true;
  result.textContent = "正在创建项目…";
  try {
    const values = new FormData(studioCreateForm);
    const file = studioCreateForm.elements.sourceFile.files[0];
    const payload = {
      type: currentStudioType,
      title: values.get("title"),
      filename: file?.name || "",
      sourceText: values.get("sourceText"),
      settings: {
        episodes: Number(values.get("episodes")),
        episodeSeconds: Number(values.get("episodeSeconds")),
        aspectRatio: values.get("aspectRatio"),
        budgetCny: Number(values.get("budgetCny")),
        style: values.get("style"),
        previewFirst: values.get("previewFirst") === "on",
      },
    };
    const data = await api("/api/studio/projects", { method: "POST", body: JSON.stringify(payload) });
    studioProjects.unshift({ id: data.project.id, type: data.project.type, title: data.project.title, updatedAt: data.project.updatedAt, progress: data.project.progress });
    renderStudioProject(data.project);
  } catch (error) {
    result.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#studio-source-file").addEventListener("change", async (event) => {
  const file = event.currentTarget.files[0];
  if (!file) return;
  const text = await file.text();
  if (text.length > 400000) {
    document.querySelector("#studio-create-result").textContent = "文件超过首版 40 万字符上限，请拆分后导入。";
    event.currentTarget.value = "";
    return;
  }
  studioCreateForm.elements.sourceText.value = text;
  document.querySelector("#studio-source-count").textContent = `${text.length} / 400000 字符`;
});

studioCreateForm.elements.sourceText.addEventListener("input", (event) => {
  document.querySelector("#studio-source-count").textContent = `${event.currentTarget.value.length} / 400000 字符`;
});

document.querySelector("#studio-save-artifact").addEventListener("click", async (event) => {
  if (!currentStudioProject) return;
  const result = document.querySelector("#studio-action-result");
  event.currentTarget.disabled = true;
  try {
    const artifact = JSON.parse(document.querySelector("#studio-artifact").value || "{}");
    const stage = currentStudioProject.stages.find((item) => item.id === selectedStudioStageId);
    const status = stage?.executor === "llm" ? "complete" : "specified";
    const data = await api(`/api/studio/projects/${currentStudioProject.id}/stages/${selectedStudioStageId}/artifact`, { method: "POST", body: JSON.stringify({ artifact, status }) });
    renderStudioProject(data.project);
    result.textContent = "修改已保存；受影响的下游阶段已标记为需要重做。";
    await refreshStudioProjects();
  } catch (error) { result.textContent = `保存失败：${error.message}`; }
  finally { event.currentTarget.disabled = false; }
});

document.querySelector("#studio-run-stage").addEventListener("click", (event) => runStudio("stage", event.currentTarget));
document.querySelector("#studio-prepare-execution").addEventListener("click", (event) => prepareStudioExecution(event.currentTarget));
document.querySelector("#studio-confirm-execution").addEventListener("click", (event) => confirmStudioExecution(event.currentTarget));
document.querySelector("#studio-run-next").addEventListener("click", (event) => runStudio("next", event.currentTarget));
document.querySelector("#studio-new-project").addEventListener("click", showStudioCreate);

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
document.querySelector("#open-drama-studio").addEventListener("click", () => openStudio("drama"));
document.querySelector("#open-product-studio").addEventListener("click", () => openStudio("product"));
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

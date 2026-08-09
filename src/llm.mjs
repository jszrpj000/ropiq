export function parseJsonContent(content) {
  if (typeof content !== "string" || !content.trim()) throw new Error("大模型返回了空内容");
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}

function systemPrompt(catalog, summary, skills = [], tools = [], availableExtensions = []) {
  const skillText = skills.map((skill) => `## ${skill.name} (${skill.id})\n${skill.instructions}`).join("\n\n");
  return `你是 Ropiq 的生成工作流规划智能体。用户只描述目标，你负责基于当前连接后端的真实能力设计最佳方案。

必须输出单个 JSON 对象，不得输出 Markdown。格式：
{
  "reply": "给用户的简洁中文说明",
  "intent": "workflow|plugin|extension_install|status|interrupt|clear_queue|free_memory|upload_asset|download_output|help",
  "assumptions": ["必要假设"],
  "action": {"plugin_id":"", "tool":"", "extension_id":"", "relative_path":"", "filename":"", "subfolder":"", "type":"output"},
  "candidates": [{"title":"方案名", "rationale":"取舍", "workflow":{"1":{"class_type":"节点类型","inputs":{}}}}]
}

规则：
1. workflow 意图生成 1 到 3 个候选 API prompt 工作流，首选质量、稳定性与当前显存匹配的方案。
2. 只能使用节点目录中的 class_type、输入名和可用枚举值；连线格式为 ["源节点ID", 输出序号]。
3. 所有必填输入都要提供，并包含真实 output_node；不要编造模型、节点、输入或输出。
4. 不得声称已执行。中断、清队列、释放显存、上传和生成都只提出动作，等待本地人工确认。
5. 用户未给出的高影响创意参数写入 assumptions；普通采样参数选择保守稳定值。
6. 回复及 JSON 字符串使用中文，提示词内容按所选模型的最佳语言填写。
7. plugin 意图只能选择已配置工具。只读工具可自动调用；停止实例等 side_effect 工具必须等待本地确认。
8. extension_install 只能选择 GitHub 扩展目录中存在的 extension_id；不得自己编造仓库、网址或校验值。

当前环境摘要：${JSON.stringify(summary)}
可用节点目录：${JSON.stringify(catalog)}
可用插件工具：${JSON.stringify(tools)}
GitHub 可安装扩展目录：${JSON.stringify(availableExtensions)}
本次自动启用的 Skills：\n${skillText || "（无匹配 Skill）"}`;
}

function normalizeMessages(history, userMessage) {
  return [
    ...history.slice(-6).map((item) => ({ role: item.role, content: String(item.content).slice(0, 4000) })),
    { role: "user", content: `${userMessage}\n请严格返回 JSON。` },
  ];
}

export function studioPromptContract(stage) {
  if (["prompt_engineering", "product_prompts"].includes(stage.id)) {
    return `提示词阶段强制结构：data.shots 必须是非空数组。每个镜头必须包含 shot_id、image_prompt 和 video_prompt。image_prompt 包含 positive、negative、compiled；video_prompt 包含 positive、motion、camera、lighting_material、continuity、negative、compiled。compiled 是可直接交给对应生成模型的最终提示词。`;
  }
  if (["video_generation", "product_video"].includes(stage.id)) {
    return `视频任务强制结构：execution.jobs 必须是非空数组。每个任务必须包含 id、shot_id、source_image_ref、duration_seconds、fps 和 video_prompt。video_prompt 必须包含 positive、motion、camera、lighting_material、continuity、negative、compiled；compiled 要合并主体动作、环境运动、运镜、灯光材质和连续性约束，不能只写风格词。`;
  }
  if (["voice_synthesis", "product_voice"].includes(stage.id)) {
    return `配音任务强制结构：execution.jobs 必须是非空数组。每个任务必须包含 id、line_id、shot_id、character_id、text、target_duration_seconds 和 voice_prompt。voice_prompt 必须包含 voice_profile、emotion、intensity、pace、pauses、pronunciation、restrictions、compiled_instruction；不得使用真人姓名或要求模仿未授权真人声音。`;
  }
  return "";
}

export class LlmClient {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  get configured() {
    return Boolean(this.config.baseUrl && this.config.model);
  }

  async requestOpenAi(system, messages, jsonMode = this.config.jsonMode) {
    const headers = { "Content-Type": "application/json" };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    const body = { model: this.config.model, messages: [{ role: "system", content: system }, ...messages], temperature: 0.2, max_tokens: 8000 };
    if (jsonMode) body.response_format = { type: "json_object" };
    const response = await this.fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
    });
    if (!response.ok && jsonMode && response.status === 400) return this.requestOpenAi(system, messages, false);
    if (!response.ok) {
      let detail = "";
      try {
        const payload = await response.json();
        detail = String(payload?.error?.message || payload?.message || "").slice(0, 400);
      } catch { /* response body is optional */ }
      throw new Error(`大模型 API 请求失败 (${response.status})${detail ? `：${detail}` : ""}`);
    }
    const payload = await response.json();
    return payload?.choices?.[0]?.message?.content;
  }

  async requestAnthropic(system, messages) {
    if (!this.config.apiKey) throw new Error("Anthropic 接口需要 LLM_API_KEY");
    const response = await this.fetch(`${this.config.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": this.config.apiKey, "anthropic-version": this.config.anthropicVersion },
      body: JSON.stringify({ model: this.config.model, system, messages, max_tokens: 8000, temperature: 0.2 }),
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) throw new Error(`Anthropic API 请求失败 (${response.status})`);
    const payload = await response.json();
    return payload?.content?.find((item) => item.type === "text")?.text;
  }

  async requestGemini(system, messages) {
    if (!this.config.apiKey) throw new Error("Gemini 接口需要 LLM_API_KEY");
    const contents = messages.map((item) => ({ role: item.role === "assistant" ? "model" : "user", parts: [{ text: item.content }] }));
    const response = await this.fetch(`${this.config.baseUrl}/v1beta/models/${encodeURIComponent(this.config.model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.config.apiKey },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature: 0.2, maxOutputTokens: 8000 } }),
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) throw new Error(`Gemini API 请求失败 (${response.status})`);
    const payload = await response.json();
    return payload?.candidates?.[0]?.content?.parts?.map((item) => item.text || "").join("");
  }

  async generate(system, messages) {
    if (this.config.provider === "anthropic") return this.requestAnthropic(system, messages);
    if (this.config.provider === "gemini") return this.requestGemini(system, messages);
    if (this.config.provider === "openai-compatible") return this.requestOpenAi(system, messages);
    throw new Error(`不支持的 LLM_PROVIDER: ${this.config.provider}`);
  }

  async generateJson(system, userContent) {
    const messages = [{ role: "user", content: `${userContent}\n只返回一个完整、非空、合法的 JSON 对象。` }];
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { return parseJsonContent(await this.generate(system, messages)); }
      catch (error) {
        lastError = error;
        if (/API 请求失败|需要 LLM_API_KEY|不支持/.test(error.message)) throw error;
        messages.push({ role: "user", content: "上次返回无法解析。不要使用 Markdown，只返回 JSON。" });
      }
    }
    throw lastError || new Error("大模型未返回有效 JSON");
  }

  async summarizeStudioChunk({ chunk, index, total, projectType }) {
    if (!this.configured) throw new Error("请先配置大模型接口");
    const system = `你是 Ropiq 的长文本解析器。你正在处理${projectType === "drama" ? "小说/故事" : "商品资料"}的第 ${index + 1}/${total} 段。忠于原文，不补写未出现的事实。

输出 JSON：
{
  "segment": ${index + 1},
  "summary": "本段摘要",
  "characters_or_entities": [{"name":"", "facts":[], "changes":[]}],
  "events_or_claims": [{"order":1, "description":"", "evidence":""}],
  "locations_or_context": [],
  "conflicts_or_selling_points": [],
  "clues_or_constraints": [],
  "uncertainties": []
}`;
    return this.generateJson(system, chunk);
  }

  async produceStudioArtifact({ project, stage, previousContext = "", sourceReports = [], capabilities = {} }) {
    if (!this.configured) throw new Error("请先配置大模型接口");
    const executionRule = stage.executor === "llm"
      ? "本阶段只生成结构化创作产物。"
      : `本阶段执行器为 ${stage.executor}。只生成可验证的执行任务规格；不得声称已经生成媒体。执行器未就绪时，将 execution.ready 设为 false 并列出 missing。`;
    const system = `你是 Ropiq 的 AI 影视制作智能体，当前负责“${stage.name}”。

阶段目标：${stage.instruction}
${executionRule}
${studioPromptContract(stage)}

必须输出：
{
  "summary": "本阶段成果摘要",
  "data": {"结构化阶段产物": "内容"},
  "decisions": [{"item":"", "choice":"", "reason":""}],
  "continuity": [{"anchor":"", "must_keep":""}],
  "risks": [{"level":"low|medium|high", "issue":"", "mitigation":""}],
  "execution": {
    "executor": "${stage.executor}",
    "ready": ${stage.executor === "llm" ? "true" : "false"},
    "missing": [],
    "jobs": [{"id":"", "purpose":"", "inputs":{}, "expected_outputs":[], "estimated_cost_cny":0}]
  }
}

规则：
1. 使用中文，镜头、角色、场景和资产必须有稳定 ID。
2. 遵守项目预算和先预览后高质量生成策略。
3. 不得编造后端未安装的模型、节点、声音或插件。
4. 不得使用未经授权的小说、品牌、人物肖像、真人声音、音乐或模型。
5. 生成内容必须保留 AI 标识和来源记录要求。
6. 信息不足时写入 risks 和 decisions，不要偷偷假设高影响内容。

当前执行能力：${JSON.stringify(capabilities)}`;
    const projectSummary = {
      id: project.id,
      type: project.type,
      title: project.title,
      settings: project.settings,
      source_filename: project.source.filename,
      source_length: project.source.text.length,
    };
    const user = `项目：${JSON.stringify(projectSummary)}

长文本分段报告：${JSON.stringify(sourceReports).slice(0, 50000)}

最近上游阶段：${previousContext || "（无）"}

请完成“${stage.name}”并返回阶段产物。`;
    return this.generateJson(system, user);
  }

  async plan({ message, history = [], catalog, summary, skills = [], tools = [], availableExtensions = [] }) {
    if (!this.configured) throw new Error("请配置 LLM_BASE_URL 和 LLM_MODEL");
    const system = systemPrompt(catalog, summary, skills, tools, availableExtensions);
    const messages = normalizeMessages(history, message);
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return parseJsonContent(await this.generate(system, messages));
      } catch (error) {
        lastError = error;
        if (/API 请求失败|需要 LLM_API_KEY|不支持/.test(error.message)) throw error;
        messages.push({ role: "user", content: "上次返回无法解析。只返回一个完整、非空、合法的 JSON 对象。" });
      }
    }
    throw lastError || new Error("大模型未返回可用计划");
  }
}

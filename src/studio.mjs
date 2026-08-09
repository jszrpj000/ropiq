import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const dramaStages = [
  ["novel_analysis", "小说解析", "llm", "解析人物、时间线、地点、冲突、伏笔、关系和章节事件。忠于原文，区分事实与推断。"],
  ["story_adaptation", "剧情改编", "llm", "将原作改编为适合短剧的主线，确定受众、类型、核心卖点、叙事视角、删改合并和版权风险。"],
  ["episodic_scripts", "分集剧本", "llm", "按目标集数和单集时长生成分集结构、场次、动作、对白、钩子和连续性要求。"],
  ["character_design", "人物设定", "llm", "建立人物圣经：身份、性格、动机、关系、外观锚点、服装层级、声音方向和不可漂移特征。"],
  ["scene_design", "场景设定", "llm", "建立场景圣经：空间布局、时代地域、道具、天气、昼夜、色彩、可复用背景和连续性锚点。"],
  ["storyboard", "分镜", "llm", "把剧本拆成可生产镜头，给出镜头编号、时长、画面、动作、对白、情绪、转场和所需资产。"],
  ["cinematography", "景别/机位/运镜", "llm", "为每个镜头指定景别、焦段、机位高度、构图、视线、运镜、运动幅度、速度和稳定性。"],
  ["look_development", "灯光材质", "llm", "确定灯光方向、光比、色温、材质纹理、环境效果、色彩管理和跨镜头视觉一致性。"],
  ["prompt_engineering", "提示词", "llm", "为每个镜头生成正向、负向、参考资产、约束、种子策略和模型适配提示，不得编造未安装资源。"],
  ["image_generation", "图像生成", "comfyui", "生成关键帧和角色/场景参考图任务规格；优先低成本预览，再安排确认后的高质量任务。"],
  ["video_generation", "视频生成", "comfyui", "生成逐镜头视频任务规格，包含首尾帧、时长、帧率、动作幅度、一致性策略和失败降级方案。"],
  ["voice_synthesis", "配音", "plugin:tts", "生成角色声线、情绪、语速、停连、发音词典和逐句配音任务；不得冒用未经授权的真人声音。"],
  ["lip_sync", "口型", "plugin:lipsync", "生成逐镜头口型任务，绑定音频、人物、说话区间、脸部可见度、修复策略和质量阈值。"],
  ["audio_caption", "字幕/音效/音乐", "plugin:audio", "生成字幕时间轴、环境声、动作音效、音乐段落、响度和版权来源要求。"],
  ["editing", "剪辑", "plugin:editor", "生成剪辑时间线，安排镜头、音轨、字幕、转场、节奏、调色、画幅安全区和平台版本。"],
  ["quality_control", "质检", "llm", "检查剧情连续性、角色漂移、闪烁、口型、字幕、声音、版权、AI标识和技术指标，形成局部返工清单。"],
  ["final_master", "成片", "plugin:editor", "生成最终交付任务规格、版本清单、封面、元数据、AI生成标识、校验值和归档清单。"],
];

const productStages = [
  ["product_analysis", "商品解析", "llm", "提取商品类别、受众、卖点、证据、限制、品牌规范、合规风险和可用素材。"],
  ["marketing_strategy", "宣传策略", "llm", "确定平台、目标、核心承诺、前三秒钩子、行动号召、禁止表达和多版本策略。"],
  ["ad_script", "广告脚本", "llm", "生成旁白、画面、字幕和节奏对应的广告脚本，不得编造商品功效或认证。"],
  ["product_storyboard", "广告分镜", "llm", "拆分商品镜头、卖点镜头、使用场景、细节特写、品牌收尾和所需素材。"],
  ["product_cinematography", "景别/机位/运镜", "llm", "为每个商品镜头设置景别、镜头、机位、转台、推拉摇移、速度和稳定性。"],
  ["product_lookdev", "灯光材质", "llm", "确定棚拍灯光、商品材质、反射控制、背景、色彩和品牌视觉一致性。"],
  ["product_prompts", "提示词", "llm", "生成保持商品结构、包装文字和品牌颜色的提示词、约束和参考图策略。"],
  ["product_images", "商品图像", "comfyui", "生成商品增强、场景合成、关键帧和多画幅任务规格，优先保护包装与结构。"],
  ["product_video", "商品视频", "comfyui", "生成商品运镜、细节动画和场景视频任务规格，禁止改变产品真实属性。"],
  ["product_voice", "旁白配音", "plugin:tts", "生成旁白声线、语速、重音、发音和逐句任务规格。"],
  ["product_audio_caption", "字幕/音效/音乐", "plugin:audio", "生成卖点字幕、价格占位、音效、音乐、响度和版权来源要求。"],
  ["product_editing", "剪辑", "plugin:editor", "生成多平台剪辑时间线、品牌片尾、行动号召、横竖屏安全区和导出版本。"],
  ["product_qc", "广告质检", "llm", "检查商品真实性、包装文字、宣传合规、品牌一致性、字幕、声音和技术质量。"],
  ["product_delivery", "成片", "plugin:editor", "生成平台成片、封面、标题建议、AI标识、校验值和素材归档任务。"],
];

function makeStages(definitions) {
  return definitions.map(([id, name, executor, instruction], index) => ({
    id, name, executor, instruction, order: index + 1, status: "pending", revision: 0, updatedAt: null, summary: "",
  }));
}

export const STUDIO_PIPELINES = {
  drama: { id: "drama", name: "AI短剧", stages: dramaStages },
  product: { id: "product", name: "商品宣传视频", stages: productStages },
};

export function splitLongText(text, maxChars = 14000, maxChunks = 32) {
  const paragraphs = String(text || "").split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const pieces = paragraph.length > maxChars ? paragraph.match(new RegExp(`.{1,${maxChars}}`, "gs")) : [paragraph];
    for (const piece of pieces) {
      if (current && current.length + piece.length + 2 > maxChars) { chunks.push(current); current = ""; }
      current += `${current ? "\n\n" : ""}${piece}`;
      if (chunks.length >= maxChunks) break;
    }
    if (chunks.length >= maxChunks) break;
  }
  if (current && chunks.length < maxChunks) chunks.push(current);
  return chunks;
}

function safeProjectId(id) {
  if (!/^[a-f0-9-]{36}$/.test(String(id || ""))) throw new Error("项目 ID 无效");
  return id;
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }

export class StudioStore {
  constructor(dataRoot) {
    this.root = path.join(dataRoot, "studio-projects");
    fs.mkdirSync(this.root, { recursive: true });
  }

  directory(id) { return path.join(this.root, safeProjectId(id)); }
  projectFile(id) { return path.join(this.directory(id), "project.json"); }
  artifactFile(id, stageId) { return path.join(this.directory(id), "artifacts", `${stageId}.json`); }

  list() {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
      try {
        const project = readJson(path.join(this.root, entry.name, "project.json"));
        return [{ id: project.id, type: project.type, title: project.title, updatedAt: project.updatedAt, progress: this.progress(project) }];
      } catch { return []; }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  create(input) {
    const type = String(input.type || "");
    const pipeline = STUDIO_PIPELINES[type];
    if (!pipeline) throw new Error("项目类型无效");
    const sourceText = String(input.sourceText || "").trim();
    if (!sourceText) throw new Error(type === "drama" ? "请导入小说或粘贴故事" : "请填写商品信息和宣传需求");
    if (sourceText.length > 400000) throw new Error("首版单项目文本上限为 40 万字符，请拆分后导入");
    const now = new Date().toISOString();
    const project = {
      schemaVersion: 1,
      id: randomUUID(),
      type,
      title: String(input.title || "").trim() || (type === "drama" ? "未命名短剧" : "未命名商品视频"),
      createdAt: now,
      updatedAt: now,
      source: { filename: String(input.filename || "").slice(0, 180), text: sourceText },
      settings: {
        episodes: Math.max(1, Math.min(100, Number(input.settings?.episodes || 1))),
        episodeSeconds: Math.max(10, Math.min(1800, Number(input.settings?.episodeSeconds || 90))),
        aspectRatio: String(input.settings?.aspectRatio || "9:16"),
        style: String(input.settings?.style || "写实电影感").slice(0, 200),
        budgetCny: Math.max(0, Number(input.settings?.budgetCny || 0)),
        previewFirst: input.settings?.previewFirst !== false,
      },
      stages: makeStages(pipeline.stages),
    };
    const directory = this.directory(project.id);
    fs.mkdirSync(path.join(directory, "artifacts"), { recursive: true });
    this.writeProject(project);
    return this.withArtifacts(project);
  }

  get(id) {
    const file = this.projectFile(id);
    if (!fs.existsSync(file)) throw new Error("制作项目不存在");
    return this.withArtifacts(readJson(file));
  }

  writeProject(project) {
    project.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.projectFile(project.id), `${JSON.stringify(project, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  withArtifacts(project) {
    const artifacts = {};
    for (const stage of project.stages) {
      const file = this.artifactFile(project.id, stage.id);
      if (fs.existsSync(file)) artifacts[stage.id] = readJson(file);
    }
    return { ...project, progress: this.progress(project), artifacts };
  }

  progress(project) {
    const done = project.stages.filter((stage) => ["complete", "specified"].includes(stage.status)).length;
    return { done, total: project.stages.length, percent: Math.round((done / project.stages.length) * 100) };
  }

  saveArtifact(id, stageId, artifact, status = "complete") {
    const project = this.get(id);
    const index = project.stages.findIndex((stage) => stage.id === stageId);
    if (index < 0) throw new Error("制作阶段不存在");
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) throw new Error("阶段产物必须是 JSON 对象");
    const serialized = JSON.stringify(artifact, null, 2);
    if (serialized.length > 2 * 1024 * 1024) throw new Error("阶段产物超过 2 MB");
    fs.writeFileSync(this.artifactFile(id, stageId), `${serialized}\n`, { encoding: "utf8", mode: 0o600 });
    const now = new Date().toISOString();
    project.stages[index] = { ...project.stages[index], status, revision: project.stages[index].revision + 1, updatedAt: now, summary: String(artifact.summary || "").slice(0, 500) };
    for (let cursor = index + 1; cursor < project.stages.length; cursor += 1) {
      if (["complete", "specified"].includes(project.stages[cursor].status)) project.stages[cursor].status = "stale";
    }
    delete project.artifacts;
    delete project.progress;
    this.writeProject(project);
    return this.get(id);
  }

  recordExecutionRun(id, stageId, run, status = "running") {
    if (!run?.promptId) throw new Error("执行记录缺少任务 ID");
    const project = this.get(id);
    const artifact = project.artifacts?.[stageId];
    if (!artifact) throw new Error("请先生成并保存阶段产物");
    if (!artifact.execution || typeof artifact.execution !== "object") artifact.execution = {};
    const runs = Array.isArray(artifact.execution.runs) ? artifact.execution.runs : [];
    const index = runs.findIndex((item) => item.promptId === run.promptId);
    const next = { ...(index >= 0 ? runs[index] : {}), ...run, updatedAt: new Date().toISOString() };
    if (index >= 0) runs[index] = next;
    else runs.push(next);
    artifact.execution.runs = runs.slice(-50);
    return this.saveArtifact(id, stageId, artifact, status);
  }

  markRunning(id, stageId) {
    const project = this.get(id);
    const stage = project.stages.find((item) => item.id === stageId);
    if (!stage) throw new Error("制作阶段不存在");
    stage.status = "running";
    delete project.artifacts;
    delete project.progress;
    this.writeProject(project);
    return stage;
  }

  markError(id, stageId, message) {
    const project = this.get(id);
    const stage = project.stages.find((item) => item.id === stageId);
    if (stage) { stage.status = "error"; stage.summary = String(message || "生成失败").slice(0, 500); }
    delete project.artifacts;
    delete project.progress;
    this.writeProject(project);
  }

  nextStage(id) {
    return this.get(id).stages.find((stage) => ["pending", "stale", "error"].includes(stage.status)) || null;
  }

  stageContext(id, stageId, maxChars = 60000) {
    const project = this.get(id);
    const index = project.stages.findIndex((stage) => stage.id === stageId);
    if (index < 0) throw new Error("制作阶段不存在");
    const context = [];
    let used = 0;
    for (let cursor = Math.max(0, index - 6); cursor < index; cursor += 1) {
      const stage = project.stages[cursor];
      const artifact = project.artifacts[stage.id];
      if (!artifact) continue;
      const text = JSON.stringify({ stage: stage.name, artifact });
      if (used + text.length > maxChars) break;
      context.push(text);
      used += text.length;
    }
    return context.join("\n");
  }
}

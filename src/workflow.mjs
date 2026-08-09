const CORE_TERMS = [
  "load", "loader", "checkpoint", "model", "clip", "text", "encode", "vae",
  "latent", "sampler", "image", "video", "save", "preview", "output",
];

function words(value) {
  return String(value || "").toLowerCase().split(/[^a-z0-9_]+/).filter((word) => word.length > 2);
}

function compactChoices(values, queryWords, limit = 40) {
  if (values.length <= limit) return values;
  const ranked = values.map((value, index) => {
    const text = String(value).toLowerCase();
    let score = 0;
    for (const queryWord of queryWords) {
      if (text.includes(queryWord) || queryWord.includes(text)) score += 100;
    }
    return { value, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  return { choices: ranked.slice(0, limit).map((item) => item.value), total_choices: values.length, truncated: true };
}

function compactInputMap(inputs = {}, queryWords = new Set()) {
  const result = {};
  for (const [name, spec] of Object.entries(inputs)) {
    const typeOrChoices = Array.isArray(spec) ? spec[0] : spec;
    result[name] = Array.isArray(typeOrChoices) ? compactChoices(typeOrChoices, queryWords) : typeOrChoices;
  }
  return result;
}

export function buildNodeCatalog(objectInfo, query, limit = 100, maxChars = 120000) {
  const queryWords = new Set(words(query));
  const ranked = Object.entries(objectInfo || {})
    .map(([classType, definition]) => {
      const haystack = words(`${classType} ${definition.display_name || ""} ${definition.category || ""}`);
      let score = definition.output_node ? 30 : 0;
      for (const token of haystack) {
        for (const queryWord of queryWords) {
          if (token.includes(queryWord) || queryWord.includes(token)) score += 50;
        }
        if (CORE_TERMS.some((term) => token.includes(term))) score += 2;
      }
      return {
        class_type: classType,
        category: definition.category || "",
        required: compactInputMap(definition.input?.required, queryWords),
        optional: compactInputMap(definition.input?.optional, queryWords),
        outputs: definition.output || [],
        output_node: Boolean(definition.output_node),
        score,
      };
    })
    .sort((a, b) => b.score - a.score || a.class_type.localeCompare(b.class_type));
  const selected = [];
  let usedChars = 2;
  for (const node of ranked) {
    if (selected.length >= limit) break;
    const nodeChars = JSON.stringify(node).length + 1;
    if (selected.length > 0 && usedChars + nodeChars > maxChars) continue;
    selected.push(node);
    usedChars += nodeChars;
  }
  return selected;
}

function isLink(value, workflow) {
  return Array.isArray(value) && value.length === 2 && Object.hasOwn(workflow, String(value[0])) && Number.isInteger(value[1]);
}

function addPrimitiveErrors(value, spec, label, errors) {
  if (!Array.isArray(spec)) return;
  const typeOrChoices = spec[0];
  const options = spec[1] || {};
  if (Array.isArray(typeOrChoices) && !typeOrChoices.includes(value)) {
    errors.push(`${label} 使用了当前环境未列出的值: ${value}`);
  } else if (typeOrChoices === "INT" && !Number.isInteger(value)) {
    errors.push(`${label} 必须是整数`);
  } else if (typeOrChoices === "FLOAT" && typeof value !== "number") {
    errors.push(`${label} 必须是数字`);
  } else if (typeOrChoices === "STRING" && typeof value !== "string") {
    errors.push(`${label} 必须是字符串`);
  } else if (typeOrChoices === "BOOLEAN" && typeof value !== "boolean") {
    errors.push(`${label} 必须是布尔值`);
  }
  if (typeof value === "number") {
    if (typeof options.min === "number" && value < options.min) errors.push(`${label} 小于最小值 ${options.min}`);
    if (typeof options.max === "number" && value > options.max) errors.push(`${label} 大于最大值 ${options.max}`);
  }
}

function validateLink(value, workflow, objectInfo, spec, label, errors) {
  const [sourceId, outputIndex] = value;
  const sourceDefinition = objectInfo?.[workflow[String(sourceId)]?.class_type];
  if (!sourceDefinition || outputIndex < 0 || outputIndex >= (sourceDefinition.output || []).length) {
    errors.push(`${label} 引用了无效输出 ${sourceId}:${outputIndex}`);
    return;
  }
  const expectedType = Array.isArray(spec) ? spec[0] : null;
  const actualType = sourceDefinition.output?.[outputIndex];
  if (typeof expectedType === "string" && typeof actualType === "string" && expectedType !== "*" && actualType !== "*" && expectedType !== actualType) {
    errors.push(`${label} 需要 ${expectedType}，但连线输出为 ${actualType}`);
  }
}

function totalVramGb(systemStats) {
  const devices = systemStats?.devices || systemStats?.system?.devices || [];
  const bytes = Number(devices[0]?.vram_total || devices[0]?.vramTotal || 0);
  return bytes > 0 ? bytes / 1024 ** 3 : null;
}

export function validateWorkflow(workflow, objectInfo, systemStats = {}) {
  const errors = [];
  const warnings = [];
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow) || Object.keys(workflow).length === 0) {
    return { valid: false, score: 0, errors: ["工作流为空或格式错误"], warnings };
  }

  let outputNodes = 0;
  let maxPixels = 0;
  let maxFrames = 0;
  let maxBatch = 1;
  let maxSteps = 0;

  for (const [nodeId, node] of Object.entries(workflow)) {
    const definition = objectInfo?.[node?.class_type];
    if (!node || typeof node !== "object" || !node.class_type || !node.inputs || typeof node.inputs !== "object") {
      errors.push(`节点 ${nodeId} 缺少 class_type 或 inputs`);
      continue;
    }
    if (!definition) {
      errors.push(`节点 ${nodeId} 的类型 ${node.class_type} 未安装`);
      continue;
    }
    if (definition.output_node) outputNodes += 1;

    const required = definition.input?.required || {};
    for (const [inputName, spec] of Object.entries(required)) {
      if (!Object.hasOwn(node.inputs, inputName)) {
        errors.push(`节点 ${nodeId} 缺少必填输入 ${inputName}`);
        continue;
      }
      const value = node.inputs[inputName];
      if (isLink(value, workflow)) {
        validateLink(value, workflow, objectInfo, spec, `节点 ${nodeId}.${inputName}`, errors);
      } else {
        addPrimitiveErrors(value, spec, `${nodeId}.${inputName}`, errors);
      }
    }

    for (const [inputName, value] of Object.entries(node.inputs)) {
      const spec = definition.input?.optional?.[inputName];
      if (!spec) continue;
      if (isLink(value, workflow)) validateLink(value, workflow, objectInfo, spec, `节点 ${nodeId}.${inputName}`, errors);
      else addPrimitiveErrors(value, spec, `${nodeId}.${inputName}`, errors);
    }

    const width = Number(node.inputs.width || 0);
    const height = Number(node.inputs.height || 0);
    if (width > 0 && height > 0) maxPixels = Math.max(maxPixels, width * height);
    maxFrames = Math.max(maxFrames, Number(node.inputs.length || node.inputs.frames || 0));
    maxBatch = Math.max(maxBatch, Number(node.inputs.batch_size || 1));
    maxSteps = Math.max(maxSteps, Number(node.inputs.steps || 0));

    for (const key of ["image", "filename_prefix"]) {
      const value = node.inputs[key];
      if (typeof value === "string" && (value.includes("..") || /^[A-Za-z]:|^[/\\]/.test(value))) {
        errors.push(`节点 ${nodeId}.${key} 包含不安全路径`);
      }
    }
  }

  if (outputNodes === 0) errors.push("工作流没有已声明的输出节点");
  const vramGb = totalVramGb(systemStats);
  if (vramGb && vramGb < 12 && maxPixels > 1024 * 1024) warnings.push("当前显存低于 12GB，超过百万像素的生成可能失败");
  if (vramGb && vramGb < 16 && maxFrames > 100) warnings.push("当前显存与长视频帧数的组合风险较高");
  if (maxBatch > 1 && maxFrames > 0) warnings.push("视频批量大于 1，显存峰值较高");
  if (maxSteps > 50) warnings.push("采样步数超过 50，耗时增加但质量收益通常有限");

  const score = Math.max(0, Math.min(100, 100 - errors.length * 25 - warnings.length * 3));
  return { valid: errors.length === 0, score, errors, warnings, metrics: { outputNodes, maxPixels, maxFrames, maxBatch, maxSteps, vramGb } };
}

const externalGenerationNode = /(fluxkontextpro|replicate|falai|stabilityapi|openaiimage|dall.?e|gemini.*image|imagen\d*|kling|runway|hailuo|minimax.*video|vidu|luma.*(?:image|video)|veo\d*|jimeng|siliconflow|cloud.*(?:image|video)|api.*(?:image|video)|(?:image|video).*api)/i;
const localLoaderNode = /(?:checkpoint|unet|diffusion|clip|vae|lora|controlnet|gguf).*(?:loader|load)|(?:loader|load).*(?:checkpoint|unet|diffusion|clip|vae|lora|controlnet|gguf)/i;
const localModelFile = /\.(?:safetensors|ckpt|gguf|pt|pth|bin)$/i;

export function validateSelfHostedWorkflow(workflow) {
  const errors = [];
  const nodes = Object.values(workflow || {});
  const external = nodes.find((node) => externalGenerationNode.test(String(node?.class_type || ""))
    || Object.keys(node?.inputs || {}).some((name) => /api_?key|access_?key|secret_?key|bearer_?token|api_?token/i.test(name)));
  if (external) errors.push(`禁止使用外部付费/API 生成节点：${external.class_type}`);

  const hasLocalModel = nodes.some((node) => localLoaderNode.test(String(node?.class_type || ""))
    || Object.values(node?.inputs || {}).some((value) => typeof value === "string" && localModelFile.test(value)));
  if (!hasLocalModel) errors.push("工作流没有本地模型加载器或本地模型文件，无法证明使用的是用户自己的 ComfyUI 算力");

  const hasSampler = nodes.some((node) => /sampler|sampling/i.test(String(node?.class_type || "")));
  if (!hasSampler) errors.push("工作流没有本地采样节点");
  return { valid: errors.length === 0, errors };
}

function enumChoices(objectInfo, classType, inputName) {
  const spec = objectInfo?.[classType]?.input?.required?.[inputName] || objectInfo?.[classType]?.input?.optional?.[inputName];
  return Array.isArray(spec?.[0]) ? spec[0] : [];
}

function pickChoice(values, patterns) {
  return patterns.flatMap((pattern) => values.filter((value) => pattern.test(String(value))))[0] || "";
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(number) ? number : fallback));
}

export const STUDIO_SOURCE_IMAGE_PLACEHOLDER = "__ROPIQ_SOURCE_IMAGE_AFTER_CONFIRMATION__";

export function buildTrustedImageCandidate(objectInfo, artifact, outputPrefix) {
  const requiredNodes = ["UNETLoader", "ModelSamplingAuraFlow", "CLIPLoader", "CLIPTextEncode", "EmptySD3LatentImage", "KSampler", "VAELoader", "VAEDecode", "SaveImage"];
  if (!requiredNodes.every((classType) => objectInfo?.[classType])) return null;

  const unet = pickChoice(enumChoices(objectInfo, "UNETLoader", "unet_name"), [/^z_image_turbo_bf16\.safetensors$/i, /z[_ -]?image.*turbo.*\.safetensors$/i]);
  const clip = pickChoice(enumChoices(objectInfo, "CLIPLoader", "clip_name"), [/^qwen_3_4b\.safetensors$/i, /qwen.*3.*4b.*\.safetensors$/i]);
  const vae = pickChoice(enumChoices(objectInfo, "VAELoader", "vae_name"), [/^ae\.safetensors$/i, /z[_ -]?image.*vae.*\.safetensors$/i]);
  const clipType = pickChoice(enumChoices(objectInfo, "CLIPLoader", "type"), [/^lumina2$/i]);
  const sampler = pickChoice(enumChoices(objectInfo, "KSampler", "sampler_name"), [/^res_multistep$/i]);
  const scheduler = pickChoice(enumChoices(objectInfo, "KSampler", "scheduler"), [/^simple$/i]);
  if (![unet, clip, vae, clipType, sampler, scheduler].every(Boolean)) return null;

  const job = artifact?.execution?.jobs?.[0] || artifact || {};
  const width = Math.round(boundedNumber(job.width, 768, 256, 2048) / 64) * 64;
  const height = Math.round(boundedNumber(job.height, 768, 256, 2048) / 64) * 64;
  const positive = String(job.positivePrompt || job.positive_prompt || job.prompt || artifact?.summary || "original cinematic scene").slice(0, 10000);
  const negative = String(job.negativePrompt || job.negative_prompt || "text, logo, watermark, low quality").slice(0, 10000);
  const workflow = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: unet, weight_dtype: pickChoice(enumChoices(objectInfo, "UNETLoader", "weight_dtype"), [/^default$/i]) || "default" } },
    "2": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3 } },
    "3": { class_type: "CLIPLoader", inputs: { clip_name: clip, type: clipType, device: pickChoice(enumChoices(objectInfo, "CLIPLoader", "device"), [/^default$/i]) || "default" } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: positive, clip: ["3", 0] } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: negative, clip: ["3", 0] } },
    "6": { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } },
    "7": { class_type: "KSampler", inputs: { model: ["2", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0], seed: Math.round(boundedNumber(job.seed, 42, 0, Number.MAX_SAFE_INTEGER)), control_after_generate: "fixed", steps: Math.round(boundedNumber(job.steps, 8, 1, 30)), cfg: boundedNumber(job.cfg, 1, 0, 30), sampler_name: sampler, scheduler, denoise: 1 } },
    "8": { class_type: "VAELoader", inputs: { vae_name: vae } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["8", 0] } },
    "10": { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: outputPrefix } },
  };
  return { title: "Z-Image Turbo 本地低成本预览", rationale: "使用当前 ComfyUI 已安装的本地模型、编码器、VAE 和采样器，不调用外部生成 API。", workflow };
}

export function buildTrustedVideoCandidate(objectInfo, artifact, outputPrefix) {
  const requiredNodes = ["UNETLoader", "ModelSamplingSD3", "CLIPLoader", "CLIPTextEncode", "VAELoader", "CLIPVisionLoader", "CLIPVisionEncode", "LoadImage", "WanImageToVideo", "KSampler", "VAEDecode", "SaveWEBM"];
  if (!requiredNodes.every((classType) => objectInfo?.[classType])) return null;

  const unet = pickChoice(enumChoices(objectInfo, "UNETLoader", "unet_name"), [
    /wan2\.1_i2v_480p_14b_fp8_scaled\.safetensors$/i,
    /wan2\.1_i2v_480p_14b_fp8.*\.safetensors$/i,
    /wan2\.1_i2v_480p_14b_(?:bf16|fp16)\.safetensors$/i,
  ]);
  const clip = pickChoice(enumChoices(objectInfo, "CLIPLoader", "clip_name"), [/umt5_xxl_fp8_e4m3fn_scaled\.safetensors$/i, /umt5.*\.safetensors$/i]);
  const clipType = pickChoice(enumChoices(objectInfo, "CLIPLoader", "type"), [/^wan$/i]);
  const vae = pickChoice(enumChoices(objectInfo, "VAELoader", "vae_name"), [/wan_2\.1_vae\.safetensors$/i, /wan2_1_vae.*\.safetensors$/i]);
  const clipVision = pickChoice(enumChoices(objectInfo, "CLIPVisionLoader", "clip_name"), [/clip_vision_h\.safetensors$/i, /clip.*vision.*\.safetensors$/i]);
  const sampler = pickChoice(enumChoices(objectInfo, "KSampler", "sampler_name"), [/^uni_pc$/i, /^euler$/i]);
  const scheduler = pickChoice(enumChoices(objectInfo, "KSampler", "scheduler"), [/^simple$/i]);
  if (![unet, clip, clipType, vae, clipVision, sampler, scheduler].every(Boolean)) return null;

  const job = artifact?.execution?.jobs?.[0] || artifact || {};
  const videoPrompt = job.video_prompt || {};
  const positive = String(videoPrompt.compiled || videoPrompt.positive || job.positivePrompt || artifact?.summary || "cinematic natural motion").slice(0, 10000);
  const negative = String(videoPrompt.negative || job.negativePrompt || "static frame, flicker, jitter, deformation, text, logo, watermark, low quality").slice(0, 10000);
  const fps = Math.round(boundedNumber(job.fps, 16, 8, 30));
  const requestedFrames = Math.round(boundedNumber(job.duration_seconds, 4, 1, 8) * fps);
  const length = Math.min(81, Math.max(17, Math.floor(requestedFrames / 4) * 4 + 1));
  const width = Math.round(boundedNumber(job.width, 512, 256, 1280) / 16) * 16;
  const height = Math.round(boundedNumber(job.height, 512, 256, 1280) / 16) * 16;
  const crop = pickChoice(enumChoices(objectInfo, "CLIPVisionEncode", "crop"), [/^none$/i, /^center$/i]) || "none";
  const workflow = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: unet, weight_dtype: pickChoice(enumChoices(objectInfo, "UNETLoader", "weight_dtype"), [/^default$/i]) || "default" } },
    "2": { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: 8 } },
    "3": { class_type: "CLIPLoader", inputs: { clip_name: clip, type: clipType, device: pickChoice(enumChoices(objectInfo, "CLIPLoader", "device"), [/^default$/i]) || "default" } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: positive, clip: ["3", 0] } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: negative, clip: ["3", 0] } },
    "6": { class_type: "VAELoader", inputs: { vae_name: vae } },
    "7": { class_type: "LoadImage", inputs: { image: STUDIO_SOURCE_IMAGE_PLACEHOLDER } },
    "8": { class_type: "CLIPVisionLoader", inputs: { clip_name: clipVision } },
    "9": { class_type: "CLIPVisionEncode", inputs: { clip_vision: ["8", 0], image: ["7", 0], crop } },
    "10": { class_type: "WanImageToVideo", inputs: { positive: ["4", 0], negative: ["5", 0], vae: ["6", 0], width, height, length, batch_size: 1, clip_vision_output: ["9", 0], start_image: ["7", 0] } },
    "11": { class_type: "KSampler", inputs: { model: ["2", 0], positive: ["10", 0], negative: ["10", 1], latent_image: ["10", 2], seed: Math.round(boundedNumber(job.seed, 42, 0, Number.MAX_SAFE_INTEGER)), control_after_generate: "fixed", steps: Math.round(boundedNumber(job.steps, 20, 1, 40)), cfg: boundedNumber(job.cfg, 6, 0, 30), sampler_name: sampler, scheduler, denoise: 1 } },
    "12": { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["6", 0] } },
    "13": { class_type: "SaveWEBM", inputs: { images: ["12", 0], filename_prefix: outputPrefix, codec: "vp9", fps, crf: 28 } },
  };
  return {
    title: "Wan 2.1 本地图生视频预览",
    rationale: "使用当前 ComfyUI 已安装的 Wan 本地模型；确认执行后才会把上一阶段关键帧上传为首帧，不调用外部生成 API。",
    workflow,
    sourceImageNodeId: "7",
  };
}

export function rankCandidates(candidates, objectInfo, systemStats) {
  return (Array.isArray(candidates) ? candidates : [])
    .map((candidate, index) => ({
      ...candidate,
      validation: validateWorkflow(candidate.workflow, objectInfo, systemStats),
      originalIndex: index,
    }))
    .sort((a, b) => b.validation.score - a.validation.score || a.originalIndex - b.originalIndex);
}

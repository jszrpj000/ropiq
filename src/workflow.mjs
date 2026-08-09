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

export function rankCandidates(candidates, objectInfo, systemStats) {
  return (Array.isArray(candidates) ? candidates : [])
    .map((candidate, index) => ({
      ...candidate,
      validation: validateWorkflow(candidate.workflow, objectInfo, systemStats),
      originalIndex: index,
    }))
    .sort((a, b) => b.validation.score - a.validation.score || a.originalIndex - b.originalIndex);
}

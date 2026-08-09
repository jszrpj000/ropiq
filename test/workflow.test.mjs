import test from "node:test";
import assert from "node:assert/strict";
import { buildNodeCatalog, buildTrustedImageCandidate, rankCandidates, validateSelfHostedWorkflow, validateWorkflow } from "../src/workflow.mjs";

const objectInfo = {
  LoadImage: {
    input: { required: { image: [["dish.png", "other.png"], {}] } },
    output: ["IMAGE"],
    category: "image",
  },
  ImageScale: {
    input: { required: { image: ["IMAGE", {}], width: ["INT", { min: 64, max: 2048 }], height: ["INT", { min: 64, max: 2048 }] } },
    output: ["IMAGE"],
    category: "image/upscaling",
  },
  SaveImage: {
    input: { required: { images: ["IMAGE", {}], filename_prefix: ["STRING", {}] } },
    output: [],
    output_node: true,
    category: "image",
  },
};

const validWorkflow = {
  "1": { class_type: "LoadImage", inputs: { image: "dish.png" } },
  "2": { class_type: "ImageScale", inputs: { image: ["1", 0], width: 768, height: 1344 } },
  "3": { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: "agent/dish" } },
};

test("validates a graph against installed backend nodes", () => {
  const result = validateWorkflow(validWorkflow, objectInfo, { devices: [{ vram_total: 24 * 1024 ** 3 }] });
  assert.equal(result.valid, true);
  assert.equal(result.score, 100);
});

test("rejects missing nodes, inputs and unsafe paths", () => {
  const workflow = {
    "1": { class_type: "MissingNode", inputs: {} },
    "2": { class_type: "SaveImage", inputs: { filename_prefix: "../escape" } },
  };
  const result = validateWorkflow(workflow, objectInfo);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /未安装/);
  assert.match(result.errors.join(" "), /缺少必填输入 images/);
  assert.match(result.errors.join(" "), /不安全路径/);
});

test("ranks valid candidates above invalid candidates", () => {
  const ranked = rankCandidates([
    { title: "bad", workflow: { "1": { class_type: "Unknown", inputs: {} } } },
    { title: "good", workflow: validWorkflow },
  ], objectInfo, {});
  assert.equal(ranked[0].title, "good");
  assert.equal(ranked[0].validation.valid, true);
});

test("rejects unavailable enum values and mismatched link types", () => {
  const workflow = {
    "1": { class_type: "LoadImage", inputs: { image: "missing.png" } },
    "2": { class_type: "ImageScale", inputs: { image: ["1", 0], width: 768.5, height: 1344 } },
    "3": { class_type: "SaveImage", inputs: { images: ["2", 1], filename_prefix: "agent/dish" } },
  };
  const result = validateWorkflow(workflow, objectInfo);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /未列出的值/);
  assert.match(result.errors.join(" "), /必须是整数/);
  assert.match(result.errors.join(" "), /无效输出/);
});

test("catalog prioritizes relevant and output nodes", () => {
  const catalog = buildNodeCatalog(objectInfo, "scale image", 2);
  assert.equal(catalog[0].class_type, "ImageScale");
  assert.ok(catalog.some((node) => node.output_node));
});

test("catalog compacts huge model enums and keeps query matches", () => {
  const models = Array.from({ length: 9000 }, (_, index) => `model_${String(index).padStart(4, "0")}.safetensors`);
  models[7342] = "z_image_turbo_bf16.safetensors";
  const catalog = buildNodeCatalog({
    UNETLoader: { input: { required: { unet_name: [models, {}], weight_dtype: [["default", "fp8"], {}] } }, output: ["MODEL"], category: "loaders" },
  }, "use z_image_turbo_bf16.safetensors", 100, 120000);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].required.unet_name.truncated, true);
  assert.equal(catalog[0].required.unet_name.total_choices, 9000);
  assert.ok(catalog[0].required.unet_name.choices.includes("z_image_turbo_bf16.safetensors"));
  assert.ok(JSON.stringify(catalog).length < 10000);
});

test("catalog honors the serialized character budget", () => {
  const manyNodes = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`CustomNode${index}`, {
    input: { required: { prompt: ["STRING", {}] } }, output: ["IMAGE"], category: `custom/${"x".repeat(200)}`,
  }]));
  const catalog = buildNodeCatalog(manyNodes, "custom", 100, 2500);
  assert.ok(catalog.length < 100);
  assert.ok(JSON.stringify(catalog).length <= 2600);
});

test("rejects external API generation nodes for Studio execution", () => {
  const result = validateSelfHostedWorkflow({
    "1": { class_type: "FluxKontextProImageNode", inputs: { prompt: "boat" } },
    "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /外部付费\/API/);
  assert.match(result.errors.join(" "), /本地模型加载器/);
});

test("accepts a local loader and sampler chain for Studio execution", () => {
  const result = validateSelfHostedWorkflow({
    "1": { class_type: "UNETLoader", inputs: { unet_name: "z_image_turbo_bf16.safetensors" } },
    "2": { class_type: "KSampler", inputs: { model: ["1", 0] } },
    "3": { class_type: "SaveImage", inputs: { images: ["2", 0] } },
  });
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("builds a trusted Z-Image workflow from installed local model choices", () => {
  const choice = (values) => [values, {}];
  const info = {
    UNETLoader: { input: { required: { unet_name: choice(["svdq-fp4_r128-z-image-turbo.safetensors", "z_image_turbo_bf16.safetensors"]), weight_dtype: choice(["default"]) } } },
    ModelSamplingAuraFlow: { input: { required: {} } },
    CLIPLoader: { input: { required: { clip_name: choice(["qwen3.5_4b_bf16.safetensors", "qwen_3_4b.safetensors"]), type: choice(["lumina2"]), device: choice(["default"]) } } },
    CLIPTextEncode: { input: { required: {} } },
    EmptySD3LatentImage: { input: { required: {} } },
    KSampler: { input: { required: { sampler_name: choice(["res_multistep"]), scheduler: choice(["simple"]) } } },
    VAELoader: { input: { required: { vae_name: choice(["ae.safetensors"]) } } },
    VAEDecode: { input: { required: {} } },
    SaveImage: { input: { required: {} } },
  };
  const candidate = buildTrustedImageCandidate(info, { execution: { jobs: [{ positivePrompt: "orange boat", width: 770, height: 768, steps: 8 }] } }, "RopiqStudio/test");
  assert.equal(candidate.workflow["1"].inputs.unet_name, "z_image_turbo_bf16.safetensors");
  assert.equal(candidate.workflow["3"].inputs.clip_name, "qwen_3_4b.safetensors");
  assert.equal(candidate.workflow["4"].inputs.text, "orange boat");
  assert.equal(candidate.workflow["6"].inputs.width, 768);
  assert.equal(candidate.workflow["10"].inputs.filename_prefix, "RopiqStudio/test");
  assert.equal(validateSelfHostedWorkflow(candidate.workflow).valid, true);
});

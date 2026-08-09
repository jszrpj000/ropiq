import test from "node:test";
import assert from "node:assert/strict";
import { buildNodeCatalog, rankCandidates, validateWorkflow } from "../src/workflow.mjs";

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

test("validates a graph against installed ComfyUI nodes", () => {
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

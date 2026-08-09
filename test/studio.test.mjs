import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { splitLongText, StudioStore, STUDIO_PIPELINES } from "../src/studio.mjs";

test("defines the complete drama pipeline and product workflow", () => {
  assert.equal(STUDIO_PIPELINES.drama.stages.length, 17);
  assert.deepEqual(STUDIO_PIPELINES.drama.stages.map((item) => item[1]), ["小说解析", "剧情改编", "分集剧本", "人物设定", "场景设定", "分镜", "景别/机位/运镜", "灯光材质", "提示词", "图像生成", "视频生成", "配音", "口型", "字幕/音效/音乐", "剪辑", "质检", "成片"]);
  assert.equal(STUDIO_PIPELINES.product.stages.length, 14);
});

test("persists stage artifacts and invalidates downstream work", () => {
  const store = new StudioStore(fs.mkdtempSync(path.join(os.tmpdir(), "ropiq-studio-")));
  let project = store.create({ type: "drama", title: "Test", sourceText: "第一章\n\n故事开始。" });
  project = store.saveArtifact(project.id, "novel_analysis", { summary: "解析完成", data: { characters: [] } });
  project = store.saveArtifact(project.id, "story_adaptation", { summary: "改编完成", data: {} });
  assert.equal(project.progress.done, 2);
  project = store.saveArtifact(project.id, "novel_analysis", { summary: "重新解析", data: {} });
  assert.equal(project.stages.find((item) => item.id === "story_adaptation").status, "stale");
  assert.equal(store.nextStage(project.id).id, "story_adaptation");
});

test("splits long source text on paragraph boundaries", () => {
  const chunks = splitLongText(["a".repeat(20), "b".repeat(20), "c".repeat(20)].join("\n\n"), 30, 10);
  assert.deepEqual(chunks, ["a".repeat(20), "b".repeat(20), "c".repeat(20)]);
});

test("keeps the complete maximum-size source across chunks", () => {
  const source = "长".repeat(399900);
  const chunks = splitLongText(source);
  assert.equal(chunks.join(""), source);
  assert.ok(chunks.length <= 32);
});

test("persists and updates media execution runs", () => {
  const store = new StudioStore(fs.mkdtempSync(path.join(os.tmpdir(), "ropiq-studio-run-")));
  let project = store.create({ type: "drama", title: "Run", sourceText: "故事。" });
  project = store.saveArtifact(project.id, "image_generation", { summary: "关键帧", execution: { executor: "comfyui", jobs: [] } }, "specified");
  project = store.recordExecutionRun(project.id, "image_generation", { promptId: "prompt-1", status: "submitted" });
  assert.equal(project.stages.find((item) => item.id === "image_generation").status, "running");
  assert.equal(project.artifacts.image_generation.execution.runs[0].status, "submitted");
  project = store.recordExecutionRun(project.id, "image_generation", { promptId: "prompt-1", status: "success", outputs: [{ filename: "frame.png" }] }, "complete");
  assert.equal(project.artifacts.image_generation.execution.runs.length, 1);
  assert.equal(project.artifacts.image_generation.execution.runs[0].outputs[0].filename, "frame.png");
  assert.equal(project.stages.find((item) => item.id === "image_generation").status, "complete");
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileStagePrompts, splitLongText, StudioStore, STUDIO_PIPELINES, validateStagePromptArtifact } from "../src/studio.mjs";

test("defines the complete drama pipeline and product workflow", () => {
  assert.equal(STUDIO_PIPELINES.drama.stages.length, 17);
  assert.deepEqual(STUDIO_PIPELINES.drama.stages.map((item) => item[1]), ["小说解析", "剧情改编", "分集剧本", "人物设定", "场景设定", "分镜", "景别/机位/运镜", "灯光材质", "提示词", "图像生成", "视频生成", "配音", "口型", "字幕/音效/音乐", "剪辑", "质检", "成片"]);
  assert.equal(STUDIO_PIPELINES.product.stages.length, 14);
  assert.equal(STUDIO_PIPELINES.drama.stages.find(([id]) => id === "lip_sync")[2], "comfyui");
  assert.deepEqual(STUDIO_PIPELINES.drama.stages.slice(-4).map((item) => item[2]), ["local:media", "local:media", "local:media", "local:media"]);
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

test("validates compiled video and voice prompts", () => {
  const video = validateStagePromptArtifact("video_generation", { execution: { jobs: [{
    id: "video-1", shot_id: "shot-1", source_image_ref: "image-1", duration_seconds: 4, fps: 16,
    video_prompt: { positive: "boat moves", motion: "gentle water", camera: "slow push", lighting_material: "wet reflections", continuity: ["orange boat"], negative: "flicker", compiled: "orange boat, gentle drift, slow push" },
  }] } });
  assert.equal(video.valid, true);
  const voice = validateStagePromptArtifact("voice_synthesis", { execution: { jobs: [{
    id: "voice-1", line_id: "line-1", shot_id: "shot-1", character_id: "narrator", text: "雨停了。", synthesis_text: "雨停了……", language: "Chinese", speaker: "Serena", scene_context: "雨夜后的屋檐下", emotional_cause: "确认危险已经过去", target_duration_seconds: 2,
    performance_beats: [{ text: "雨停了", delivery: "如释重负", pause_after_ms: 300 }],
    voice_prompt: { voice_profile: "原创温和中性声线", emotion: "克制", intensity: "low", volume: "轻", pace: "slow", breath: "稳定", pauses: [], emphasis: ["停"], tail_tone: "柔和落下", pronunciation: [], restrictions: ["不得模仿真人"], compiled_instruction: "温和、克制、慢速", engine_instruction: "温和、克制、慢速" },
  }] } });
  assert.equal(voice.valid, true);
  assert.match(validateStagePromptArtifact("video_generation", { execution: { jobs: [{}] } }).errors.join(" "), /source_image_ref/);
});

test("feeds script and character context into voice prompts", () => {
  const store = new StudioStore(fs.mkdtempSync(path.join(os.tmpdir(), "ropiq-studio-context-")));
  let project = store.create({ type: "drama", title: "Context", sourceText: "故事。" });
  project = store.saveArtifact(project.id, "episodic_scripts", { summary: "台词", data: { line: "下雨了" } });
  project = store.saveArtifact(project.id, "character_design", { summary: "声线", data: { voice: "温和中性" } });
  project = store.saveArtifact(project.id, "video_generation", { summary: "镜头", execution: { jobs: [{ shot_id: "shot-1", duration_seconds: 2 }] } }, "specified");
  const context = store.stageContext(project.id, "voice_synthesis");
  assert.match(context, /下雨了/);
  assert.match(context, /温和中性/);
  assert.match(context, /shot-1/);
});

test("deterministically compiles editable video and voice prompt fields", () => {
  const video = { execution: { jobs: [{ video_prompt: { positive: "橙色小船前进", motion: "水面轻柔波动", camera: "缓慢推进", lighting_material: "湿润反光", continuity: "船体颜色不变", negative: "闪烁" } }] } };
  compileStagePrompts("video_generation", video);
  assert.equal(video.execution.jobs[0].video_prompt.compiled, "橙色小船前进；动作与环境运动：水面轻柔波动；镜头：缓慢推进；灯光材质：湿润反光；连续性必须保持：船体颜色不变");
  assert.deepEqual(video.execution.jobs[0].video_prompt.continuity, ["船体颜色不变"]);

  const voice = { execution: { jobs: [{ text: "雨停了", language: "Chinese", speaker: "Serena", performance_beats: [{ text: "雨停了", delivery: "先松一口气", pause_after_ms: 250 }], scene_context: "雨夜的屋檐下", emotional_cause: "终于确认同伴平安", voice_prompt: { voice_profile: "原创温和中性声线", emotion: "克制", pauses: ["逗号后停顿 0.2 秒"], emphasis: ["停"], pronunciation: [{ 雨: "yu3" }], restrictions: ["不得模仿真人"] } }] } };
  compileStagePrompts("voice_synthesis", voice);
  assert.match(voice.execution.jobs[0].voice_prompt.compiled_instruction, /声线：原创温和中性声线/);
  assert.match(voice.execution.jobs[0].voice_prompt.compiled_instruction, /强度：中等/);
  assert.match(voice.execution.jobs[0].voice_prompt.compiled_instruction, /场景：雨夜的屋檐下/);
  assert.match(voice.execution.jobs[0].voice_prompt.compiled_instruction, /情绪原因：终于确认同伴平安/);
  assert.match(voice.execution.jobs[0].voice_prompt.compiled_instruction, /音量：自然/);
  assert.match(voice.execution.jobs[0].voice_prompt.compiled_instruction, /呼吸：稳定/);
  assert.match(voice.execution.jobs[0].voice_prompt.compiled_instruction, /重音：停/);
  assert.match(voice.execution.jobs[0].voice_prompt.compiled_instruction, /尾音：自然收束/);
  assert.match(voice.execution.jobs[0].voice_prompt.compiled_instruction, /语速：自然/);
  assert.match(voice.execution.jobs[0].voice_prompt.compiled_instruction, /发音：雨:yu3/);
  assert.match(voice.execution.jobs[0].voice_prompt.compiled_instruction, /限制：不得模仿真人/);
  assert.match(voice.execution.jobs[0].voice_prompt.engine_instruction, /使用原创温和中性声线/);
  assert.match(voice.execution.jobs[0].voice_prompt.engine_instruction, /节奏分段：雨停了（先松一口气，后停顿250毫秒）/);
  assert.equal(voice.execution.jobs[0].synthesis_text, "雨停了");
  assert.equal(voice.execution.jobs[0].language, "Chinese");
  assert.equal(voice.execution.jobs[0].speaker, "Serena");
  assert.equal(voice.execution.jobs[0].target_duration_seconds, 1);
});

test("upgrades legacy voice stages to the local node-graph executor", () => {
  const store = new StudioStore(fs.mkdtempSync(path.join(os.tmpdir(), "ropiq-studio-upgrade-")));
  const project = store.create({ type: "drama", title: "Legacy", sourceText: "故事。" });
  const raw = JSON.parse(fs.readFileSync(store.projectFile(project.id), "utf8"));
  raw.stages.find((stage) => stage.id === "voice_synthesis").executor = "plugin:tts";
  fs.writeFileSync(store.projectFile(project.id), JSON.stringify(raw));
  assert.equal(store.get(project.id).stages.find((stage) => stage.id === "voice_synthesis").executor, "comfyui");
});

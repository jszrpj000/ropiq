import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSrt, resolveFfmpeg, validateMediaPlan } from "../src/media.mjs";

test("uses a user-configured FFmpeg executable", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ropiq-ffmpeg-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "ffmpeg.exe");
  fs.writeFileSync(executable, "user supplied");
  assert.equal(resolveFfmpeg(root, executable), executable);
});

test("builds deterministic SRT subtitles from a production timeline", () => {
  const text = buildSrt([
    { start_seconds: 1.25, end_seconds: 2.5, text: "第二句" },
    { start_seconds: 0, end_seconds: 1.2, text: "第一句" },
  ]);
  assert.equal(text, "1\n00:00:00,000 --> 00:00:01,200\n第一句\n\n2\n00:00:01,250 --> 00:00:02,500\n第二句\n");
  assert.throws(() => buildSrt([{ start_seconds: 2, end_seconds: 1, text: "错误" }]), /时间范围无效/);
});

test("rejects incomplete local media plans before execution", () => {
  assert.equal(validateMediaPlan({ kind: "edit", videoSources: [], width: 1280, height: 720, fps: 24 }).valid, false);
  assert.equal(validateMediaPlan({ kind: "quality", inputFile: "edited.mp4" }).valid, true);
  assert.equal(validateMediaPlan({ kind: "master", inputFile: "edited.mp4", width: 1280, height: 720, fps: 24 }).valid, true);
});

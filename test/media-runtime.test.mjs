import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeMediaPlan, resolveFfmpeg } from "../src/media.mjs";

const run = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const ffmpegPath = resolveFfmpeg(projectRoot);

test("executes subtitles, editing, decode QC and final mastering with an available FFmpeg runtime", { skip: ffmpegPath ? false : "FFmpeg runtime is not present" }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ropiq-media-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source.mp4");
  await run(ffmpegPath, [
    "-y", "-f", "lavfi", "-i", "color=c=0x29425f:s=640x360:d=1:r=24",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
  ], { windowsHide: true });

  const subtitles = await executeMediaPlan({ kind: "subtitles", captions: [{ start_seconds: 0, end_seconds: 0.9, text: "Ropiq 本地字幕测试" }] }, { ffmpegPath, workDir: path.join(root, "subtitles") });
  const edited = await executeMediaPlan({ kind: "edit", videoSources: [{ filename: "source.mp4", local: source }], subtitleFile: subtitles.outputs[0].absolutePath, burnSubtitles: true, width: 640, height: 360, fps: 24 }, {
    ffmpegPath,
    workDir: path.join(root, "edit"),
    downloadRemote: async (item, destination) => fs.copyFileSync(item.local, destination),
  });
  const quality = await executeMediaPlan({ kind: "quality", inputFile: edited.outputs[0].absolutePath }, { ffmpegPath, workDir: path.join(root, "quality") });
  const mastered = await executeMediaPlan({ kind: "master", inputFile: edited.outputs[0].absolutePath, width: 640, height: 360, fps: 24, filename: "verified-final.mp4" }, { ffmpegPath, workDir: path.join(root, "master") });

  const report = JSON.parse(fs.readFileSync(quality.outputs[0].absolutePath, "utf8"));
  assert.equal(report.decode_ok, true);
  assert.ok(fs.statSync(edited.outputs[0].absolutePath).size > 0);
  assert.ok(fs.statSync(mastered.outputs[0].absolutePath).size > 0);
  assert.equal(mastered.outputs[0].filename, "verified-final.mp4");
});

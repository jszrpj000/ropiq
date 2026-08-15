import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function safeName(value, fallback) {
  const name = path.basename(String(value || "")).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return name && !name.includes("..") ? name : fallback;
}

function srtTime(seconds) {
  const milliseconds = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor(milliseconds % 3600000 / 60000);
  const secs = Math.floor(milliseconds % 60000 / 1000);
  const ms = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function buildSrt(captions) {
  return [...(captions || [])]
    .sort((a, b) => Number(a.start_seconds) - Number(b.start_seconds))
    .map((caption, index) => {
      const start = Number(caption.start_seconds);
      const end = Number(caption.end_seconds);
      if (!(start >= 0) || !(end > start)) throw new Error(`字幕 ${index + 1} 时间范围无效`);
      const text = String(caption.text || "").trim().replace(/\r/g, "");
      if (!text) throw new Error(`字幕 ${index + 1} 内容为空`);
      return `${index + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${text}`;
    }).join("\n\n") + "\n";
}

export function resolveFfmpeg(projectRoot, configuredPath = process.env.ROPIQ_FFMPEG_PATH) {
  const candidates = [
    String(configuredPath || "").trim(),
    path.resolve(projectRoot, "..", "tools", "runtime", "ffmpeg", "ffmpeg-9.0-essentials_build", "bin", "ffmpeg.exe"),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => (current + chunk.toString("utf8")).slice(-2 * 1024 * 1024);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code: Number(code), stdout, stderr };
      if (code === 0 || options.allowFailure) resolve(result);
      else reject(new Error(`本地媒体处理失败 (${code})：${stderr.split(/\r?\n/).filter(Boolean).slice(-6).join("；").slice(0, 1200)}`));
    });
  });
}

async function hasAudio(ffmpeg, input, cwd) {
  const result = await runProcess(ffmpeg, ["-hide_banner", "-i", input], { cwd, allowFailure: true });
  return /Stream #\d+:\d+.*Audio:/i.test(result.stderr);
}

async function normalizeClip(ffmpeg, input, output, width, height, fps, cwd) {
  const videoFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${fps},format=yuv420p`;
  const audio = await hasAudio(ffmpeg, input, cwd);
  const args = ["-y", "-i", input];
  if (!audio) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  args.push("-map", "0:v:0", "-map", audio ? "0:a:0" : "1:a:0", "-vf", videoFilter, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2");
  if (!audio) args.push("-shortest");
  args.push(output);
  await runProcess(ffmpeg, args, { cwd });
}

function fileHash(file) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex").toUpperCase();
}

function requireFile(file, label) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${label}不存在`);
  return file;
}

export function validateMediaPlan(plan) {
  const errors = [];
  if (!plan || !["subtitles", "edit", "quality", "master"].includes(plan.kind)) errors.push("本地媒体计划类型无效");
  if (plan?.kind === "subtitles" && !(plan.captions?.length > 0)) errors.push("字幕计划没有时间轴");
  if (plan?.kind === "edit" && !(plan.videoSources?.length > 0)) errors.push("剪辑计划没有视频来源");
  if (["quality", "master"].includes(plan?.kind) && !plan.inputFile) errors.push("媒体计划没有输入成片");
  const width = Number(plan?.width || 0);
  const height = Number(plan?.height || 0);
  const fps = Number(plan?.fps || 0);
  if (["edit", "master"].includes(plan?.kind) && (!(width >= 256 && width <= 3840) || !(height >= 256 && height <= 3840) || !(fps >= 8 && fps <= 60))) errors.push("输出尺寸或帧率无效");
  return { valid: errors.length === 0, score: errors.length ? 0 : 100, errors, warnings: [] };
}

export async function executeMediaPlan(plan, context) {
  const validation = validateMediaPlan(plan);
  if (!validation.valid) throw new Error(validation.errors.join("；"));
  const ffmpeg = requireFile(context.ffmpegPath, "FFmpeg 运行时");
  const workDir = path.resolve(context.workDir);
  fs.mkdirSync(workDir, { recursive: true });

  if (plan.kind === "subtitles") {
    const output = path.join(workDir, "captions.srt");
    fs.writeFileSync(output, buildSrt(plan.captions), "utf8");
    return { outputs: [{ absolutePath: output, filename: path.basename(output), kind: "subtitles", sha256: fileHash(output) }] };
  }

  if (plan.kind === "edit") {
    const normalized = [];
    for (const [index, source] of plan.videoSources.entries()) {
      const extension = path.extname(source.filename || "") || ".mp4";
      const input = path.join(workDir, `source-${index + 1}${extension}`);
      await context.downloadRemote(source, input, 1024 * 1024 * 1024);
      const output = path.join(workDir, `normalized-${index + 1}.mp4`);
      await normalizeClip(ffmpeg, input, output, plan.width, plan.height, plan.fps, workDir);
      normalized.push(output);
    }

    let joined = normalized[0];
    if (normalized.length > 1) {
      const list = path.join(workDir, "concat.txt");
      fs.writeFileSync(list, normalized.map((file) => `file '${path.basename(file).replaceAll("'", "'\\''")}'`).join("\n") + "\n", "utf8");
      joined = path.join(workDir, "joined.mp4");
      await runProcess(ffmpeg, ["-y", "-f", "concat", "-safe", "1", "-i", path.basename(list), "-c", "copy", path.basename(joined)], { cwd: workDir });
    }

    let narration = "";
    if (plan.narrationSource) {
      narration = path.join(workDir, `narration${path.extname(plan.narrationSource.filename || "") || ".flac"}`);
      await context.downloadRemote(plan.narrationSource, narration, 200 * 1024 * 1024);
    }
    const subtitle = plan.subtitleFile ? requireFile(plan.subtitleFile, "字幕文件") : "";
    const music = plan.musicFile ? requireFile(plan.musicFile, "音乐素材") : "";
    const output = path.join(workDir, "edited.mp4");
    const args = ["-y", "-i", path.basename(joined)];
    if (narration) args.push("-i", path.basename(narration));
    if (music) args.push("-stream_loop", "-1", "-i", music);

    const audioInputs = [];
    if (narration) audioInputs.push({ index: 1, volume: 1 });
    if (music) audioInputs.push({ index: narration ? 2 : 1, volume: 0.15 });
    if (audioInputs.length) {
      const filters = ["[0:a]volume=0.45[a0]"];
      const labels = ["[a0]"];
      audioInputs.forEach((input, index) => {
        filters.push(`[${input.index}:a]volume=${input.volume}[a${index + 1}]`);
        labels.push(`[a${index + 1}]`);
      });
      filters.push(`${labels.join("")}amix=inputs=${labels.length}:duration=first:dropout_transition=2[aout]`);
      args.push("-filter_complex", filters.join(";"), "-map", "0:v:0", "-map", "[aout]");
    } else {
      args.push("-map", "0:v:0", "-map", "0:a:0");
    }
    if (subtitle && plan.burnSubtitles !== false) {
      fs.copyFileSync(subtitle, path.join(workDir, "captions.srt"));
      args.push("-vf", "subtitles=captions.srt:force_style='FontName=Microsoft YaHei,FontSize=18,Outline=2,Shadow=1,MarginV=36,Alignment=2'");
    }
    args.push("-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", path.basename(output));
    await runProcess(ffmpeg, args, { cwd: workDir });
    return { outputs: [{ absolutePath: output, filename: path.basename(output), kind: "videos", sha256: fileHash(output) }] };
  }

  if (plan.kind === "quality") {
    const input = requireFile(plan.inputFile, "待质检成片");
    const checked = await runProcess(ffmpeg, ["-v", "error", "-i", input, "-f", "null", "-"], { cwd: workDir, allowFailure: true });
    const report = {
      checked_at: new Date().toISOString(),
      decode_ok: checked.code === 0,
      byte_size: fs.statSync(input).size,
      sha256: fileHash(input),
      ffmpeg_errors: checked.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-20),
      note: "自动检查覆盖文件完整性和解码错误；剧情、口型观感、字幕遮挡、版权和商品真实性仍需人工复核。",
    };
    const output = path.join(workDir, "quality-report.json");
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    if (!report.decode_ok) throw new Error(`成片解码检查失败：${report.ffmpeg_errors.join("；").slice(0, 1000)}`);
    return { outputs: [{ absolutePath: output, filename: path.basename(output), kind: "reports", sha256: fileHash(output) }] };
  }

  const input = requireFile(plan.inputFile, "待交付成片");
  const outputName = safeName(plan.filename, "ropiq-final.mp4").replace(/\.[^.]+$/, "") + ".mp4";
  const output = path.join(workDir, outputName);
  const filter = `scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease,pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${plan.fps},format=yuv420p`;
  await runProcess(ffmpeg, ["-y", "-i", input, "-map", "0:v:0", "-map", "0:a?", "-vf", filter, "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-metadata", "comment=AI-assisted production; human review required", output], { cwd: workDir });
  const manifest = { filename: path.basename(output), byte_size: fs.statSync(output).size, sha256: fileHash(output), created_at: new Date().toISOString(), ai_assisted: true };
  const manifestFile = path.join(workDir, "delivery-manifest.json");
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { outputs: [
    { absolutePath: output, filename: path.basename(output), kind: "videos", sha256: manifest.sha256 },
    { absolutePath: manifestFile, filename: path.basename(manifestFile), kind: "reports", sha256: fileHash(manifestFile) },
  ] };
}

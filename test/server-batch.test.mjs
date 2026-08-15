import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const choice = (values) => [values, {}];
const objectInfo = {
  UNETLoader: { input: { required: { unet_name: choice(["z_image_turbo_bf16.safetensors"]), weight_dtype: choice(["default"]) } }, output: ["MODEL"] },
  ModelSamplingAuraFlow: { input: { required: { model: ["MODEL", {}], shift: ["FLOAT", {}] } }, output: ["MODEL"] },
  CLIPLoader: { input: { required: { clip_name: choice(["qwen_3_4b.safetensors"]), type: choice(["lumina2"]), device: choice(["default"]) } }, output: ["CLIP"] },
  CLIPTextEncode: { input: { required: { text: ["STRING", {}], clip: ["CLIP", {}] } }, output: ["CONDITIONING"] },
  EmptySD3LatentImage: { input: { required: { width: ["INT", {}], height: ["INT", {}], batch_size: ["INT", {}] } }, output: ["LATENT"] },
  KSampler: { input: { required: { model: ["MODEL", {}], positive: ["CONDITIONING", {}], negative: ["CONDITIONING", {}], latent_image: ["LATENT", {}], seed: ["INT", {}], control_after_generate: choice(["fixed"]), steps: ["INT", {}], cfg: ["FLOAT", {}], sampler_name: choice(["res_multistep"]), scheduler: choice(["simple"]), denoise: ["FLOAT", {}] } }, output: ["LATENT"] },
  VAELoader: { input: { required: { vae_name: choice(["ae.safetensors"]) } }, output: ["VAE"] },
  VAEDecode: { input: { required: { samples: ["LATENT", {}], vae: ["VAE", {}] } }, output: ["IMAGE"] },
  SaveImage: { input: { required: { images: ["IMAGE", {}], filename_prefix: ["STRING", {}] } }, output: [], output_node: true },
};

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(url)).ok) return; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become ready: ${url}`);
}

test("prepares, confirms and records every job in a ComfyUI batch", async (t) => {
  const submitted = [];
  const fake = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    let payload = {};
    if (request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    }
    const send = (value) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
    if (url.pathname === "/system_stats") return send({ devices: [{ name: "test GPU", vram_total: 32 * 1024 ** 3 }] });
    if (url.pathname === "/object_info") return send(objectInfo);
    if (url.pathname === "/models") return send([]);
    if (url.pathname === "/workflow_templates") return send({});
    if (url.pathname === "/embeddings") return send([]);
    if (url.pathname === "/prompt") { submitted.push(payload.prompt); return send({ prompt_id: randomUUID() }); }
    response.writeHead(404); response.end();
  });
  const fakePort = await listen(fake);
  const appPort = await freePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ropiq-server-batch-"));
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "..", "server.mjs")], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, ROPIQ_DATA_DIR: dataRoot, ROPIQ_PORT: String(appPort), BACKEND_BASE_URL: `http://127.0.0.1:${fakePort}`, LLM_BASE_URL: "", LLM_MODEL: "" },
    windowsHide: true,
    stdio: "ignore",
  });
  t.after(() => { child.kill(); fake.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${appPort}`;
  await waitForServer(`${base}/api/bootstrap`);
  const json = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
    return value;
  };
  const created = await json("/api/studio/projects", { method: "POST", body: JSON.stringify({ type: "drama", title: "Batch", sourceText: "原创测试故事", settings: { aspectRatio: "16:9" } }) });
  const projectId = created.project.id;
  const artifact = { summary: "两张关键帧", execution: { executor: "comfyui", jobs: [
    { id: "image-1", shot_id: "shot-1", positive_prompt: "original adult character in a room", width: 768, height: 768 },
    { id: "image-2", shot_id: "shot-2", positive_prompt: "same original adult character outdoors", width: 768, height: 768 },
  ] } };
  await json(`/api/studio/projects/${projectId}/stages/image_generation/artifact`, { method: "POST", body: JSON.stringify({ artifact, status: "specified" }) });
  const prepared = await json(`/api/studio/projects/${projectId}/stages/image_generation/prepare-execution`, { method: "POST", body: "{}" });
  assert.equal(prepared.batchCount, 2);
  assert.equal(prepared.recommended.workflow.batch_count, 2);
  const confirmed = await json("/api/confirm", { method: "POST", body: JSON.stringify({ planId: prepared.planId, approved: true }) });
  assert.equal(confirmed.result.prompt_ids.length, 2);
  assert.equal(submitted.length, 2);
  assert.deepEqual(confirmed.studioProject.artifacts.image_generation.execution.runs.map((run) => run.jobId), ["image-1", "image-2"]);
  assert.deepEqual(confirmed.studioProject.artifacts.image_generation.execution.runs.map((run) => run.shotId), ["shot-1", "shot-2"]);
});

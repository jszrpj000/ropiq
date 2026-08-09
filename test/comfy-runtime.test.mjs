import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveComfyRuntime, startManagedComfyUi } from "../src/comfy-runtime.mjs";

test("finds an unpacked portable ComfyUI runtime", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "comfy-runtime-"));
  const portable = path.join(root, "runtime", "ComfyUI_windows_portable");
  fs.mkdirSync(path.join(portable, "ComfyUI"), { recursive: true });
  fs.mkdirSync(path.join(portable, "python_embeded"), { recursive: true });
  fs.writeFileSync(path.join(portable, "ComfyUI", "main.py"), "");
  fs.writeFileSync(path.join(portable, "python_embeded", "python.exe"), "");
  const runtime = resolveComfyRuntime(root, {});
  assert.equal(runtime.comfyHome, path.join(portable, "ComfyUI"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("does not start a process when no managed runtime is installed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "comfy-runtime-"));
  const config = { baseUrl: "", home: "", python: "", port: 8188 };
  const result = await startManagedComfyUi(root, config, { env: {} });
  assert.equal(result.mode, "missing");
  fs.rmSync(root, { recursive: true, force: true });
});

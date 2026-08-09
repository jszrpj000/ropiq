import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export function resolveComfyRuntime(projectRoot, env = process.env) {
  const configured = env.COMFYUI_HOME ? path.resolve(env.COMFYUI_HOME) : "";
  const roots = [configured, path.join(projectRoot, "runtime", "ComfyUI_windows_portable")].filter(Boolean);

  for (const root of roots) {
    const comfyHome = fs.existsSync(path.join(root, "main.py")) ? root : path.join(root, "ComfyUI");
    const portableRoot = path.dirname(comfyHome);
    const pythonCandidates = [
      env.COMFYUI_PYTHON,
      path.join(portableRoot, "python_embeded", "python.exe"),
      path.join(portableRoot, "python_embeded", "python"),
    ].filter(Boolean);
    const python = pythonCandidates.find((candidate) => fs.existsSync(candidate));
    const main = path.join(comfyHome, "main.py");
    if (python && fs.existsSync(main)) return { root: portableRoot, comfyHome, python, main };
  }
  return null;
}

async function waitUntilReady(baseUrl, fetchImpl, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetchImpl(`${baseUrl}/system_stats`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("本地 ComfyUI 启动超时");
}

export async function startManagedComfyUi(projectRoot, config, options = {}) {
  if (config.baseUrl) return { mode: "external" };
  const env = {
    ...process.env,
    ...(options.env || {}),
    ...(config.home ? { COMFYUI_HOME: config.home } : {}),
    ...(config.python ? { COMFYUI_PYTHON: config.python } : {}),
  };
  const runtime = resolveComfyRuntime(projectRoot, env);
  if (!runtime) return { mode: "missing" };

  const port = Number.isInteger(config.port) ? config.port : Number.parseInt(env.COMFYUI_PORT || "8188", 10);
  const baseUrl = `http://127.0.0.1:${port}`;
  const spawnImpl = options.spawnImpl || spawn;
  const child = spawnImpl(runtime.python, [
    "-s", runtime.main,
    "--listen", "127.0.0.1",
    "--port", String(port),
    "--disable-auto-launch",
    "--windows-standalone-build",
  ], { cwd: runtime.comfyHome, windowsHide: true, stdio: "ignore" });

  config.baseUrl = baseUrl;
  await waitUntilReady(baseUrl, options.fetchImpl || fetch, options.timeoutMs || 120000);
  const stop = () => { if (!child.killed) child.kill(); };
  process.once("exit", stop);
  process.once("SIGINT", () => { stop(); process.exit(0); });
  process.once("SIGTERM", () => { stop(); process.exit(0); });
  return { mode: "managed", pid: child.pid, baseUrl };
}

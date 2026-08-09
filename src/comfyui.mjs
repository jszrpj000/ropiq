export class ComfyUiClient {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async request(route, options = {}) {
    if (!this.config.baseUrl) throw new Error("未配置 BACKEND_BASE_URL");
    const { timeoutMs = 30000, ...requestOptions } = options;
    const headers = { ...(requestOptions.headers || {}) };
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
    const response = await this.fetch(`${this.config.baseUrl}/${route.replace(/^\//, "")}`, {
      ...requestOptions,
      headers,
      signal: requestOptions.signal || AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`生成后端 ${route} 请求失败 (${response.status})`);
    return response;
  }

  async json(route, options = {}) {
    return (await this.request(route, options)).json();
  }

  async post(route, body) {
    return this.json(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async snapshot(timeoutMs = 30000) {
    const [systemStats, objectInfo, modelFolders, templates, embeddings] = await Promise.all([
      this.json("system_stats", { timeoutMs }),
      this.json("object_info", { timeoutMs }),
      this.json("models", { timeoutMs }).catch(() => []),
      this.json("workflow_templates", { timeoutMs }).catch(() => ({})),
      this.json("embeddings", { timeoutMs }).catch(() => []),
    ]);
    const modelLists = {};
    const folders = Array.isArray(modelFolders) ? modelFolders.slice(0, 60) : [];
    const results = await Promise.all(folders.map(async (folder) => [folder, await this.json(`models/${encodeURIComponent(folder)}`, { timeoutMs }).catch(() => [])]));
    for (const [folder, models] of results) modelLists[folder] = models;
    return { systemStats, objectInfo, modelFolders: folders, modelLists, templates, embeddings };
  }

  submit(workflow, clientId) {
    return this.post("prompt", { prompt: workflow, client_id: clientId });
  }

  queue() { return this.json("queue"); }
  history(promptId = "") { return this.json(promptId ? `history/${encodeURIComponent(promptId)}` : "history"); }
  interrupt() { return this.post("interrupt", {}); }
  clearQueue() { return this.post("queue", { clear: true }); }
  freeMemory() { return this.post("free", { unload_models: true, free_memory: true }); }

  async uploadImage(filename, bytes) {
    const form = new FormData();
    form.append("image", new Blob([bytes]), filename);
    form.append("type", "input");
    form.append("overwrite", "false");
    return this.json("upload/image", { method: "POST", body: form });
  }
}

export function summarizeSnapshot(snapshot) {
  const devices = snapshot.systemStats?.devices || [];
  return {
    node_count: Object.keys(snapshot.objectInfo || {}).length,
    model_folders: snapshot.modelFolders || [],
    model_count: Object.values(snapshot.modelLists || {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0),
    template_count: Object.keys(snapshot.templates || {}).length,
    embeddings: snapshot.embeddings || [],
    devices: devices.map((device) => ({
      name: device.name || device.type || "GPU",
      vram_total_gb: device.vram_total ? Math.round(device.vram_total / 1024 ** 3 * 10) / 10 : null,
      vram_free_gb: device.vram_free ? Math.round(device.vram_free / 1024 ** 3 * 10) / 10 : null,
    })),
  };
}

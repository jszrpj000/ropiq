# Comfy Agent

Comfy Agent is a conversation-first control layer for ComfyUI. A user describes the result they want; the agent reads the installed nodes, models, templates, GPU, and VRAM, proposes candidate API workflows, validates them locally, and recommends the best valid graph.

> Status: early alpha. The planning and safety loop works; installers, model packs, and production billing are roadmap items.

## What works

- OpenAI-compatible, Anthropic, and Gemini model APIs behind one adapter.
- Live discovery through ComfyUI `/object_info`, `/models`, `/workflow_templates`, and `/system_stats`.
- Candidate ranking with hard validation for node types, required inputs, links, enums, ranges, paths, and resource risk.
- Human approval before generation, upload, queue clearing, interruption, or memory release.
- Queue/history inspection, approved-asset upload, output download, and non-secret run records.
- External ComfyUI or automatic startup of an unpacked ComfyUI Portable runtime.

Comfy Agent does not bundle checkpoints or claim that every GPU can run every model. Hardware support comes from the selected official ComfyUI/PyTorch distribution; the future installer will select the correct runtime and compatible model pack.

## Quick start

Requires Node.js 22 or later.

```powershell
Copy-Item .env.example .env.local
npm test
npm start
```

Open `http://127.0.0.1:8787`.

Configure an existing ComfyUI server:

```dotenv
COMFYUI_BASE_URL=http://127.0.0.1:8188
```

Or unpack an official portable build to `runtime/ComfyUI_windows_portable/`. When `COMFYUI_BASE_URL` is empty, Comfy Agent finds its embedded Python and starts ComfyUI on loopback automatically. A custom install can be selected with `COMFYUI_HOME` and `COMFYUI_PYTHON`.

Configure any supported LLM API:

```dotenv
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://your-provider.example/v1
LLM_API_KEY=
LLM_MODEL=your-model
```

Local OpenAI-compatible services such as Ollama, vLLM, and LM Studio can leave `LLM_API_KEY` empty.

## Safety model

- The LLM proposes plans; it cannot bypass the deterministic validator.
- Side effects require a separate confirmation request.
- Only files under `assets/approved/` can be uploaded.
- The server listens on `127.0.0.1` by default.
- `.env.local`, runtimes, models, user assets, and run data are ignored by Git.

## Open core

The self-hosted single-user core is licensed under AGPL-3.0-or-later. Paid products may add managed GPU execution, team workspaces, enterprise identity, commercial workflow packs, support, and hosted operations without placing secrets or proprietary assets in this repository. See [Open-core model](docs/OPEN_CORE.md) and [Roadmap](docs/ROADMAP.md).

## Development

```powershell
npm test
npm start
```

Pull requests should keep providers, hardware runtimes, and ComfyUI nodes pluggable. Do not commit API keys, model files, generated media, or customer data.

# Ropiq

Ropiq is an independent, conversation-first agent for local generation workflows. A user describes the result they want; Ropiq reads the capabilities exposed by a user-configured backend, proposes candidate graphs, validates them locally, and recommends the best valid workflow.

> Status: early alpha. The planning, validation, approval, and execution loop works. A desktop installer and broader backend support are roadmap items.

## What works

- OpenAI-compatible, Anthropic, and Gemini model APIs behind one adapter.
- Live discovery of backend nodes, models, templates, devices, and memory.
- Candidate ranking with deterministic validation for node types, required inputs, links, enums, ranges, paths, and resource risk.
- Human approval before generation, upload, queue clearing, interruption, or memory release.
- Queue/history inspection, approved-asset upload, output download, and non-secret run records.
- Connection to a generation backend installed and controlled by the user.

Ropiq does not distribute or automatically start third-party runtimes, models, nodes, templates, drivers, or assets. Hardware and model support come from the backend and components the user chooses to install under their respective licenses.

## Quick start

Requires Node.js 22 or later and a separately installed supported generation backend.

```powershell
Copy-Item .env.example .env.local
npm test
npm start
```

Open `http://127.0.0.1:8787`.

Configure the backend connection:

```dotenv
BACKEND_TYPE=comfyui
BACKEND_BASE_URL=http://127.0.0.1:8188
BACKEND_API_TOKEN=
```

The initial adapter is compatible with the public HTTP API exposed by ComfyUI. ComfyUI is separate software, is not included in Ropiq, and must be obtained and operated by the user. Ropiq is not affiliated with, endorsed by, or sponsored by Comfy Org.

Configure any supported LLM API:

```dotenv
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://your-provider.example/v1
LLM_API_KEY=
LLM_MODEL=your-model
```

Local OpenAI-compatible services such as Ollama, vLLM, and LM Studio can leave `LLM_API_KEY` empty.

## Safety and provenance

- The LLM proposes plans; it cannot bypass the deterministic validator.
- Side effects require a separate confirmation request.
- Only files under `assets/approved/` can be uploaded.
- The server listens on `127.0.0.1` by default.
- `.env.local`, runtimes, models, custom nodes, user assets, and run data are ignored by Git.
- No third-party logo, interface asset, model, node, workflow, or runtime is part of this repository.

See [Compatibility and independence](docs/COMPATIBILITY.md), [Third-party notices](THIRD_PARTY_NOTICES.md), and [Security](SECURITY.md).

## Open core

The self-hosted single-user core is licensed under AGPL-3.0-or-later. Optional paid products may provide independently implemented hosted execution, team administration, enterprise identity, support, and operations. They must not copy third-party code or restrict rights granted for open-source components. See [Open-core model](docs/OPEN_CORE.md) and [Roadmap](docs/ROADMAP.md).

## Development

```powershell
npm test
npm start
```

Pull requests must keep model providers and generation backends pluggable. Do not commit API keys, third-party binaries, model files, custom nodes, generated media, copied interface assets, or customer data.

`Ropiq` is a project name pending formal trademark clearance. No registered-trademark claim is made by this repository.

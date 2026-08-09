# Ropiq

Ropiq is an independent, conversation-first agent for local generation workflows. A user describes the result they want; Ropiq reads the capabilities exposed by a user-configured backend, proposes candidate graphs, validates them locally, and recommends the best valid workflow.

> Status: installable alpha. The guided configuration, 17-stage AI drama studio, 14-stage product-video studio, planning, extension selection, validation, approval, self-hosted image execution, compatible Wan 2.1 image-to-video previews, and result-sync loop work. Voice, lip-sync, and editing executor adapters remain roadmap items.

## What works

- OpenAI-compatible, Anthropic, and Gemini model APIs behind one adapter.
- Live discovery of backend nodes, models, templates, devices, and memory.
- Candidate ranking with deterministic validation for node types, required inputs, links, enums, ranges, paths, and resource risk.
- Human approval before generation, upload, queue clearing, interruption, or memory release.
- Queue/history inspection, approved-asset upload, output download, and non-secret run records.
- Connection to a generation backend installed and controlled by the user.
- A first-run setup wizard for DeepSeek or other OpenAI-compatible, Anthropic, and Gemini APIs.
- Automatic selection of local `SKILL.md` bundles and declarative plugin tools.
- GitHub catalog discovery with fixed file lists, SHA-256 verification, size limits, and pre-enable security scanning.
- Optional NVIDIA SkillSpector integration when its `skillspector` executable is installed.
- Generic cloud-instance status and stop endpoints; stopping always requires explicit confirmation.
- Persistent AI drama projects covering novel analysis, adaptation, episodic scripts, character/scene design, storyboard, cinematography, look development, prompts, image/video, voice, lip sync, audio/subtitles, editing, quality control, and delivery.
- Studio image stages can assemble a trusted local Z-Image workflow when compatible models are installed, require approval, submit it to the user's backend, persist status/errors, and expose generated outputs for download.
- Video and voice prompts are stored as editable structured fields and deterministically compiled before validation. Missing high-impact fields are rejected instead of silently invented.
- Compatible video stages can assemble a trusted local Wan 2.1 image-to-video workflow. The previous successful keyframe is downloaded and uploaded as the source image only after explicit confirmation, then the complete graph is revalidated before submission.
- A separate product-promotion workflow with factual-claim and brand-consistency checks.
- TXT and Markdown import up to 400,000 characters, chunked source analysis, editable JSON artifacts, per-stage reruns, and automatic downstream invalidation.
- Honest capability reporting: missing media plugins produce reviewable task specifications instead of fake completion claims.

Ropiq does not distribute or automatically start third-party runtimes, models, nodes, templates, drivers, or assets. Hardware and model support come from the backend and components the user chooses to install under their respective licenses.

## Windows installer

Download `Ropiq-Setup-0.4.0-alpha.4.exe` from GitHub Releases, open it, and choose **安装并打开**. It installs per user under `%LOCALAPPDATA%\Programs\Ropiq`, includes its own Node.js runtime, and opens the setup wizard. Administrator rights are not required.

The alpha installer is not code-signed, so Windows may show an unknown-publisher warning. Verify the SHA-256 value published with the release before opening it.

## Source quick start

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
- Only files under the per-user `assets/approved/` directory can be uploaded.
- The server listens on `127.0.0.1` by default.
- API keys, runtimes, models, custom nodes, user assets, and run data are never returned by the setup API and are ignored by Git.
- GitHub extensions cannot choose arbitrary download URLs at execution time. Catalog entries pin each allowed file and SHA-256 digest.
- Declarative plugins can call only URLs configured by the user; LLM output cannot replace those URLs.
- No third-party logo, interface asset, model, node, workflow, or runtime is part of this repository.

See [Compatibility and independence](docs/COMPATIBILITY.md), [Third-party notices](THIRD_PARTY_NOTICES.md), and [Security](SECURITY.md).

## Free and open

The local creative core is licensed under AGPL-3.0-or-later and is intended to remain free. A future optional extension marketplace or learning center may contain clearly labeled advertising, but ads will not be inserted into prompts, projects, outputs, or workflow rankings. See [Free and open model](docs/FREE_AND_OPEN.md) and [Roadmap](docs/ROADMAP.md).

## Development

```powershell
npm test
npm start
```

Pull requests must keep model providers and generation backends pluggable. Do not commit API keys, third-party binaries, model files, custom nodes, generated media, copied interface assets, or customer data.

`Ropiq` is a project name pending formal trademark clearance. No registered-trademark claim is made by this repository.

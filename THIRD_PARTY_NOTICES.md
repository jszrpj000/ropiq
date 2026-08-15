# Third-party notices

The Ropiq source repository does not contain third-party generation backends, models, custom nodes, workflow packs, GPU drivers, or brand assets.

## Optional compatibility

Ropiq currently includes an independently written network adapter compatible with the HTTP API exposed by ComfyUI. ComfyUI is a separate project distributed under GNU GPL v3.0 and is available from its own publisher:

- Project: <https://github.com/Comfy-Org/ComfyUI>
- License: <https://github.com/Comfy-Org/ComfyUI/blob/master/LICENSE>

ComfyUI and Comfy Org names are used only to describe compatibility. They are not part of the Ropiq brand. Ropiq is not affiliated with, endorsed by, or sponsored by Comfy Org.

Users are responsible for obtaining external software and content from authorized sources and complying with each applicable license. Ropiq does not grant rights to any third-party software, model, node, template, workflow, media, or trademark.

Ropiq can recognize a compatible Qwen3-TTS CustomVoice node and ComfyUI's audio output node when users install them separately. Neither Qwen3-TTS models nor community TTS nodes are included in Ropiq. Qwen and third-party node names identify optional compatibility only and do not imply affiliation or endorsement.

- Qwen3-TTS project: <https://github.com/QwenLM/Qwen3-TTS> (Apache License 2.0)
- Compatible community node implementation: <https://github.com/1038lab/ComfyUI-QwenTTS> (GNU GPL v3.0)

## Windows release runtime

Official Windows release installers bundle the Node.js runtime so end users do not need a development environment. Node.js is distributed under the MIT license with additional notices for bundled dependencies. The complete upstream license text is installed as `runtime/NODE-LICENSE.txt`.

- Project: <https://nodejs.org/>
- License: <https://github.com/nodejs/node/blob/main/LICENSE>

Official Windows release installers do not bundle FFmpeg. Local subtitle, editing, decode-QC, and final-master execution can use an FFmpeg executable selected by the user. Users must obtain it from an authorized source and follow the license that applies to their chosen build.

- Project and source: <https://ffmpeg.org/download.html>
- License information: <https://www.ffmpeg.org/legal.html>
FFmpeg's name identifies optional compatibility only. Ropiq is not affiliated with or endorsed by the FFmpeg project.

## Optional security scanner

Ropiq can detect and invoke NVIDIA SkillSpector when the user installs it separately. SkillSpector is not bundled in the source repository or Windows installer.

- Project: <https://github.com/NVIDIA/SkillSpector>
- License: Apache License 2.0

References to NVIDIA and SkillSpector identify optional compatibility only and do not imply affiliation or endorsement.

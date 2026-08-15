# Bundled components

This manifest describes the executable components in the official Ropiq Windows installer.

## Ropiq

- Version: 0.4.0-alpha.10
- Source: this repository
- License: AGPL-3.0-or-later (`LICENSE`)
- Contents: independently written server, browser UI, workflow planners, validators, built-in skills, declarative cloud lifecycle adapter, Windows launcher, installer, and uninstaller

## Node.js

- Version: 22.23.1
- Source: <https://nodejs.org/download/release/v22.23.1/>
- License: MIT with additional notices for bundled dependencies
- Installed license: `runtime/NODE-LICENSE.txt`
- Purpose: runs the local Ropiq server

## Explicitly not bundled

The installer does not contain ComfyUI, FFmpeg, model weights, LoRA files, custom nodes, workflow packs, GPU drivers, NVIDIA SkillSpector, Qwen3-TTS, LongCat, Wan, Z-Image, Real-ESRGAN, voice packs, stock media, fonts, music, or third-party brand assets.

External compatibility names are descriptive only. Users obtain and operate optional external components separately under their respective licenses.

# Roadmap

## Alpha

- Make the 17-stage AI drama studio and 14-stage product-video studio reliable across long projects.
- Add local execution adapters for voice synthesis, lip sync, subtitles/audio, editing, and final mastering.
- Stabilize workflow generation against diverse user-installed node catalogs.
- Add repair loops using backend validation and execution errors.
- Show live progress and generated previews in chat.
- Add end-to-end tests against separately provisioned backend fixtures.
- Add a second independently implemented backend adapter.

## Desktop beta

- Package only Ropiq and its required open-source application runtime.
- Guide users through connecting a separately installed generation backend.
- Report hardware capabilities exposed by the connected backend.
- Add configuration repair, application upgrades, rollback, and diagnostics.
- Display third-party license links before enabling optional integrations.

Ropiq will not bundle third-party generation runtimes, GPU drivers, models, custom nodes, or workflow packs.

## Production

- Signed, reproducible Ropiq releases.
- Documented backend adapter API and compatibility test suite.
- Software bill of materials and automated license checks.
- An optional extension discovery marketplace with license, provenance, and security metadata.
- Clearly labeled advertising only in optional discovery surfaces, never in creative projects or outputs.

Ropiq's local creative core will remain free. Users may independently pay their chosen model API, cloud GPU provider, licensed media source, or extension publisher.

# Roadmap

## Alpha

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
- Optional managed GPU, team, and enterprise services implemented as separate products.

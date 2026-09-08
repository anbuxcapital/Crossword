# Crosscut

Crossword and Daily Five app workspace, including product designs, backend planning,
research, and shared backend primitives. This repository is under development;
the designs and architecture describe capabilities beyond the current implementation.

## Start here

- [Working agreements](AGENTS.md)
- [Design repository](design/README.md) — player prototype and admin-console concepts
- [Architecture](docs/ARCHITECTURE.md)
- [Implementation plan](docs/IMPLEMENTATION-PLAN.md)
- [Cloudflare learning plan](docs/CLOUDFLARE-LEARNING-PLAN.md)
- [Cloudflare materials](docs/CLOUDFLARE-MATERIALS.md)
- [Domain glossary](docs/design/glossary.md)
- [Research](docs/research/README.md)
- [Shared backend primitives](packages/core/README.md)

## Design submodule

`design/` is the separate [CrosswordDesign repository](https://github.com/anbuxcapital/CrosswordDesign).
When cloning this workspace, include its contents with:

```sh
git clone --recurse-submodules https://github.com/anbuxcapital/Crossword.git
```

For an existing clone:

```sh
git submodule update --init --recursive
```

Commit and push design changes in that repository first, then commit the updated
submodule reference here. Detailed product documents remain beside their relevant
work; this README provides the workspace entry point.

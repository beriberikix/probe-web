# Contributing

Thanks for helping. This file covers how the repository is put together and what a change
needs before it lands. The [architecture page](https://beriberikix.github.io/probe-web/guide/architecture)
explains the design.

## Setup

- Node 22 or newer.
- Rust: rustup installs the toolchain in `rust-toolchain.toml` and the
  `wasm32-unknown-unknown` target on first use.
- `wasm-bindgen-cli` at the version of the `wasm-bindgen` crate in `Cargo.lock`
  (currently `cargo install wasm-bindgen-cli --version 0.2.128`). A mismatch produces glue
  that does not load the module.

```sh
npm install
./scripts/build-wasm.sh      # the three wasm crates, the fake-probe worker, and wire.ts
./scripts/build-firmware.sh  # optional: demo and test firmware (Cortex-M)
npm run dev -w apps/flash    # every app on http://127.0.0.1:5173
```

Re-run `build-wasm.sh` after changing anything under `crates/`.

## Layout

- `packages/*`: the TypeScript packages. They ship source, not a build, and every
  package's `exports` point at `src/`.
- `crates/*`: the Rust crates compiled to wasm. `probe-web-core` is the client,
  `probe-web-local` is the worker, and `probe-web-targets` handles pack import.
- `apps/*`, `examples/*`: the hosted apps and examples. `apps/flash`'s dev server serves
  all of them on one origin.
- `tools/wire-gen`: generates `packages/client/src/wire.ts`.
- `hardware-tests/`: firmware and checks for real boards.
- `docs/`: the VitePress site. `docs/api/` is generated.

## probe-rs forks

The crates depend on branches of `beriberikix/probe-rs` over git, pinned by `Cargo.lock`.
To work on the forks alongside this repository, check them out next to it and uncomment the
`paths` override in `.cargo/config.toml`. Without it, edits in a local checkout do not reach
the build.

## Generated files

Do not edit these by hand:

| File | Generator | When |
|---|---|---|
| `packages/client/src/wire.ts` | `tools/wire-gen` (run by `scripts/build-wasm.sh`) | Whenever the probe-rs-rpc revision changes. CI fails if it is stale. |
| `packages/client/src/registers.generated.ts` | `scripts/gen-registers.py <probe-rs checkout>` | When probe-rs's register tables change. |
| `docs/api/` | `npm run docs:api` (TypeDoc) | On every docs build; not committed. |

## Checks

CI runs all of these. Run the ones your change touches:

```sh
npx tsc -b packages/client packages/ui packages/dap packages/devices packages/artifacts packages/serial \
  apps/flash apps/workbench examples/monaco-ide examples/minimal-flash
npm test                                   # vitest
npx playwright test                        # browser suite against the fake probe
npm run docs:build                         # TypeDoc (warnings are errors) + VitePress (dead links fail)
cargo fmt --all --check
cargo clippy --target wasm32-unknown-unknown -p probe-web-core -p probe-web-local -p probe-web-targets -- -D warnings
cargo test -p probe-web-targets -p probe-web-wire-gen
```

The wasm clippy run enforces `clippy.toml`. It bans `std::thread::sleep` and `std`'s
`Instant`, which compile for wasm32 but panic or block there.

Changes that reach hardware (flashing, the worker, the fork) should also pass the relevant
checks in `hardware-tests/README.md` on at least one board. Say which in the pull request.

## Documentation

- Every exported symbol has a TSDoc comment. TypeDoc runs with warnings as errors, so an
  undocumented export or a broken `{@link}` fails the docs build.
- Custom elements document their events with `@fires <name> - <when and what detail is>`.
- Guides live in `docs/guide/`. Take code samples from real usage in `apps/` or
  `examples/`, so they stay correct.
- Comments explain what the code does and why. Keep project history (what used to be broken,
  which pass fixed it) in commit messages, not in code.

`npm run docs:dev` serves the site with the API reference at http://localhost:5180.

## Pull requests

Keep them focused. The description should say what changed, why, and how it was tested:
which suites ran, and which boards if it touches hardware. By contributing, you agree
that your contributions are licensed under MIT or Apache-2.0, as the project is.

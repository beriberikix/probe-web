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
npm run build -w @probe-web/ui  # the components, compiled (about a second)
./scripts/build-firmware.sh  # optional: demo and test firmware (Cortex-M)
npm run dev -w apps/flash    # every app on http://127.0.0.1:5173
```

Re-run `build-wasm.sh` after changing anything under `crates/`.

`@probe-web/ui` is the one package that ships compiled JavaScript rather than source: its
components use decorators, and nothing about an npm package can tell a consumer's toolchain
to enable them. The apps and examples resolve it through its `dist/` exactly as an installed
copy would, so **it has to be built before they will run**. While working on a component,
keep `npx tsc -p packages/ui/tsconfig.build.json --watch` going in another terminal.

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
| `packages/ui/src/xterm-css.generated.ts` | `node scripts/gen-xterm-css.mjs` | After upgrading `@xterm/xterm`. CI fails if it is stale. |
| `packages/ui/dist/` | `npm run build -w @probe-web/ui` | Whenever `packages/ui/src` changes. Gitignored. |
| `docs/api/` | `npm run docs:api` (TypeDoc) | On every docs build; not committed. |

## Reading a worker crash

The wasm modules ship without function names, so a panic's stack trace in the console shows
frames like `probe_web_local_bg.wasm:wasm-function[2699]`. `scripts/build-wasm.sh` keeps a
copy of each module with names in `target/wasm-symbols/`. For the deployed site, each Pages
run uploads them as the `wasm-symbols-<commit>` artifact. Look the numbers up in the copy
from the same build:

```sh
node scripts/wasm-names.mjs lookup target/wasm-symbols/probe_web_local.wasm 2699 6387
# 2699  console_error_panic_hook[…]::hook
# 6387  probe_web_local[…]::start::{closure#0}
```

The panic message and its `file:line` don't depend on names. They reach the page as the
worker's `fatal:` reason either way.

## Checks

CI runs all of these. Run the ones your change touches:

```sh
npx tsc -b packages/client packages/ui packages/dap packages/devices packages/artifacts packages/serial \
  apps/flash apps/workbench examples/monaco-ide examples/minimal-flash examples/react-flash
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

## Releases

Pushing a `v*` tag is the release. `.github/workflows/release.yml` builds the wasm, runs the
checks against it, publishes the six packages to npm with provenance, and opens the GitHub
release from that version's CHANGELOG section.

There is **no npm token**. Each package names this repository and this workflow file as its
[trusted publisher](https://docs.npmjs.com/trusted-publishers), and the job authenticates
with a short-lived OIDC token it mints per run. That also attests every package to the
commit and run that built it, which a publish from a laptop cannot do.

Three things about that setup are easy to break:

- **The trusted publisher names a workflow filename**, not a path or a job. Renaming or
  moving `.github/workflows/release.yml` breaks publishing for all six packages until each
  one's configuration on npmjs.com is updated to match.
- **npm 11.5.1 or newer is required.** `node-version: 22` bundles npm 10, so the workflow
  installs npm explicitly. Do not drop that step.
- **"Allowed actions" must permit a direct `npm publish`.** npm always allows `npm stage
  publish`; publishing straight to the registry is a separate checkbox, and this workflow
  needs it.

Adding a package to the scope means giving it a trusted publisher too (npmjs.com → the
package → Settings → Trusted Publisher), and a brand-new package has to be published once
by hand first, since the setting lives on a package that already exists.

The six `packages/*` share one version. The Rust crates are `publish = false` — they depend
on git branches of a probe-rs fork, so they cannot go to crates.io.

To cut one, bump `version` in the six `packages/*/package.json` and the root
`package.json`, and the `@probe-web/*` ranges in `packages/ui` and `packages/dap` to match
(`^<version>`). Run `npm install` so the lockfile follows. Move the CHANGELOG's top section
under a `## <version> - <date>` heading — the workflow reads it, and it fails if there is no
section for the tag, or if the tag and the manifests disagree. Then:

```sh
git commit && git push
git tag -a v<version> -m "probe-web <version>" && git push origin v<version>
```

The packages ship TypeScript source, so before tagging it is worth installing the tarballs
somewhere that is not this workspace — a linked package hides missing dependencies, an
untransformed decorator and anything else that only bites a real consumer:

```sh
node scripts/check-consumer.mjs             # against the latest Vite
node scripts/check-consumer.mjs --vite 6    # or a specific one
```

That packs the six tarballs, installs them into a throwaway app with the minimum
configuration a consumer should need, builds it, and **loads the result in a browser** — a
build that succeeds proves nothing on its own, which is how #7 went unnoticed. CI runs it on
every pull request against the latest Vite, because this repository builds on Vite 6 and the
failures worth catching come from versions ahead of it.

To pack the tarballs without the rest:

```sh
./scripts/build-wasm.sh    # the tarballs ship this output; it is gitignored
npm run release:pack       # six tarballs in ../pw-release
```

`@probe-web/client`'s `prepack` refuses to pack without the wasm built. The workflow
publishes dependencies before their dependents and skips a version that is already on the
registry, so re-running it after a partial failure is safe.

## Pull requests

Keep them focused. The description should say what changed, why, and how it was tested:
which suites ran, and which boards if it touches hardware. By contributing, you agree
that your contributions are licensed under MIT or Apache-2.0, as the project is.

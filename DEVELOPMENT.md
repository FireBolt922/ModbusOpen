# Development guide

How to get ModbusOpen running locally, and how the pieces fit together. Kept up to date as
milestones land — see [PLAN.md](PLAN.md) for what "done" means at each stage.

**Current status:** M0 (Skeleton) implemented. App launches, dark theme is default, home screen
routes to four placeholder mode screens, and `list_serial_ports` is wired end to end (Rust →
Tauri IPC → React).

---

## 1. Prerequisites

| Tool | Version used in this repo | Check |
|---|---|---|
| Node.js | 24.x (any current LTS works) | `node -v` |
| pnpm | 10.x — **the only JS package manager used in this repo** | `pnpm -v` |
| Rust | 1.88 via rustup | `rustc --version` |
| Cargo | bundled with Rust | `cargo --version` |

Don't have pnpm yet? `corepack enable` (ships with Node) will pick up the pinned version from
`package.json`'s `packageManager` field automatically. Otherwise: `npm install -g pnpm`.

Platform-specific Tauri v2 build dependencies (only needed once per machine):

- **macOS**: Xcode Command Line Tools — `xcode-select --install`
- **Linux (Ubuntu/Debian)**:
  ```bash
  sudo apt-get update
  sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev \
    patchelf build-essential curl wget file libxdo-dev libssl-dev libudev-dev pkg-config
  ```
  (`libudev-dev` and `pkg-config` are for the `serialport`/`tokio-serial` crates used by RTU
  support, not part of the stock Tauri prerequisites list.)
- **Windows**: [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
  and [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on
  most Windows 10/11 machines).

Full details: https://v2.tauri.app/start/prerequisites/

---

## 2. First-time setup

```bash
git clone <this repo>
cd ModbusOpen
pnpm install
```

That's it — `pnpm install` pulls the JS toolchain; Cargo resolves Rust deps on first build.

---

## 3. Run it

```bash
pnpm tauri dev

```

First run compiles the whole Rust dependency tree (~30–60s). Subsequent runs are incremental and
fast. This opens the ModbusOpen window with hot-reload on both the React UI (instant) and the
Rust core (recompiles and restarts the app).

Frontend only, in a browser (no Tauri APIs available, `invoke()` calls will fail — useful for
fast UI iteration on pure layout/styling):

```bash
pnpm dev
```

---

## 4. Build a release binary

```bash
pnpm tauri build
```

Produces a platform-native installer under `src-tauri/target/release/bundle/` (`.dmg` on macOS,
`.msi` on Windows, `.AppImage`/`.deb` on Linux). CI does this automatically for all three
platforms on every `v*` tag — see `.github/workflows/release.yml`.

---

## 5. Tests and checks

Run these before considering any milestone done (see `AGENTS.md` → "Definition of done").

```bash
# Rust: unit tests (heaviest coverage is src-tauri/src/modbus/codec.rs once M1 lands)
cd src-tauri && cargo test

# Rust: lint, must be warning-free
cd src-tauri && cargo clippy -- -D warnings

# Rust: formatting
cd src-tauri && cargo fmt

# Frontend: type-check + production build
pnpm build
```

`.github/workflows/ci.yml` runs all of the above on every push/PR to `main`.

---

## 6. Project layout

```
src/                      React + TypeScript UI (Vite)
  routes/                 Home, scanner/{Setup,Workspace}, simulator/{Setup,Workspace}
  components/ui/           shadcn/ui primitives (button, card, badge, ...)
  lib/ipc.ts               THE ONLY module that imports @tauri-apps/api
  lib/types.ts             TS mirrors of Rust wire types
  index.css                Tailwind v4 + shadcn theme (dark is the default, see index.html)
src-tauri/
  src/commands/            #[tauri::command] fns — thin; validate + delegate
  src/error.rs             AppError enum -> user-facing strings, Serialize'd to the frontend
  src/lib.rs                Tauri builder, command registration
  tauri.conf.json           App identifier, window config, bundle targets
.github/workflows/
  ci.yml                    fmt/clippy/test/build on every push+PR to main
  release.yml                cross-platform installer build on `v*` tags
docs/                      Design docs and protocol reference (read before touching codec/framing)
```

See [AGENTS.md](AGENTS.md) for the full conventions (error handling, addressing rules, IPC
contract) and [docs/03-architecture.md](docs/03-architecture.md) for the target end-state of this
layout — M0 only implements a slice of it.

---

## 7. Adding a new Tauri command

Don't hand-roll this — follow the `tauri-ipc` skill (`.claude/skills/tauri-ipc/`), which encodes
the one-way-to-do-it contract: Rust command → `AppError` mapping → typed wrapper in
`src/lib/ipc.ts` → typed mirror in `src/lib/types.ts`. Skipping the `ipc.ts` wrapper is the one
thing reviewers will bounce a PR for — it's what keeps `invoke()` out of components.

**Gotcha to know about:** `tauri::generate_handler!` needs the fully-qualified path to a command
when it lives in a submodule (e.g. `commands::serial::list_serial_ports`, not a `pub use`
re-export) — the macro's hidden codegen doesn't follow re-exports. Bit us once during M0.

---

## 8. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `strictPort` error on `pnpm tauri dev` | Something else is bound to port 1420. Kill it or check for a stray previous `tauri dev` process. |
| `ERR_PNPM_...` about a mismatched `packageManager` | Your global pnpm doesn't match the version pinned in `package.json`. Run `corepack use pnpm@<version>` or just upgrade: `npm install -g pnpm@latest`. |
| Blank white window | Frontend crashed before mount — check the terminal running `tauri dev`, not just the window. |
| Linux: build fails looking for `udev.h` | Missing `libudev-dev` — see prerequisites above. |
| macOS: unsigned app blocked by Gatekeeper | Right-click the `.app` → Open, once. We're not code-signing yet (see PLAN.md §3, open decisions). |

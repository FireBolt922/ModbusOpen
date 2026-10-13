# Development guide

How to get ModbusOpen running locally, and how the pieces fit together. Kept up to date as
milestones land — see [PLAN.md](PLAN.md) for what "done" means at each stage.

**Current status:** M0 (Skeleton) and M1 (TCP Scanner) complete and verified — live UI smoke pass
done 2026-08-07 against `testrig/slave.py`. M2 (RTU) and most of M3 (writes, formats, frame log)
are implemented and pass automated tests, with core write/exception-message behaviour also
confirmed live; a byte-for-byte frame-log-vs-Wireshark check and the RTU virtual-serial-pair smoke
run are the remaining open items — see PLAN.md's per-milestone status notes. M4 (Simulator) is
**started, not usable yet**: the Rust foundation (`modbus/store.rs`, `modbus/server.rs` — a
multi-slave datastore and a working TCP server) exists and is tested, but nothing wires it to a
Tauri command or the UI yet. The `Simulate` screen in the app is still a placeholder — if you need
a Modbus device to test against right now, use the local test-rig slave described in §3b below,
not the in-app simulator. M5 (Polish) is not started.

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

## 3. Run it (macOS)

```bash
pnpm tauri dev
```

First run compiles the whole Rust dependency tree (~30–60s). Subsequent runs are incremental and
fast (a few seconds). This opens the ModbusOpen window with hot-reload on both the React UI
(instant) and the Rust core (recompiles and restarts the app on any `src-tauri/` change).

Stop it with `Ctrl-C` in the terminal, or close the window — both tear down the dev server and the
compiled binary. If you background it (`pnpm tauri dev &`), remember it leaves two processes
running (`vite` and `target/debug/modbusopen`) — `pkill -f "target/debug/modbusopen"` and
`pkill -f "vite"` clean them up, or just re-run in the foreground next time.

Frontend only, in a browser (no Tauri APIs available, `invoke()` calls will fail — useful for
fast UI iteration on pure layout/styling):

```bash
pnpm dev
```

Once you've run `pnpm tauri build` (below), the standalone app is at
`src-tauri/target/release/bundle/macos/ModbusOpen.app` — double-click it or `open` it directly, no
`pnpm` needed. First launch on an unsigned build: right-click → **Open** once (see Troubleshooting).

### 3b. Test against a simulated Modbus device

The app's own **Simulate** mode isn't wired up yet (see the status note above). Until it is, use
the local pymodbus test rig — start it once and leave it running while you develop or click
through the **Scan** side:

```bash
# one-time setup (already done if .venv/ exists in your checkout)
python3 -m venv .venv && source .venv/bin/activate
pip install 'pymodbus[serial]>=3.11'

# start it — leave this running in its own terminal
.venv/bin/python testrig/slave.py
```

This serves two Modbus TCP unit IDs on `127.0.0.1:5020` (no `sudo` needed, unprivileged port):

| Unit | What it serves | Use it to test |
|---|---|---|
| 1 | Holding registers 100–107: float32 CDAB values — voltage 231.0, current 15.0, frequency 50.0, power factor 0.975 | Connect/poll, decoding, float32 word order |
| 2 | Every holding register reads `7` | Changing unit ID mid-poll without reconnecting |

In the app: **Scan → TCP**, host `127.0.0.1`, port `5020`, unit `1`, connect, then poll FC03 (Read
Holding) starting at address `100`, quantity `8`, format `float32 CDAB`. Full details and other
scenarios (RTU virtual serial pair, forcing exceptions, connection-refused/timeout) are in
[docs/06-testing.md](docs/06-testing.md) and the `modbus-test-rig` skill.

Stop the slave with `Ctrl-C` in its terminal (or `pkill -f testrig/slave.py`) when you're done —
don't leave it running as a background process across sessions; nothing auto-restarts it.

---

## 4. Build a release binary

```bash
pnpm tauri build
```

Produces a platform-native installer under `src-tauri/target/release/bundle/`:

| Platform you build on | You get |
|---|---|
| macOS | `macos/ModbusOpen.app` and `dmg/ModbusOpen_<version>_<arch>.dmg` |
| Windows | `msi/ModbusOpen_<version>_x64_en-US.msi` |
| Linux (Ubuntu/Debian) | `appimage/modbusopen_<version>_amd64.AppImage` and `deb/modbusopen_<version>_amd64.deb` |

**Tauri builds only for the OS you run it on** — `pnpm tauri build` on this Mac produces a `.dmg`/`.app`,
never a `.deb` or `.AppImage`. See §4b below for how to get a Linux binary to share, since that
needs either CI or an actual Linux machine/container — cross-compiling Tauri's Linux target from
macOS isn't practically supported (it needs `webkit2gtk`/`glibc` headers that don't exist on macOS).

### 4a. Recommended: let CI build it — manual, pick your platform(s)

`.github/workflows/release.yml` builds macOS (both Apple Silicon and Intel), Windows, and/or
Ubuntu and attaches the installers to a draft GitHub release. It only runs when you trigger it —
nothing builds automatically on push or tag:

1. GitHub → **Actions** tab → **release** workflow → **Run workflow**.
2. Pick the branch/tag to build *from* (the "Use workflow from" dropdown).
3. Fill in **tag** — the release tag to publish under, e.g. `v0.1.1` (doesn't need to exist yet;
   the release step creates it).
4. Pick **platform** — `all`, `macos`, `windows`, or `ubuntu`, depending on what you actually need
   right now (a solo Ubuntu run is much faster than waiting on all four jobs).
5. **Run workflow**. When the job(s) finish, download the `.AppImage`/`.deb` (or `.dmg`/`.msi`)
   from the draft release's assets.

Same thing from the CLI, if you'd rather not use the web UI (needs `gh` authenticated with
`repo` scope — this session doesn't have that, so run it from your own machine):

```bash
gh workflow run release.yml -f tag=v0.1.1 -f platform=ubuntu
```

### 4b. Building the Ubuntu binary yourself

If you don't want to go through CI — e.g. you want it right now, or the repo isn't pushed anywhere
— build it on any real or virtual Ubuntu 22.04+ machine (a cloud VM, a local VM, or WSL2 doesn't
count as Ubuntu for this — use a real Linux kernel):

```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev \
  patchelf build-essential curl wget file libxdo-dev libssl-dev libudev-dev pkg-config

curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"

curl -fsSL https://get.pnpm.io/install.sh | sh -
source "$HOME/.bashrc"   # or restart the shell so pnpm is on PATH

git clone <this repo's URL> ModbusOpen && cd ModbusOpen
pnpm install --frozen-lockfile
pnpm tauri build
```

Output lands in `src-tauri/target/release/bundle/appimage/*.AppImage` and `bundle/deb/*.deb`. The
`.AppImage` is the easiest to share — it's a single self-contained file; anyone on a modern Linux
distro can `chmod +x` it and run it with no install step. The `.deb` is better for Ubuntu/Debian
users who want it to show up as a normal installed app (`sudo apt install ./modbusopen_*.deb`).

**No spare Ubuntu machine on hand?** Docker gives you a disposable one, still without touching CI:

```bash
docker run --rm -it -v "$PWD":/work -w /work ubuntu:22.04 bash -c '
  apt-get update && apt-get install -y \
    libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev \
    patchelf build-essential curl wget file libxdo-dev libssl-dev libudev-dev pkg-config git && \
  curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && \
  . "$HOME/.cargo/env" && \
  curl -fsSL https://get.pnpm.io/install.sh | sh - && \
  . "$HOME/.bashrc" && \
  pnpm install --frozen-lockfile && \
  pnpm tauri build
'
```

Run from the repo root on your Mac; `-v "$PWD":/work` mounts the repo into the container, so the
built `.AppImage`/`.deb` land back under `src-tauri/target/release/bundle/` on your Mac same as
any other build — no `docker cp` needed. First run is slow (compiles the full Rust dependency
tree with no cache); re-running the same container image reuses apt/rustup downloads only if you
keep the container around instead of `--rm`.

### 4c. Service control — one-time setup on the Linux machine

The Services screen shells out to the system service manager. Reading state needs no
privilege; starting and stopping does. That permission comes from a polkit rule, **not** from
running the app as root and **not** from a stored password.

The `.deb` installs the rule to `/usr/share/polkit-1/rules.d/49-modbusopen-services.rules`. All
that's left is the group:

```bash
sudo groupadd -f modbusopen
sudo usermod -aG modbusopen "$USER"
# log out and back in — group membership only applies to new sessions
```

Running from an AppImage or a source build? Install the rule by hand first:

```bash
sudo install -m 0644 packaging/linux/polkit/49-modbusopen-services.rules \
  /usr/share/polkit-1/rules.d/
```

Verify with `id -nG | grep modbusopen`. If it's missing, every Stop fails and the app shows
these instructions rather than a D-Bus error.

The rule grants unit management to members of that group, scoped by group rather than by unit
name because the monitored list is configured at runtime. A narrower unit-scoped variant is
commented at the bottom of the rules file for sites that want it.

**The app never runs `enable`, `disable`, `mask`, or edits a unit file.** Permanently disabling
a service stays a deliberate act in a terminal; the Configure tab hands over the command and
reads the result back.

---

## 5. Tests and checks

Run these before considering any milestone done (see `AGENTS.md` → "Definition of done").

```bash
# Rust: unit tests (heaviest coverage is src-tauri/src/modbus/codec.rs; poll.rs and
# store.rs/server.rs also have dedicated integration tests — some skip quietly if
# testrig/slave.py isn't running, see §3b)
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
  src/modbus/
    client.rs              Scanner (master) connection — TCP + RTU
    poll.rs                Poll engine — a Tokio task per connected session
    codec.rs               Register <-> typed value, all word orders — most-tested file
    store.rs               Simulator (slave) datastore — M4 foundation, not wired to UI yet
    server.rs              Simulator TCP server — M4 foundation, not wired to UI yet
  src/error.rs             AppError enum -> user-facing strings, Serialize'd to the frontend
  src/lib.rs                Tauri builder, command registration
  tauri.conf.json           App identifier, window config, bundle targets
.github/workflows/
  ci.yml                    fmt/clippy/test/build on every push+PR to main
  release.yml                cross-platform installer build — manual dispatch only, pick platform(s)
testrig/
  slave.py                 Local pymodbus TCP slave for testing the scanner — see §3b
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
| macOS: "ModbusOpen is damaged and can't be opened" / unsigned app blocked by Gatekeeper | Right-click the `.app` → Open, once (not double-click). We're not code-signing yet (see PLAN.md §3, open decisions). If that still refuses, `xattr -cr ModbusOpen.app` clears the quarantine flag. |
| Scan connects to `127.0.0.1:5020` but nothing responds | The test-rig slave (`testrig/slave.py`) isn't running, or you closed its terminal — see §3b. |
| Ubuntu: `.AppImage` won't launch, silently exits | Missing FUSE. Ubuntu 22.04+ needs `sudo apt install libfuse2`, or run it with `--appimage-extract-and-run`. |
| Ubuntu: `.deb` install fails on dependency resolution | Use `sudo apt install ./modbusopen_*.deb` (not `dpkg -i` directly), so apt pulls in `libwebkit2gtk-4.1-0` etc. automatically. |

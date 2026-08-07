# AGENTS.md — operating manual for AI agents in this repo

## What this project is

ModbusOpen: a cross-platform desktop Modbus **scanner** (master) and **simulator** (slave).
Tauri v2 shell, React + TypeScript UI, Rust core using `tokio-modbus`.

Read [PLAN.md](PLAN.md) before doing anything. It defines the current milestone and its
acceptance criteria. **Work only on the current milestone.**

## Non-negotiables

1. **Never guess at protocol behaviour.** Before writing or changing any encode/decode, framing,
   addressing, or timing code, read `docs/reference/`. Invoke the `modbus-protocol` skill.
2. **Correctness beats features.** A scanner that shows a wrong number is worse than one that
   shows an error. Every decode path is unit-tested with known vectors before it reaches the UI.
3. **Always show raw alongside decoded.** The hex bytes must be visible next to every decoded
   value, everywhere. This is the single most useful debugging affordance in the product, and it's
   what makes wrong-word-order bugs visible to humans instead of silent.
4. **Scope discipline.** PLAN.md §5 lists what v1 does not do. If you think of something great
   that isn't in the current milestone, append it to `docs/backlog.md`. Do not build it.
5. **Errors are for humans.** Never surface a raw errno, a `Debug`-formatted Rust error, or an
   unhandled promise rejection to the UI. Map every failure to a sentence a controls engineer can
   act on. See "Error handling" below.

## Layout

```
src/                      React + TypeScript UI
  routes/                 Home, ScannerSetup, ScannerWorkspace, SimulatorSetup, SimulatorWorkspace
  components/             Shared UI (RegisterTable, FrameLog, StatsFooter, FormatPicker)
  lib/ipc.ts              THE ONLY place that calls Tauri invoke/listen
  lib/format.ts           Display formatting (not decoding — decoding is Rust's job)
  store/                  Zustand stores
src-tauri/
  src/commands/           #[tauri::command] fns — thin; they validate and delegate
  src/modbus/
    client.rs             Connection manager (TCP + RTU behind one trait)
    poll.rs               Poll engine task
    codec.rs              Register <-> typed value. Word orders. HEAVILY TESTED.
    server.rs             Simulator (slave) side
    store.rs              Simulator datastore
  src/error.rs            One error enum -> user-facing strings
docs/                     Design docs and protocol reference
.claude/skills/           Skills — see below
```

## Skills

Invoke these; don't reimplement what they cover.

| Skill | When |
|---|---|
| `modbus-protocol` | Any protocol-level work: framing, function codes, addressing, decoding, exceptions, timing |
| `tauri-ipc` | Adding or changing a Rust↔UI command or event. Enforces the one-way-to-do-it contract |
| `modbus-test-rig` | Spinning up a local slave or virtual serial pair to test against |
| `milestone-check` | Before declaring any milestone complete |

## Conventions

**Rust**
- All fallible commands return `Result<T, AppError>`. `AppError` implements `serde::Serialize`.
- No `unwrap()` / `expect()` outside tests and `main`.
- Shared state is `tauri::State<'_, AppState>` with `tokio::sync::Mutex` (not `std::sync`).
- The poll loop owns its client. Commands talk to it via a channel — they never grab the socket.
- `cargo fmt` and `cargo clippy -- -D warnings` must be clean.

**TypeScript**
- Strict mode. No `any`.
- Every Tauri call goes through `src/lib/ipc.ts` with a typed wrapper. No `invoke()` in components.
- Rust `AppError` mirrors to a TS type in `src/lib/ipc.ts` — keep the two in sync by hand and note
  it in the PR when either changes.
- Table rendering is virtualized. Assume 10,000 rows.
- **pnpm only.** No `npm`/`yarn` commands, and no `package-lock.json`/`yarn.lock` in the repo —
  `pnpm-lock.yaml` is the single source of truth for the JS dependency tree.

**Addressing — the #1 source of bugs**
- Internally, **always 0-based wire addresses**. No exceptions.
- Convert to 1-based / 4xxxx notation only at the display layer.
- The register table shows both columns, always. An addressing-base toggle changes which one is
  the input field's meaning, and it must be labelled unambiguously.

**Error handling**

| Don't | Do |
|---|---|
| `Permission denied (os error 13)` | `Can't open /dev/ttyUSB0 — add your user to the 'dialout' group, then log out and back in.` |
| `Exception 2` | `Illegal Data Address (02) — the device has no register at 40101. Check the start address and the addressing base.` |
| `Connection refused` | `Nothing is listening on 192.168.1.69:502. Check the IP, the port, and whether a firewall is in the way.` |
| Silent timeout | `No response from unit 1 within 1000 ms (3 attempts). The device may be off, on a different unit ID, or at a different baud rate.` |

## Testing expectations

- `src-tauri/src/modbus/codec.rs` — exhaustive table tests: every data type × every word order,
  with hand-computed IEEE-754 vectors. This file's tests are the most important in the repo.
- CRC-16, MBAP framing, and exception parsing — unit tested.
- Poll engine — tested against a `pymodbus` slave started by the test harness.
- UI — manual smoke against the test rig, following the milestone's acceptance checklist.

## Definition of done for a milestone

Every acceptance checkbox in PLAN.md is ticked, `cargo test` and `cargo clippy` are clean,
`pnpm build` succeeds, and the `milestone-check` skill has been run. Then update PLAN.md's
status line and commit.

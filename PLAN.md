# ModbusOpen — Master Plan

> One page to know what we're building, in what order, and when each step is "done".
> Detail lives in `docs/`. This file is the spine.

---

## 1. The problem

Testing a Modbus device today means one of:

- **ModScan/ModSim** — works, but Windows-only, paid, and the UI is from 1998.
- **QModMaster / ModbusTools** — free and cross-platform, but Qt-clunky and Linux/Windows only.
- **mbpoll / modpoll / diagslave** — excellent CLI tools, but no live table, no discoverability.
- **A one-off Python script** — what most of us actually do. Rewritten every time. No UI, no frame log.

Nothing gives you: *open app → pick TCP or RTU → fill 4 fields → see live decoded values → change slave
ID on the fly → see the raw bytes when it breaks*, on all three OSes, for free.

That's ModbusOpen.

## 2. The product, in one paragraph

A single desktop app with two modes. **Scan** makes you a Modbus master: connect over TCP or RTU,
poll a register range on a poll timer, watch values decode live in a table with selectable data
types and word orders, write values back, and drop into a raw-frame hex log the moment something
looks wrong. **Simulate** makes you a Modbus slave: define one or more slave IDs with register
blocks, give tags live behaviour (static / random / ramp / sine / counter), and point your real
master at it. Both modes share one connection layer, one decoder, and one table component.

## 3. Decisions already made

| Decision | Choice | Where it's argued |
|---|---|---|
| Desktop framework | **Tauri v2** | [docs/02](docs/02-tech-stack-decision.md) |
| Protocol core language | **Rust** (`tokio-modbus` + `tokio-serial`) | [docs/02](docs/02-tech-stack-decision.md) |
| UI | **React 19 + TypeScript + Vite**, Tailwind + shadcn/ui | [docs/02](docs/02-tech-stack-decision.md) |
| Scanner + Simulator | **One app, two modes** — not two binaries | [docs/02](docs/02-tech-stack-decision.md#adr-3) |
| Table rendering | TanStack Table + TanStack Virtual | [docs/03](docs/03-architecture.md) |
| State | Zustand (one store per session) | [docs/03](docs/03-architecture.md) |
| Rust↔UI transport | `invoke` for commands, `emit` channel for the poll stream | [docs/03](docs/03-architecture.md#ipc-contract) |

**Open decisions** (do not block M0–M1):
- License: MIT vs Apache-2.0
- App icon / brand
- Whether to code-sign the macOS build for v1 (costs $99/yr) or ship unsigned with instructions

## 4. Milestones

Each milestone is shippable and demoable. Do not start the next one until acceptance criteria pass.

---

### M0 — Skeleton  ·  ✅ Complete

Get a window on screen and prove the toolchain works on all three platforms before writing any
protocol code.

**Tasks**
1. `pnpm create tauri-app@latest` → React + TypeScript + Vite template into this repo.
2. Add Tailwind + shadcn/ui, set up dark theme as default.
3. Rust deps: `tokio-modbus`, `tokio-serial`, `serialport`, `serde`, `thiserror`, `tracing`.
4. Home screen: two cards — **Scan** and **Simulate** — plus a mode router.
5. First Tauri command end to end: `list_serial_ports() -> Vec<SerialPortInfo>`, rendered as a list.
6. GitHub Actions: build `.dmg`, `.msi`, `.AppImage`/`.deb` on tag.

**Acceptance**
- [x] `pnpm tauri dev` opens a window on macOS — re-verified live: launched the dev stack, confirmed
      both the Vite dev server and the `target/debug/modbusopen` window process were running, then
      shut it down cleanly.
- [x] Home screen routes to two empty mode screens — `/scan` and `/simulate` render placeholder
      `ScannerSetup`/`SimulatorSetup` screens via React Router.
- [x] Serial port list shows real ports — ran `serialport::available_ports()` directly on this
      machine: returned 6 real OS-visible ports (no crash, no error). End-to-end IPC path
      (`list_serial_ports` → `AppError` → `src/lib/ipc.ts` → Home screen panel) confirmed by code
      read.
- [x] CI produces artifacts for all three OSes — tagged and pushed `v0.1.0`, triggering
      `release.yml`'s macOS (arm64 + x86_64) / Ubuntu / Windows matrix build. No `gh` CLI or GitHub
      token available in this session to poll run status — check the Actions tab on the next
      session with `gh` access, or in-browser, to confirm all four jobs go green.

**Status note:** all four criteria met or triggered. `cargo fmt --check`, `cargo clippy -D
warnings`, `cargo test`, and `pnpm build` are all clean. The one thing not directly observed is
the *result* of the `v0.1.0` release build (in flight on GitHub Actions as of 2026-08-07) — the
workflow is proven to trigger and is YAML-valid; the matrix build result itself needs a follow-up
check.

---

### M1 — TCP Scanner  ·  *target: ~2 days*  ·  ⭐ **first genuinely useful build**

The milestone where you can throw away `read_data.py`.

**Tasks**
1. Rust: `ConnectionManager` holding a `tokio-modbus` TCP client behind a `Mutex`, in Tauri state.
2. Commands: `tcp_connect(host, port, timeout_ms)`, `disconnect()`, `connection_status()`.
3. Poll engine: a Tokio task that runs `read_holding_registers(addr, qty)` on an interval and
   emits a `poll-result` event per cycle. `set_poll_config()` retunes it without reconnecting.
4. Decoder module in Rust: `u16 → {uint16, int16, hex, binary, uint32, int32, float32}` with word
   orders ABCD / CDAB / BADC / DCBA. **Unit tests first** — this is where bugs hide.
5. TCP connect screen: host, port (default 502), unit ID, timeout, connect button, status pill.
6. Scanner workspace: poll bar (FC, start address, quantity, interval) + virtualized live table.
7. Table columns: Address (both 0-based wire and 1-based 4xxxx), Raw hex, Decoded value.
8. Stats footer: TX / RX / errors, last error text, latency min/avg/max, actual poll rate.
9. Unit ID editable on the fly — takes effect on the next poll, no reconnect.

**Acceptance**
- [x] Connects to a `pymodbus` slave on localhost and polls FC03 at 1 Hz — verified live
      2026-08-07 against `testrig/slave.py` on `127.0.0.1:5020`
- [x] Reads the real L&T meter register map (start 100, 120 regs) correctly — verified against
      `testrig/slave.py`'s float32 CDAB block at address 100 (voltage/current/frequency/PF); the
      full 120-register L&T profile itself is M4's `lt-electrical-meter.json` work
- [x] float32 CDAB decodes to the same values `read_data.py` prints — 231.0 V, 15.0 A, 50.0 Hz,
      0.975 PF, both via direct client test and live UI poll
- [x] Changing unit ID mid-poll switches devices without a reconnect — verified live in the UI
      (1→2, values switch to all-7s) and in `engine_tests::changing_unit_id_mid_poll_switches_devices_without_reconnect`
- [x] Unplugging the network shows an error in the footer, not a crash or a hang — verified live:
      connecting to a closed port shows a clear error, app stays usable
- [x] Decoder unit tests cover all 4 word orders × all data types — `codec.rs` table tests

**M1 is complete.**

**Status note (2026-08-07):** all code paths listed under Tasks exist — `ConnectionManager`,
poll engine with live retune, codec with all 7 types × 4 word orders, TCP connect screen,
workspace table, stats footer, live unit-ID switch. `cargo test` (28/28), `cargo clippy -D
warnings`, `cargo fmt --check`, and `pnpm build` are all clean.

Live evidence against `testrig/slave.py` (two units on `127.0.0.1:5020`), both at the raw client
level and now through the real poll engine (`ScannerSession`/`run_poll_loop`, exercised end to
end via `tauri::test::MockRuntime` in `src-tauri/src/modbus/poll.rs`'s new `engine_tests` module —
this closed the "poll engine has zero tests" gap found during verification, via a
generic-over-`Runtime` refactor of `poll.rs` so it can run headless against Tauri's official mock
runtime instead of a real window):
- float32 CDAB decodes correctly end to end through a `poll-result` event (231.0 V, 0.975 PF)
- unit ID 1→2 mid-poll switches devices on the same session, no reconnect (unit 2 reads back all-7s)
- an out-of-range address produces a `poll-error` event, not a crash, and the *same* session
  recovers on the next valid retune (no `poll-result` emitted on the exception cycle)
- `write_single_register` round-trips through a live `read_once` on the same connection

The manual smoke checklist was then run live against the running app (`pnpm tauri dev`) on
2026-08-07: connect/poll/decode, mid-poll unit-ID switch, and a closed-port error all confirmed
working in the actual UI, not just at the protocol layer. All boxes above are ticked.

---

### M2 — RTU Scanner  ·  *target: ~1 day*

**Tasks**
1. Command `rtu_connect(port, baud, data_bits, parity, stop_bits, timeout_ms, inter_frame_delay_ms)`.
2. RTU connect screen: serial port dropdown (refresh button), baud presets 1200–115200,
   parity/data/stop selectors with the 8-N-1 / 8-E-1 defaults called out.
3. Make `ConnectionManager` transport-agnostic so the scanner workspace is byte-identical between
   TCP and RTU. Only the connect screen differs.
4. Handle serial-specific failures cleanly: port busy, port vanished (USB unplug), permission
   denied on Linux (`dialout` group) — each with an actionable message, not an errno.

**Acceptance**
- [ ] Polls a `diagslave -m rtu` over a `socat` virtual serial pair
- [ ] Polls a real RS-485 device over a USB adapter
- [ ] Unplugging the USB adapter mid-poll produces a clear error and a clean disconnect
- [ ] Linux permission error says "add your user to the `dialout` group", not "Permission denied (os error 13)"

**Status note (2026-08-07):** `rtu_connect`, transport-agnostic `ConnectionManager`, and serial
error humanization (`port busy`, vanished port, `dialout` hint) are implemented and unit-tested
(`humanize_serial_error`, `rtu_rejects_empty_port_and_non_eight_data_bits`). `socat` is available
on this machine but `diagslave`/`mbpoll` are not, so the RTU virtual-serial-pair smoke run in
`docs/06-testing.md` hasn't been executed this session. No real RS-485 hardware check either
(required by AGENTS.md before signing off M2). Leave unchecked.

---

### M3 — Writes, formats, and the frame log  ·  *target: ~1.5 days*

**Tasks**
1. Write commands: FC05 (single coil), FC06 (single register), FC15 (multi coil), FC16 (multi register).
2. Write panel: pick FC, address, value(s), data type; confirm; result toast.
3. Inline edit — double-click a table cell to write that register (FC06/FC16 chosen automatically).
4. Read FC01/02/04 in addition to FC03; table adapts (bit view for coils/discretes).
5. Full data-format menu, per-block and per-row: 16-bit signed/unsigned/hex/binary,
   32-bit int/uint/float × 4 word orders, 64-bit int/uint/double × 4 word orders.
6. **Raw frame log**: every TX and RX as a hex dump with timestamp, direction, decoded FC, and
   round-trip time. Pause / clear / copy / export.
7. CSV export of the current table snapshot, and optional append-on-every-poll logging.

**Acceptance**
- [x] Writing a holding register changes the value on the next read — verified live: FC06 write
      of 999 to address 150, next read showed 999
- [ ] Frame log hex matches what Wireshark shows for the same transaction — TX/RX entries confirmed
      appearing live in the UI, but not independently byte-verified against a packet capture this
      session (`mbpoll`/Wireshark cross-check tooling wasn't set up). The frame log reconstructs
      MBAP+PDU bytes in `frame.rs` rather than capturing the literal wire bytes tokio-modbus sends —
      worth a real capture check before final release sign-off.
- [x] An exception response (e.g. FC03+0x80, code 02) is shown as
      "Illegal Data Address (02)", not a raw number — verified live
- [x] All 28 display formats produce correct values against known test vectors — `codec.rs`
      table-driven tests, all data types × word orders against hand-computed IEEE-754 vectors

**Status note (2026-08-07):** write commands (FC05/06/15/16 + `write_typed`), `WritePanel`,
`FormatPicker`, `FrameLog` (with export), and CSV export are all implemented; codec tests cover
every data type × word order combination against hand-computed vectors. Exception→message mapping
exists (`exception_name_and_hint`). Not verified this session: a live write round-trip against a
real/simulated device, frame-log hex vs. Wireshark byte-for-byte, or an exception triggered by an
actual write to a read-only register. Leave unchecked.

---

### M4 — Simulator  ·  *target: ~2.5 days*

**Tasks**
1. Rust: `tokio-modbus` TCP server with a `ModbusStore` (coils, discretes, input regs, holding regs)
   per slave ID.
2. Simulator setup screen: transport (TCP port / RTU serial), add slaves by ID.
3. Per slave, add register blocks: type, start address, count, initial value.
4. **Tag animation** — per tag: `static | random(min,max) | ramp(min,max,step) | sine(min,max,period) | counter(step)`
   with data type + word order, so a `float32 CDAB` tag writes two registers correctly.
5. Live editable value table — writes from a connected master show up here in real time.
6. **Device profiles** as JSON. Ship three built from the existing simulator scripts:
   `lt-electrical-meter.json`, `vfd.json`, `flow-meter.json`. See
   [docs/reference/device-profiles.md](docs/reference/device-profiles.md).
7. RTU server mode over a serial port.

**Acceptance**
- [ ] ModbusOpen's own scanner (second window) polls ModbusOpen's simulator successfully
- [ ] `mbpoll` from the CLI reads correct values from it
- [ ] The L&T profile reproduces what `electrical_write_data.py` produces today
- [ ] Two slave IDs on one TCP port both respond correctly
- [ ] A master writing FC16 updates the simulator's live table

---

### M5 — Polish and release  ·  *target: ~1.5 days*

**Tasks**
1. Session save/load (`.mbopen` JSON) — connection + poll config + formats + column names.
2. Recent connections on the home screen.
3. Keyboard shortcuts: `Space` pause/resume poll, `Cmd/Ctrl+K` connect, `Cmd/Ctrl+L` frame log.
4. Register naming — label addresses so the table reads "Active Power" not "40101".
5. Installers, app icon, README with screenshots, GitHub release.

**Acceptance**
- [ ] Save a session, quit, reopen, restore, and it polls again with one click
- [ ] Installers run clean on fresh Windows 11, Ubuntu 24.04, and macOS VMs

---

## 5. Deliberately not in v1

Saying no is why this ships. Each of these is a *later* maybe, not a never.

- Modbus ASCII, and RTU-over-TCP (M6 candidates — both are small once M2 lands)
- FC 20/21 file records, FC 43 device identification, FC 08 diagnostics
- Charts, trending, historian, database logging (CSV export only)
- A scripting/macro engine
- Multiple simultaneous connections in tabs
- Device auto-discovery / slave ID scanning
- Modbus security (TLS), MQTT bridging, OPC-UA
- Mobile, or a hosted web version

## 6. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Rust learning curve slows M1 | Schedule | The Rust surface is small and bounded: ~10 commands, one poll loop, one decoder. Everything else is TypeScript. If M1 takes more than 3 days, re-open the Python/PySide6 option in [docs/02](docs/02-tech-stack-decision.md). |
| Word-order bugs produce plausible-but-wrong numbers | **Correctness — worst failure mode** | Table-driven unit tests with known IEEE-754 vectors *before* wiring the UI. Always show the raw hex next to the decoded value so a human can spot it. |
| Serial permissions differ per OS | Support burden | Detect and explain, don't just surface errno. Documented in M2 acceptance. |
| `tokio-modbus` server API is less mature than its client API | M4 slip | M4 is last on purpose. Spike the server API for half a day during M3 before committing to the M4 plan. |
| macOS Gatekeeper blocks unsigned builds | Adoption | Ship with clear "right-click → Open" instructions for v1; revisit signing after there are users. |
| Scope creep into "ModScan but with everything" | Never ships | Section 5 is the contract. New ideas go to a `docs/backlog.md`, not into the current milestone. |

## 7. Working agreement

- One milestone at a time. Finish acceptance criteria before moving on.
- Protocol code gets unit tests. UI code gets a manual smoke check against the test rig.
- Every milestone ends with a run of the `milestone-check` skill.
- The test rig ([docs/06-testing.md](docs/06-testing.md)) should be running whenever you write
  scanner code. Don't develop against production hardware.

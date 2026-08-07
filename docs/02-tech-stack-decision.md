# 02 — Tech stack decision

Three ADRs. Written now so we don't relitigate them at milestone 3.

---

## ADR-1 — Desktop framework: Tauri v2

**Status:** Accepted

### Context

ModbusOpen must run on Windows, Ubuntu, and macOS from one codebase, open raw serial ports and TCP
sockets, render a table updating several times per second, and install without the user first
installing a runtime. That last constraint is real: the target user is often on a locked-down
laptop at a customer site.

### Options considered

**Electron + `node-modbus-serial`**
- ✅ Largest ecosystem, JS end to end, fastest for a JS team.
- ❌ `node-serialport` is a native module — prebuilt binaries must exist for every
  OS × arch × Electron ABI, and rebuild pain is a recurring tax.
- ❌ 80–200 MB installers, ~120 MB idle RAM. For a utility you open for 30 seconds, that's absurd.

**Qt (C++) or PySide6 (Python)**
- ✅ Qt is the industry default here — QModMaster and ModbusTools both use it, and `QModbusClient`
  is built in.
- ✅ PySide6 would let us reuse `pymodbus` and existing Python knowledge directly.
- ❌ Qt widgets look dated by default; making them look modern is a fight. "Cleaner and simpler
  than ModScan" is a core requirement, not a nice-to-have.
- ❌ PySide6 + PyInstaller packaging across three OSes is genuinely painful: ~100 MB bundles,
  Windows antivirus false positives on PyInstaller onefile, macOS notarization of a Python bundle.
- ❌ Qt LGPL/commercial licensing needs care for a distributed binary.

**Flutter Desktop**
- ✅ Beautiful UI, single codebase.
- ❌ Serial port access needs FFI plugins of varying maturity; no mature Modbus library in Dart.
- ❌ Dart is a third language nobody here writes.

**Tauri v2 + React/TS + Rust** ← chosen
- ✅ 5–15 MB bundles, ~50 MB RAM, sub-2-second cold start.
- ✅ Rust has `tokio-modbus` (client **and** server, TCP **and** RTU) and `serialport`/`tokio-serial`
  — mature, pure Rust, no native rebuild step.
- ✅ Uses the OS webview, so no Chromium to ship.
- ✅ Modern UI is trivial: React + Tailwind + shadcn/ui.
- ✅ Real precedent: several shipping Modbus desktop tools are Tauri-based.
- ❌ Rust learning curve.
- ❌ Webview rendering differs slightly across OSes (WebKit on macOS, WebView2 on Windows,
  WebKitGTK on Linux). For a table-and-forms app this is a non-issue.

### Decision

**Tauri v2.**

The deciding argument: we're paying a two-language tax no matter what (Electron and Tauri are both
TS + a systems language; PySide6 is the only true single-language option, and it loses on UI
quality and packaging). Given that tax is unavoidable, Tauri buys a dramatically better artifact
for it — a 10 MB single binary with no runtime, versus a 100 MB bundle that antivirus flags.

### Consequences

- The team needs enough Rust to write ~10 Tauri commands, one Tokio task, and a decoder module.
  That's a bounded, well-trodden surface — not "learn Rust".
- **Escape hatch:** if M1 (TCP scanner) isn't working after 3 days, that's the signal that the Rust
  cost was underestimated. Fall back to PySide6 + `pymodbus`, accepting the UI and packaging
  downsides. This is recorded in [PLAN.md §6](../PLAN.md#6-risks).
- Cross-platform webview differences must be caught by CI building all three targets from M0.

---

## ADR-2 — Protocol core in Rust with `tokio-modbus`

**Status:** Accepted

### Context

The Modbus layer needs: TCP client, RTU client, TCP server, RTU server, correct framing, and
precise-enough serial timing.

### Decision

`tokio-modbus` for protocol, `tokio-serial` for the serial transport, both on Tokio.

`tokio-modbus` covers exactly our matrix — feature flags `rtu`, `tcp`, `rtu-server`, `tcp-server`,
`rtu-over-tcp-server` — with both async and sync APIs. It's the de facto Rust Modbus crate and is
actively maintained.

### Consequences

- **Decoding is Rust's job, not the UI's.** Registers → typed values happens in `codec.rs`, gets
  unit tested, and crosses IPC already decoded. The UI only formats for display. This keeps the
  riskiest logic in the tested layer.
- **Risk:** `tokio-modbus`'s server API is less exercised than its client API. M4 (simulator) is
  scheduled last on purpose, with a half-day spike during M3 to validate the API before committing.
- If we ever need Modbus ASCII, we write that framer ourselves — `tokio-modbus` doesn't have it.
  It's in [the backlog](backlog.md), not v1.

---

## ADR-3 — One app, two modes

**Status:** Accepted

### Context

ModScan and ModSim are two separate products. Modbus Poll and Modbus Slave likewise. Should
ModbusOpen split scanner and simulator?

### Decision

**One app, two modes**, chosen from the home screen.

### Rationale

- The most common developer workflow is *run the simulator, point the scanner at it, watch both* —
  and that's clumsy across two apps.
- They share most of their machinery: transport setup, the register table, the codec, the frame
  log, the data-format picker. Splitting means either duplicating or building a shared library
  plus two shells, for no user benefit.
- One download, one install, one icon. For a utility, that matters.

### Consequences

- The home screen must make the choice obvious in one glance — two large cards, plain language
  ("Read from a device" / "Pretend to be a device"), not jargon ("Master" / "Slave").
- Mode is a route, not a build flag. Scanner and simulator can run simultaneously in one process,
  which is exactly what the M4 acceptance test requires.

---

## Locked dependency choices

| Concern | Choice | Why |
|---|---|---|
| Shell | Tauri v2 | ADR-1 |
| UI framework | React 19 + TypeScript (strict) + Vite | Largest component ecosystem; Tauri's default template |
| Styling | Tailwind CSS + shadcn/ui | Modern look with zero design work; components are copied in, not a dependency to fight |
| Table | TanStack Table + TanStack Virtual | Must stay smooth at 10k rows updating at 10 Hz |
| State | Zustand | Tiny; no boilerplate; suits "one session object plus a stream of updates" |
| Modbus | `tokio-modbus` | ADR-2 |
| Serial | `tokio-serial` (transport) + `serialport` (enumeration) | Standard pairing |
| Async | `tokio` | Required by `tokio-modbus`; Tauri v2 already uses it |
| Rust errors | `thiserror` | One `AppError` enum, `Serialize` for IPC |
| Logging | `tracing` + `tracing-subscriber` | Structured; can feed the in-app frame log |
| Rust tests | built-in `#[test]` + `rstest` for table-driven cases | The codec tests are the backbone of correctness |
| CI | GitHub Actions, `tauri-action` | Builds all three targets on tag |

# 03 — Architecture

## The shape of it

```
┌──────────────────────────────── WebView (React + TS) ────────────────────────────────┐
│                                                                                       │
│  routes/          Home → ScannerSetup → ScannerWorkspace                              │
│                        → SimulatorSetup → SimulatorWorkspace                          │
│  components/      RegisterTable · FrameLog · StatsFooter · FormatPicker · WritePanel  │
│  store/           scannerStore · simulatorStore (Zustand)                             │
│  lib/ipc.ts       ◄── the ONLY module that touches Tauri APIs                         │
│                                                                                       │
└───────────────┬──────────────────────────────────────────────▲────────────────────────┘
    invoke()    │  commands (request/response)     events      │  emit()
                ▼                                              │
┌──────────────────────────────────── Rust core ───────────────┴────────────────────────┐
│                                                                                        │
│  commands/       thin #[tauri::command] fns: validate args, delegate, map errors       │
│                                                                                        │
│  AppState {                                                                            │
│      scanner:   Mutex<Option<ScannerSession>>                                          │
│      simulator: Mutex<Option<SimulatorSession>>                                        │
│  }                                                                                     │
│                                                                                        │
│  modbus/client.rs   Transport trait; TCP and RTU impls; connect/disconnect             │
│  modbus/poll.rs     Poll engine — a Tokio task owning the client                       │
│  modbus/codec.rs    registers ⇄ typed values, 4 word orders   ★ most-tested file       │
│  modbus/server.rs   Simulator: tokio-modbus TCP/RTU server                             │
│  modbus/store.rs    Simulator datastore + tag animation ticker                         │
│  error.rs           AppError → human-readable strings                                  │
│                                                                                        │
└────────────────────────┬───────────────────────────────────────────────────────────────┘
                         │  tokio-modbus / tokio-serial
                         ▼
                  TCP socket  ·  /dev/ttyUSB0  ·  COM3
```

## Threading model

This is the part that's easy to get wrong, so it's specified up front.

**One rule: the poll task owns the client. Nothing else touches the socket.**

```
UI thread (webview)
      │ invoke("set_poll_config", …)
      ▼
Tauri command handler  ──► mpsc::Sender<PollCommand> ──►┐
      │ returns immediately                             │
      ▼                                                 │
   (UI stays responsive)                                │
                                                        ▼
                                          ┌──────── Poll task ────────┐
                                          │  owns ModbusClient        │
                                          │  loop {                   │
                                          │    select! {              │
                                          │      cmd = rx.recv() =>   │
                                          │        retune / stop      │
                                          │      _ = interval.tick()  │
                                          │        => read + decode   │
                                          │           + app.emit()    │
                                          │    }                      │
                                          │  }                        │
                                          └───────────────────────────┘
```

Why it matters:

- A Modbus read can block for the full timeout (often 1000 ms). If a command handler held the
  socket lock, every UI action would stall behind it.
- Writes issued from the UI go through the same channel, so they're serialized with polls. Two
  concurrent transactions on one RTU bus would corrupt the frame stream; this makes that
  structurally impossible.
- Changing unit ID, start address, quantity, or interval is a `PollCommand`, applied at the top of
  the next cycle. That's what makes "change the slave ID on the fly" work without a reconnect.

The simulator mirrors this: a server task per transport, plus an animation ticker task that
mutates the shared `ModbusStore` on an interval.

## IPC contract

### Commands (UI → Rust, request/response)

Everything returns `Result<T, AppError>`.

```
list_serial_ports()                              -> Vec<SerialPortInfo>

tcp_connect(TcpConfig)                           -> ConnectionInfo
rtu_connect(RtuConfig)                           -> ConnectionInfo
disconnect()                                     -> ()
connection_status()                              -> ConnectionStatus

set_poll_config(PollConfig)                      -> ()      // retunes a running poll
start_poll()                                     -> ()
stop_poll()                                      -> ()
read_once(PollConfig)                            -> PollResult

write_single_coil(unit, addr, bool)              -> ()
write_single_register(unit, addr, u16)           -> ()
write_multiple_coils(unit, addr, Vec<bool>)      -> ()
write_multiple_registers(unit, addr, Vec<u16>)   -> ()
write_typed(unit, addr, TypedValue, DataFormat)  -> ()      // encodes then picks FC06/FC16

sim_start(SimulatorConfig)                       -> ()
sim_stop()                                       -> ()
sim_set_tag(slave_id, TagConfig)                 -> ()
sim_snapshot()                                   -> SimulatorSnapshot
sim_load_profile(path)                           -> SimulatorConfig
```

### Events (Rust → UI, streaming)

```
"poll-result"       PollResult          // one per poll cycle
"poll-error"        AppError            // transient failure; poll continues
"connection-lost"   AppError            // fatal; UI drops to disconnected
"frame"             FrameLogEntry       // one per TX and one per RX
"sim-update"        SimulatorSnapshot   // throttled to ~10 Hz
```

### Rules

1. **Commands are thin.** Validate, delegate, map the error. No protocol logic in `commands/`.
2. **Streams are events, never polling from the UI.** The UI never calls `read_once` in a loop.
3. **Values cross the boundary already decoded.** Rust sends `{ address, raw: [u16], value: 231.4 }`.
   The UI decides how many decimal places to show — nothing more.
4. **Events are throttled in Rust.** Emitting at 100 Hz would drown the webview. Cap at ~20 Hz;
   coalesce anything faster.
5. **Every event payload carries a `session_id`.** A stale event from a torn-down connection gets
   dropped by the UI instead of corrupting the new session's table.

## Data flow: one poll cycle

```
interval.tick()
   │
   ├─► client.read_holding_registers(addr, qty)        ── frame emitted (TX)
   │        │
   │        ├─ Ok(Vec<u16>)                            ── frame emitted (RX)
   │        │     │
   │        │     ├─► codec::decode_block(regs, format, word_order)
   │        │     │        └─► Vec<DecodedRegister { address, raw, value, error? }>
   │        │     │
   │        │     ├─► stats.record_success(latency)
   │        │     └─► app.emit("poll-result", PollResult { … })
   │        │
   │        └─ Err(e)
   │              ├─ Exception(code)  → stats.record_error; emit "poll-error"; keep polling
   │              ├─ Timeout          → stats.record_timeout; emit "poll-error"; keep polling
   │              └─ Transport(io)    → emit "connection-lost"; stop the task
   │
   └─► next tick
```

**Design point:** protocol exceptions and timeouts do *not* kill the poll. A device that returns
"Illegal Data Address" is still there, and the user wants to see that repeating while they adjust
the start address. Only a dead transport (socket closed, serial port vanished) ends the session.

## Frontend structure

```
src/
  main.tsx
  routes/
    Home.tsx                 two cards: Scan / Simulate
    scanner/
      Setup.tsx              transport picker → TcpForm | RtuForm
      Workspace.tsx          poll bar + table + write panel + stats + frame log
    simulator/
      Setup.tsx              transport + slaves + blocks
      Workspace.tsx          live editable table + tag animation controls
  components/
    RegisterTable.tsx        virtualized; Address(0-based) | Address(1-based) | Raw hex | Value
    FrameLog.tsx             hex dump, direction, timestamp, RTT
    StatsFooter.tsx          TX/RX/err, latency min/avg/max, actual rate, last error
    FormatPicker.tsx         data type × word order
    WritePanel.tsx           FC + address + value
    ConnectionPill.tsx       state + transport summary, always visible
  store/
    scannerStore.ts          config, status, rows, stats, frames
    simulatorStore.ts        config, snapshot
  lib/
    ipc.ts                   typed wrappers over invoke/listen — the only Tauri import
    format.ts                display formatting only (decimals, hex padding, thousands)
    types.ts                 mirrors Rust types
```

**The `ipc.ts` rule.** Exactly one module imports from `@tauri-apps/api`. Every command gets a
typed wrapper; every event gets a typed subscribe helper. This gives one place to add logging, one
place to mock for tests, and one file to review when the Rust API changes.

## Performance targets

| Metric | Target | How |
|---|---|---|
| Cold start | < 2 s | Tauri baseline; keep the JS bundle small |
| Table at 10k rows, 10 Hz | 60 fps | TanStack Virtual; render only visible rows |
| Poll jitter | < 5 ms at 1 Hz | `tokio::time::interval` (it self-corrects for drift) |
| Idle RAM | < 80 MB | Cap frame log at 10k entries (ring buffer) |
| Installer | < 15 MB | Tauri baseline |

## Where the risk lives

Ranked. Spend review effort in this order.

1. **`codec.rs`** — a word-order bug produces plausible wrong numbers, which is the worst possible
   failure for a diagnostic tool. Table-driven tests, and always display raw hex alongside.
2. **Poll task lifecycle** — leaking a task on disconnect means a zombie holding a serial port.
   Every session gets a `CancellationToken`; disconnect awaits task completion.
3. **Serial error handling** — the OS-specific matrix (busy, unplugged, permissions) is where
   cross-platform bugs concentrate. Test on all three.
4. **Event throttling** — a fast poll plus a chatty frame log can flood the webview and lock the UI.
   Coalesce in Rust, never in JS.

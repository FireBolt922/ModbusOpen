---
name: tauri-ipc
description: Use when adding, changing, or debugging communication between the Rust core and the React UI in ModbusOpen — Tauri commands, emitted events, shared state, or error types. Ensures every IPC path is added the same way and stays type-safe on both sides.
---

# Adding or changing IPC

There is exactly one way to add a Rust↔UI call in this repo. Follow all six steps; skipping the
TypeScript half is how the two sides drift.

## The checklist

### 1. Define the types in Rust

`src-tauri/src/modbus/types.rs`. Everything crossing the boundary derives:

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PollConfig { /* … */ }
```

`camelCase` is non-negotiable — it keeps the TS side idiomatic without a mapping layer.

### 2. Write the command — thin

`src-tauri/src/commands/`. Commands validate, delegate, and map errors. **No protocol logic here.**

```rust
#[tauri::command]
pub async fn set_poll_config(
    state: tauri::State<'_, AppState>,
    config: PollConfig,
) -> Result<(), AppError> {
    validate_poll_config(&config)?;
    let session = state.scanner.lock().await;
    session.as_ref()
        .ok_or(AppError::NotConnected)?
        .send(PollCommand::Retune(config))
        .await?;
    Ok(())
}
```

Rules:
- Always `Result<T, AppError>`. Never a bare `T`, never `String` errors.
- `async fn` for anything that locks or does I/O.
- **Never hold the socket.** Send a `PollCommand` down the channel and return. The poll task owns
  the client — see `docs/03-architecture.md#threading-model`.
- No `unwrap()` / `expect()`.

### 3. Register it

`src-tauri/src/lib.rs`, in `invoke_handler![]`. Forgetting this produces a runtime "command not
found" that looks like a frontend bug.

### 4. Add the typed TS wrapper

`src/lib/ipc.ts` — **the only file in the frontend that imports from `@tauri-apps/api`.**

```ts
export async function setPollConfig(config: PollConfig): Promise<void> {
  return invoke("set_poll_config", { config });
}
```

The argument key must match the Rust parameter name exactly (`config`), in camelCase. A mismatch
fails at runtime with an unhelpful deserialization error.

### 5. Mirror the type in TS

`src/lib/types.ts`. Hand-maintained mirror of the Rust struct. When you change one, change the
other **in the same commit** and note it in the message.

### 6. Test the round trip

Call it from the UI against the local test rig before moving on. A command that compiles on both
sides can still fail on serde field naming.

---

## Adding an event (Rust → UI stream)

Use an event, not a command, whenever Rust produces data on its own schedule.

**Rust:**
```rust
app_handle.emit("poll-result", &result)?;
```

**TypeScript** — in `src/lib/ipc.ts`, return the unlisten function:
```ts
export function onPollResult(cb: (r: PollResult) => void): Promise<UnlistenFn> {
  return listen<PollResult>("poll-result", (e) => cb(e.payload));
}
```

**In a component** — always clean up:
```ts
useEffect(() => {
  const p = onPollResult(handleResult);
  return () => { p.then((unlisten) => unlisten()); };
}, []);
```

### Event rules

1. **Throttle in Rust, never in JS.** Cap emissions at ~20 Hz and coalesce anything faster. A
   100 Hz event stream will lock the webview.
2. **Every payload carries `sessionId`.** The UI drops events whose session doesn't match the
   current one — otherwise a torn-down connection's in-flight events corrupt the new session's table.
3. **Never emit inside a lock.** Clone what you need, drop the guard, then emit.
4. **The UI never polls.** No `setInterval` calling a Rust command. If you're reaching for one, the
   data should be an event.

---

## Shared state

```rust
pub struct AppState {
    pub scanner:   tokio::sync::Mutex<Option<ScannerSession>>,
    pub simulator: tokio::sync::Mutex<Option<SimulatorSession>>,
}
```

- `tokio::sync::Mutex`, not `std::sync::Mutex` — the guard must be held across `.await`.
- Hold the lock for as short a span as possible. Never across a Modbus transaction.
- Every session owns a `CancellationToken`. `disconnect()` cancels it **and awaits task
  completion** before returning — otherwise you leak a task still holding a serial port, and the
  next connect fails with "port busy" for no visible reason.

---

## Errors

One enum, `src-tauri/src/error.rs`, deriving `thiserror::Error` and `serde::Serialize`. Adding a
variant means:

1. The `#[error("…")]` message is a full sentence aimed at a controls engineer.
2. It carries enough structured fields for the UI to build an actionable hint.
3. The TS union in `src/lib/types.ts` gets the matching variant.

| Never | Always |
|---|---|
| `Err(e.to_string())` | A typed `AppError` variant |
| `Permission denied (os error 13)` | `Can't open /dev/ttyUSB0 — add your user to the 'dialout' group, then log out and back in.` |
| `Exception 2` | `Illegal Data Address (02) — no register at 40101. Check the start address and addressing base.` |

Full mapping table: `docs/05-data-model.md#errors`.

---

## Common failures

| Symptom | Cause |
|---|---|
| "command not found" at runtime | Not added to `invoke_handler![]` |
| Args arrive as `undefined` in Rust | TS key doesn't match the Rust parameter name, or isn't camelCase |
| Field is `null` in TS | Missing `#[serde(rename_all = "camelCase")]` on the struct |
| UI freezes during a poll | A command is holding the client lock — it must go through the channel |
| Events keep firing after disconnect | Missing `unlisten` in the `useEffect` cleanup |
| Stale rows appear in a new session | Payload missing `sessionId`, or the UI isn't filtering on it |
| "Port busy" on reconnect | `disconnect()` didn't await task shutdown |

// The ONLY module in this codebase that imports from @tauri-apps/api.
// Every Rust command gets a typed wrapper here; every event gets a typed
// subscribe helper here. Components never call invoke()/listen() directly.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppError,
  ConnectionInfo,
  ConnectionLostEvent,
  ConnectionStatus,
  PollConfig,
  PollErrorEvent,
  PollResult,
  RtuConfig,
  SerialPortInfo,
  TcpConfig,
} from "./types";

export type { AppError };

export function isAppError(err: unknown): err is AppError {
  return (
    typeof err === "object" &&
    err !== null &&
    "kind" in err &&
    typeof (err as { kind: unknown }).kind === "string"
  );
}

/** Turn a Rust AppError (or any rejection) into a controls-engineer sentence. */
export function errorMessage(err: unknown): string {
  if (isAppError(err)) {
    switch (err.kind) {
      case "SerialPortList":
      case "InvalidConfig":
        return err.message;
      case "TcpConnect":
        return `Can't reach ${err.message.host}:${err.message.port} — ${err.message.reason}`;
      case "SerialOpen":
        return `Can't open ${err.message.port} — ${err.message.reason}`;
      case "Timeout":
        return `No response from unit ${err.message.unit_id} within ${err.message.timeout_ms} ms (${err.message.attempts} attempts)`;
      case "ModbusException": {
        const code = String(err.message.code).padStart(2, "0");
        return `${err.message.name} (${code}) — ${err.message.hint}`;
      }
      case "ConnectionLost":
        return `Connection lost — ${err.message.reason}`;
      case "NotConnected":
        return "Not connected";
    }
  }
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  return invoke<SerialPortInfo[]>("list_serial_ports");
}

export async function tcpConnect(config: TcpConfig): Promise<ConnectionInfo> {
  return invoke<ConnectionInfo>("tcp_connect", { config });
}

export async function rtuConnect(config: RtuConfig): Promise<ConnectionInfo> {
  return invoke<ConnectionInfo>("rtu_connect", { config });
}

export async function disconnect(): Promise<void> {
  return invoke("disconnect");
}

export async function connectionStatus(): Promise<ConnectionStatus> {
  return invoke<ConnectionStatus>("connection_status");
}

export async function setPollConfig(config: PollConfig): Promise<void> {
  return invoke("set_poll_config", { config });
}

export async function startPoll(): Promise<void> {
  return invoke("start_poll");
}

export async function stopPoll(): Promise<void> {
  return invoke("stop_poll");
}

export async function readOnce(config: PollConfig): Promise<PollResult> {
  return invoke<PollResult>("read_once", { config });
}

export function onPollResult(
  cb: (result: PollResult) => void,
): Promise<UnlistenFn> {
  return listen<PollResult>("poll-result", (e) => cb(e.payload));
}

export function onPollError(
  cb: (event: PollErrorEvent) => void,
): Promise<UnlistenFn> {
  return listen<PollErrorEvent>("poll-error", (e) => cb(e.payload));
}

export function onConnectionLost(
  cb: (event: ConnectionLostEvent) => void,
): Promise<UnlistenFn> {
  return listen<ConnectionLostEvent>("connection-lost", (e) => cb(e.payload));
}

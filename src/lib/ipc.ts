// The ONLY module in this codebase that imports from @tauri-apps/api.
// Every Rust command gets a typed wrapper here; every event gets a typed
// subscribe helper here. Components never call invoke()/listen() directly.
import { invoke } from "@tauri-apps/api/core";
import type { SerialPortInfo } from "./types";

// Mirrors src-tauri/src/error.rs::AppError. Keep the two in sync by hand.
export type AppError = { kind: "SerialPortList"; message: string };

export function isAppError(err: unknown): err is AppError {
  return (
    typeof err === "object" &&
    err !== null &&
    "kind" in err &&
    "message" in err
  );
}

export function errorMessage(err: unknown): string {
  if (isAppError(err)) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  return invoke<SerialPortInfo[]>("list_serial_ports");
}

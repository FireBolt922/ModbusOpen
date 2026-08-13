// The ONLY module in this codebase that imports from @tauri-apps/api.
// Every Rust command gets a typed wrapper here; every event gets a typed
// subscribe helper here. Components never call invoke()/listen() directly.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import type {
  AddressedWord,
  AppError,
  ConnectionInfo,
  ConnectionLostEvent,
  ConnectionStatus,
  DataFormat,
  DecodedRegister,
  FrameLogEntry,
  MeterImportChoice,
  MeterImportPreview,
  MeterProfile,
  PollConfig,
  PollErrorEvent,
  PollResult,
  ReadBlock,
  ReconnectResult,
  RtuConfig,
  SerialPortInfo,
  ServiceLogEvent,
  ServiceStatus,
  ServiceStatusEvent,
  ServiceValidation,
  ServicesConfig,
  SimulatorConfig,
  TagConfig,
  SimulatorInfo,
  SimulatorSnapshot,
  TcpConfig,
  TypedValue,
  UnlockState,
  WriteResult,
} from "./types";

export type { AppError };

/** Read the version embedded in the running Tauri application. */
export async function getAppVersion(): Promise<string> {
  return getVersion();
}

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
      case "BadFrame":
        return `Bad reply — ${err.message.reason}`;
      case "LinkDown":
        return err.message.message;
      case "NotConnected":
        return "Not connected";
      case "Unsupported":
        return err.message.message;
      case "ServiceControl":
        return `Can't ${err.message.action} ${err.message.unit} — ${err.message.reason}`;
      case "Locked":
        return "Enter the configuration password to do that.";
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

/**
 * Reopen the current session's transport with the settings it was created
 * with. The session, its poll config and its counters survive — this is what
 * the workspace offers after a dropped link, instead of sending the user back
 * to the setup form.
 */
export async function reconnect(): Promise<ReconnectResult> {
  return invoke<ReconnectResult>("reconnect");
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

export async function resetPollStats(): Promise<void> {
  return invoke("reset_poll_stats");
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

export function onFrame(
  cb: (entry: FrameLogEntry) => void,
): Promise<UnlistenFn> {
  return listen<FrameLogEntry>("frame", (e) => cb(e.payload));
}

export async function writeSingleCoil(
  unitId: number,
  address: number,
  value: boolean,
): Promise<WriteResult> {
  return invoke<WriteResult>("write_single_coil", { unitId, address, value });
}

export async function writeSingleRegister(
  unitId: number,
  address: number,
  value: number,
): Promise<WriteResult> {
  return invoke<WriteResult>("write_single_register", {
    unitId,
    address,
    value,
  });
}

export async function writeMultipleCoils(
  unitId: number,
  address: number,
  values: boolean[],
): Promise<WriteResult> {
  return invoke<WriteResult>("write_multiple_coils", {
    unitId,
    address,
    values,
  });
}

export async function writeMultipleRegisters(
  unitId: number,
  address: number,
  values: number[],
): Promise<WriteResult> {
  return invoke<WriteResult>("write_multiple_registers", {
    unitId,
    address,
    values,
  });
}

export async function writeTyped(
  unitId: number,
  address: number,
  value: TypedValue,
  format: DataFormat,
): Promise<WriteResult> {
  return invoke<WriteResult>("write_typed", {
    unitId,
    address,
    value,
    format,
  });
}

export async function simStart(
  config: SimulatorConfig,
): Promise<SimulatorInfo> {
  return invoke<SimulatorInfo>("sim_start", { config });
}

export async function simStop(): Promise<void> {
  return invoke("sim_stop");
}

export async function simSnapshot(): Promise<SimulatorSnapshot> {
  return invoke<SimulatorSnapshot>("sim_snapshot");
}

export async function simWriteRegister(
  unitId: number,
  address: number,
  value: number,
): Promise<SimulatorSnapshot> {
  return invoke<SimulatorSnapshot>("sim_write_register", {
    unitId,
    address,
    value,
  });
}

export async function simWriteCoil(
  unitId: number,
  address: number,
  value: boolean,
): Promise<SimulatorSnapshot> {
  return invoke<SimulatorSnapshot>("sim_write_coil", {
    unitId,
    address,
    value,
  });
}

export function onSimUpdate(
  cb: (snapshot: SimulatorSnapshot) => void,
): Promise<UnlistenFn> {
  return listen<SimulatorSnapshot>("sim-update", (e) => cb(e.payload));
}

/* ------------------------------------------------------------------ shell */

/**
 * Open a URL in the user's default browser. Same rule as the invoke wrappers
 * above: components don't reach for Tauri plugins directly.
 *
 * Failure is non-fatal — a docs link that doesn't open shouldn't throw into a
 * component's render path, so callers get a boolean instead of a rejection.
 */
export async function openExternal(url: string): Promise<boolean> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ meters */

export async function listMeterProfiles(): Promise<MeterProfile[]> {
  return invoke<MeterProfile[]>("list_meter_profiles");
}

export async function getMeterProfile(id: string): Promise<MeterProfile> {
  return invoke<MeterProfile>("get_meter_profile", { id });
}

export async function saveMeterProfile(
  profile: MeterProfile,
): Promise<MeterProfile> {
  return invoke<MeterProfile>("save_meter_profile", { profile });
}

export async function deleteMeterProfile(id: string): Promise<void> {
  return invoke("delete_meter_profile", { id });
}

export async function duplicateMeterProfile(
  id: string,
  newId: string,
): Promise<MeterProfile> {
  return invoke<MeterProfile>("duplicate_meter_profile", { id, newId });
}

export async function exportMeterProfiles(
  ids: string[],
  path: string,
): Promise<string> {
  return invoke<string>("export_meter_profiles", { ids, path });
}

export async function previewMeterImport(
  path: string,
): Promise<MeterImportPreview> {
  return invoke<MeterImportPreview>("preview_meter_import", { path });
}

export async function commitMeterImport(
  path: string,
  resolutions: MeterImportChoice[],
): Promise<MeterProfile[]> {
  return invoke<MeterProfile[]>("commit_meter_import", { path, resolutions });
}

export async function meterProfileToSimulator(
  id: string,
  tcpPort: number,
  tickMs: number,
): Promise<SimulatorConfig> {
  return invoke<SimulatorConfig>("meter_profile_to_simulator", {
    id,
    tcpPort,
    tickMs,
  });
}

/**
 * Decode a meter's named parameters from whatever the last poll returned.
 *
 * Takes address/word pairs, not a block: a meter read in several requests has
 * gaps, so there is no single contiguous array to index into.
 */
export async function decodeMeterPoints(
  profile: MeterProfile,
  words: AddressedWord[],
): Promise<DecodedRegister[]> {
  return invoke<DecodedRegister[]>("decode_meter_points", { profile, words });
}

/** The Modbus requests needed to read this meter once. */
export async function meterReadPlan(
  profile: MeterProfile,
): Promise<ReadBlock[]> {
  return invoke<ReadBlock[]>("meter_read_plan", { profile });
}

export async function decodeTagValues(
  registers: number[],
  tags: TagConfig[],
): Promise<DecodedRegister[]> {
  return invoke<DecodedRegister[]>("decode_tag_values", { registers, tags });
}

// ---------------------------------------------------------------------------
// Service control (Linux only)
//
// Every one of these rejects with AppError::Unsupported off Linux, so the UI
// gates the whole screen on servicesSupported() before calling anything else.
// ---------------------------------------------------------------------------

/** Whether this build can control services at all. */
export async function servicesSupported(): Promise<boolean> {
  return invoke<boolean>("services_supported");
}

/** OS name ("macos", "windows", …), so the Linux-only notice can be specific. */
export async function servicesPlatform(): Promise<string> {
  return invoke<string>("services_platform");
}

/**
 * Start the shared 30-minute unlock. It gates Stop *and* the Configure tab —
 * the expiry is owned by Rust, so this is the only way to learn about it.
 */
export async function servicesUnlock(password: string): Promise<UnlockState> {
  return invoke<UnlockState>("services_unlock", { password });
}

export async function servicesUnlockState(): Promise<UnlockState> {
  return invoke<UnlockState>("services_unlock_state");
}

export async function servicesLock(): Promise<void> {
  return invoke("services_lock");
}

export async function getServicesConfig(): Promise<ServicesConfig> {
  return invoke<ServicesConfig>("get_services_config");
}

/** Requires the unlock. Returns the config as saved (trimmed, versioned). */
export async function saveServicesConfig(
  config: ServicesConfig,
): Promise<ServicesConfig> {
  return invoke<ServicesConfig>("save_services_config", { config });
}

/**
 * Check one or many unit names. Accepts a comma-separated list, so a whole
 * rack can be added in one go; names without a suffix get ".service".
 */
export async function validateServiceUnits(
  names: string,
): Promise<ServiceValidation[]> {
  return invoke<ServiceValidation[]>("validate_service_units", { names });
}

/** One-shot list, for the first paint before the watcher's first tick. */
export async function listMonitoredServices(): Promise<ServiceStatus[]> {
  return invoke<ServiceStatus[]>("list_monitored_services");
}

/** No password needed — recovering a service is never the hard part. */
export async function startService(unit: string): Promise<ServiceStatus> {
  return invoke<ServiceStatus>("start_service", { unit });
}

/** Open on View — no password. Arms the 30-minute automatic restart. */
export async function stopService(unit: string): Promise<ServiceStatus> {
  return invoke<ServiceStatus>("stop_service", { unit });
}

/** Begin `service-status` pushes. Returns the session id to match against. */
export async function servicesWatchStart(): Promise<number> {
  return invoke<number>("services_watch_start");
}

export async function servicesWatchStop(): Promise<void> {
  return invoke("services_watch_stop");
}

/** Open a live journal tail. Always pair with serviceLogsClose(). */
export async function serviceLogsOpen(unit: string): Promise<number> {
  return invoke<number>("service_logs_open", { unit });
}

export async function serviceLogsClose(sessionId: number): Promise<void> {
  return invoke("service_logs_close", { sessionId });
}

export function onServiceStatus(
  cb: (event: ServiceStatusEvent) => void,
): Promise<UnlistenFn> {
  return listen<ServiceStatusEvent>("service-status", (e) => cb(e.payload));
}

export function onServiceLog(
  cb: (event: ServiceLogEvent) => void,
): Promise<UnlistenFn> {
  return listen<ServiceLogEvent>("service-log", (e) => cb(e.payload));
}

/** Native save dialog; returns null if the user cancels. */
export async function pickSavePath(
  defaultName: string,
): Promise<string | null> {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: defaultName,
      filters: [{ name: "Meter pack", extensions: ["mbmeter.json", "json"] }],
    });
    return path ?? null;
  } catch {
    return null;
  }
}

/** Native open dialog for a meter pack; returns null if cancelled. */
export async function pickOpenPath(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({
      multiple: false,
      filters: [{ name: "Meter pack", extensions: ["mbmeter.json", "json"] }],
    });
    if (Array.isArray(path)) return path[0] ?? null;
    return path ?? null;
  } catch {
    return null;
  }
}

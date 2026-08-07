// Display formatting only. Decoding lives in Rust (modbus/codec.rs).

import type { DecodedRegister, TypedValue } from "./types";

/** 0-based wire address → classic 1-based holding-register notation (4xxxx). */
export function toHoldingNotation(wireAddress: number): string {
  return String(40_000 + wireAddress + 1);
}

/** Format a multi-register span as "100" or "100–101". */
export function formatAddressSpan(address: number, span: number): string {
  if (span <= 1) return String(address);
  return `${address}–${address + span - 1}`;
}

/** Format 1-based holding notation for a multi-register span. */
export function formatHoldingSpan(address: number, span: number): string {
  const start = toHoldingNotation(address);
  if (span <= 1) return start;
  return `${start}–${toHoldingNotation(address + span - 1)}`;
}

/** Raw register words as space-separated big-endian hex bytes. */
export function formatRawHex(raw: number[]): string {
  return raw
    .map((w) => {
      const hi = ((w >> 8) & 0xff).toString(16).padStart(2, "0");
      const lo = (w & 0xff).toString(16).padStart(2, "0");
      return `${hi} ${lo}`;
    })
    .join("  ")
    .toUpperCase();
}

export function formatTypedValue(value: TypedValue): string {
  switch (value.kind) {
    case "bool":
      return value.value ? "true" : "false";
    case "int":
      return String(value.value);
    case "uint":
      return String(value.value);
    case "float": {
      const v = value.value;
      if (!Number.isFinite(v)) return String(v);
      // Enough digits for meter readings without drowning the cell.
      if (Math.abs(v) >= 1000 || Number.isInteger(v)) return v.toFixed(1);
      if (Math.abs(v) >= 1) return v.toPrecision(6).replace(/\.?0+$/, "");
      return v.toPrecision(4);
    }
    case "text":
      return value.value;
    case "invalid":
      return "—";
  }
}

export function formatRegisterValue(row: DecodedRegister): string {
  if (row.decodeError) return row.decodeError;
  return formatTypedValue(row.value);
}

export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms)} ms`;
}

export function formatRate(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return "—";
  return `${hz.toFixed(2)} Hz`;
}

/** Bytes as space-separated uppercase hex. */
export function formatBytesHex(bytes: number[]): string {
  return bytes
    .map((b) => (b & 0xff).toString(16).padStart(2, "0"))
    .join(" ")
    .toUpperCase();
}

export function functionCodeLabel(fc: number): string {
  const map: Record<number, string> = {
    0x01: "01 Read Coils",
    0x02: "02 Read Discrete",
    0x03: "03 Read Holding",
    0x04: "04 Read Input",
    0x05: "05 Write Coil",
    0x06: "06 Write Register",
    0x0f: "15 Write Coils",
    0x10: "16 Write Registers",
  };
  return map[fc] ?? `FC ${fc.toString(16).padStart(2, "0")}`;
}

/** Build a CSV snapshot of the current table. */
export function tableToCsv(rows: DecodedRegister[]): string {
  const header = "address,holding,raw_hex,value,decode_error";
  const lines = rows.map((r) => {
    const raw = formatRawHex(r.raw).replace(/,/g, " ");
    const value = formatRegisterValue(r).replace(/"/g, '""');
    const err = (r.decodeError ?? "").replace(/"/g, '""');
    return `${r.address},${formatHoldingSpan(r.address, r.span)},"${raw}","${value}","${err}"`;
  });
  return [header, ...lines].join("\n");
}

/**
 * Data types in the words a controls engineer uses when reading a datasheet.
 *
 * A datasheet says "2 registers, IEEE-754" or "1 register, value × 0.1". It
 * does not say "float32 CDAB". These options map what the sheet actually says
 * onto a DataFormat, so nobody has to know the vocabulary to get a correct
 * reading. Word order stays available under Advanced — it's the one thing a
 * datasheet often gets wrong, and it has to stay changeable.
 */

import type { DataFormat, DataType } from "@/lib/types";

export type ValueKind = {
  id: string;
  label: string;
  /** What a datasheet would say to make this the right choice. */
  hint: string;
  dataType: DataType;
  scale: number;
  registers: number;
};

export const VALUE_KINDS: ValueKind[] = [
  {
    id: "decimal32",
    label: "Decimal number",
    hint: "2 registers, IEEE-754 float — the usual choice for volts, amps, power",
    dataType: "float32",
    scale: 1,
    registers: 2,
  },
  {
    id: "whole16",
    label: "Whole number",
    hint: "1 register, 0 to 65535",
    dataType: "uint16",
    scale: 1,
    registers: 1,
  },
  {
    id: "whole16signed",
    label: "Whole number, can be negative",
    hint: "1 register, -32768 to 32767",
    dataType: "int16",
    scale: 1,
    registers: 1,
  },
  {
    id: "whole32",
    label: "Big whole number",
    hint: "2 registers — energy counters and run hours usually need this",
    dataType: "uint32",
    scale: 1,
    registers: 2,
  },
  {
    id: "tenths",
    label: "Whole number ÷ 10",
    hint: "1 register holding 231 for 23.1 — datasheet says 'value × 0.1'",
    dataType: "uint16",
    scale: 0.1,
    registers: 1,
  },
  {
    id: "hundredths",
    label: "Whole number ÷ 100",
    hint: "1 register holding 5179 for 51.79 — datasheet says 'value × 0.01'",
    dataType: "uint16",
    scale: 0.01,
    registers: 1,
  },
  {
    id: "thousandths",
    label: "Whole number ÷ 1000",
    hint: "1 register holding 998 for 0.998",
    dataType: "uint16",
    scale: 0.001,
    registers: 1,
  },
  {
    id: "decimal64",
    label: "Long decimal number",
    hint: "4 registers, double precision — rare",
    dataType: "float64",
    scale: 1,
    registers: 4,
  },
  {
    id: "whole64",
    label: "Very big whole number",
    hint: "4 registers — large lifetime totalisers",
    dataType: "uint64",
    scale: 1,
    registers: 4,
  },
];

/** How many registers a format occupies. */
export function registerSpan(format: DataFormat): number {
  switch (format.dataType) {
    case "uint64":
    case "int64":
    case "float64":
      return 4;
    case "uint32":
    case "int32":
    case "float32":
      return 2;
    default:
      return 1;
  }
}

/**
 * The closest plain-language option for a format, or null when the format is
 * something only the Advanced controls can express (an unusual scale, a hex
 * view, a signed 32-bit). The editor falls back to showing the raw type there
 * rather than lying about it.
 */
export function matchValueKind(format: DataFormat): ValueKind | null {
  return (
    VALUE_KINDS.find(
      (k) => k.dataType === format.dataType && k.scale === format.scale,
    ) ?? null
  );
}

export function describeFormat(format: DataFormat): string {
  const kind = matchValueKind(format);
  if (kind) {
    const span = kind.registers;
    return `${kind.label} · ${span} reg${span > 1 ? "s" : ""}`;
  }
  const scale = format.scale !== 1 ? ` × ${format.scale}` : "";
  return `${format.dataType}${scale} · ${registerSpan(format)} reg`;
}

/** Apply a plain-language choice, keeping word order and offset as they were. */
export function applyValueKind(
  format: DataFormat,
  kind: ValueKind,
): DataFormat {
  return {
    ...format,
    dataType: kind.dataType,
    scale: kind.scale,
  };
}

/**
 * Common meter parameters, so building a meter means picking what it measures
 * and typing the address off the datasheet — not inventing a key, a unit, a
 * data type and a simulation range for every row.
 *
 * The defaults here are the ordinary case for electrical meters (float32 CDAB,
 * engineering units). Anything a preset guesses can be changed afterwards; the
 * point is that the common path needs one number from the user.
 */

import type {
  DataFormat,
  MeterPoint,
  MeterPointGroup,
  TagBehavior,
} from "@/lib/types";

export type ParameterPreset = {
  /** Stable key written into the profile. */
  key: string;
  label: string;
  unit: string;
  group: MeterPointGroup;
  /** Plain-language grouping for the picker, not stored on the profile. */
  category: string;
  format: DataFormat;
  simBehavior: TagBehavior;
  simInitial: number;
  /** Extra words to match on when searching. */
  aliases?: string[];
};

const FLOAT: DataFormat = {
  dataType: "float32",
  wordOrder: "cdab",
  scale: 1,
  offset: 0,
};

const UINT32: DataFormat = {
  dataType: "uint32",
  wordOrder: "cdab",
  scale: 1,
  offset: 0,
};

function reading(
  key: string,
  label: string,
  unit: string,
  category: string,
  group: MeterPointGroup,
  min: number,
  max: number,
  aliases?: string[],
): ParameterPreset {
  return {
    key,
    label,
    unit,
    group,
    category,
    format: { ...FLOAT },
    simBehavior: { kind: "random", min, max },
    simInitial: (min + max) / 2,
    aliases,
  };
}

/** A quantity that only ever climbs — energy, run hours, totalisers. */
function counter(
  key: string,
  label: string,
  unit: string,
  category: string,
  group: MeterPointGroup,
  start: number,
  step: number,
  aliases?: string[],
): ParameterPreset {
  return {
    key,
    label,
    unit,
    group,
    category,
    format: { ...UINT32 },
    simBehavior: { kind: "counter", step },
    simInitial: start,
    aliases,
  };
}

export const PARAMETER_PRESETS: ParameterPreset[] = [
  // ---- Voltage ----
  reading("voltage_ln", "Voltage L-N", "V", "Voltage", "instantaneous", 228, 242, ["phase", "neutral"]),
  reading("voltage_ll", "Voltage L-L", "V", "Voltage", "instantaneous", 398, 418, ["line"]),
  reading("voltage_l1", "Voltage L1", "V", "Voltage", "instantaneous", 228, 242, ["r phase"]),
  reading("voltage_l2", "Voltage L2", "V", "Voltage", "instantaneous", 228, 242, ["y phase"]),
  reading("voltage_l3", "Voltage L3", "V", "Voltage", "instantaneous", 228, 242, ["b phase"]),
  reading("voltage_average", "Voltage average", "V", "Voltage", "instantaneous", 228, 242, ["avg"]),

  // ---- Current ----
  reading("current", "Current", "A", "Current", "instantaneous", 0.5, 60, ["amps", "amperes"]),
  reading("current_l1", "Current L1", "A", "Current", "instantaneous", 0.5, 60, ["r phase"]),
  reading("current_l2", "Current L2", "A", "Current", "instantaneous", 0.5, 60, ["y phase"]),
  reading("current_l3", "Current L3", "A", "Current", "instantaneous", 0.5, 60, ["b phase"]),
  reading("current_neutral", "Neutral current", "A", "Current", "instantaneous", 0, 5),
  reading("current_total", "Current total", "A", "Current", "instantaneous", 1, 180),

  // ---- Power ----
  reading("active_power", "Active power", "kW", "Power", "instantaneous", 0.5, 45, ["kw", "real"]),
  reading("reactive_power", "Reactive power", "kVAr", "Power", "instantaneous", -12, 12, ["kvar"]),
  reading("apparent_power", "Apparent power", "kVA", "Power", "instantaneous", 0.5, 48, ["kva"]),
  reading("power_factor", "Power factor", "", "Power", "instantaneous", 0.75, 1, ["pf", "cos"]),
  reading("frequency", "Frequency", "Hz", "Power", "instantaneous", 49.5, 50.5, ["hz"]),

  // ---- Energy ----
  counter("energy_active_import", "Active energy (import)", "kWh", "Energy", "energy", 125000, 1, ["kwh", "received", "consumed"]),
  counter("energy_active_export", "Active energy (export)", "kWh", "Energy", "energy", 400, 1, ["delivered"]),
  counter("energy_reactive", "Reactive energy", "kVArh", "Energy", "energy", 18000, 1, ["kvarh"]),
  counter("energy_apparent", "Apparent energy", "kVAh", "Energy", "energy", 130000, 1, ["kvah"]),

  // ---- Demand ----
  reading("demand_active", "Active demand", "kW", "Demand", "instantaneous", 5, 40, ["md"]),
  reading("demand_max", "Maximum demand", "kW", "Demand", "instantaneous", 30, 48, ["md", "peak"]),

  // ---- Harmonics ----
  reading("thd_voltage", "Voltage THD", "%", "Harmonics", "harmonics", 0.5, 6, ["distortion"]),
  reading("thd_current", "Current THD", "%", "Harmonics", "harmonics", 1, 14, ["distortion"]),

  // ---- Diagnostics ----
  counter("run_hours", "Run hours", "h", "Diagnostics", "diagnostics", 1200, 1, ["runtime", "on time"]),
  reading("temperature", "Temperature", "°C", "Diagnostics", "diagnostics", 20, 65, ["temp"]),

  // ---- Process (non-electrical meters) ----
  reading("flow_rate", "Flow rate", "m³/h", "Process", "instantaneous", 2, 40, ["flow"]),
  counter("flow_total", "Flow totaliser", "m³", "Process", "energy", 90000, 1, ["totalizer", "totaliser"]),
  reading("pressure", "Pressure", "bar", "Process", "instantaneous", 1, 9),
  reading("level", "Level", "%", "Process", "instantaneous", 10, 95),
  reading("speed", "Speed", "rpm", "Process", "instantaneous", 700, 1480, ["rpm"]),
];

/** Free-text search over label, unit, category and aliases. */
export function searchPresets(query: string): ParameterPreset[] {
  const q = query.trim().toLowerCase();
  if (!q) return PARAMETER_PRESETS;
  return PARAMETER_PRESETS.filter((p) =>
    [p.label, p.unit, p.category, p.key, ...(p.aliases ?? [])]
      .join(" ")
      .toLowerCase()
      .includes(q),
  );
}

/**
 * Turn a preset into a parameter at `address`.
 *
 * `unverified` stays true: a preset guesses the shape of the value, not that
 * this particular meter really keeps it at this address in this format. Only
 * seeing a sensible number against the real device settles that.
 */
export function pointFromPreset(
  preset: ParameterPreset,
  address: number,
  existingKeys: string[],
): MeterPoint {
  let key = preset.key;
  let n = 2;
  while (existingKeys.includes(key)) {
    key = `${preset.key}_${n}`;
    n += 1;
  }
  return {
    key,
    label: preset.label,
    address,
    format: { ...preset.format },
    unit: preset.unit,
    group: preset.group,
    unverified: true,
    simBehavior: preset.simBehavior,
    simInitial: preset.simInitial,
  };
}

/** A blank parameter for the "custom" path. */
export function customPoint(address: number, existingKeys: string[]): MeterPoint {
  let key = "parameter";
  let n = 2;
  while (existingKeys.includes(key)) {
    key = `parameter_${n}`;
    n += 1;
  }
  return {
    key,
    label: "",
    address,
    format: { ...FLOAT },
    unit: "",
    group: "instantaneous",
    unverified: true,
    simBehavior: { kind: "random", min: 0, max: 100 },
    simInitial: 50,
  };
}

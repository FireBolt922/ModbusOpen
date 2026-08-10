# Meter pack file format

The authority is `src-tauri/src/modbus/types.rs` (`MeterPack`, `MeterProfile`, `MeterPoint`)
and `src-tauri/src/modbus/validate.rs` (`validate_meter_profile`). This file restates it.
If they disagree, the Rust wins — and update this file.

Serde uses `camelCase` for field names and `snake_case` for enum values. Getting that
backwards is the most common reason a hand-written file fails to parse.

## Contents

- [Envelope](#envelope)
- [Profile](#profile)
- [Point](#point)
- [DataFormat](#dataformat)
- [simBehavior](#simbehavior)
- [Enum values](#enum-values)
- [What the importer rejects](#what-the-importer-rejects)
- [Full example](#full-example)

## Envelope

```json
{
  "version": 1,
  "kind": "meter-pack",
  "exportedBy": "Ganesh — from the ACME-3000 datasheet rev C",
  "exportedAt": "2026-08-09T10:00:00Z",
  "profiles": [ { ...profile... } ]
}
```

| Field | Required | Notes |
|---|---|---|
| `version` | yes | Always `1`. |
| `kind` | yes | Always `"meter-pack"`. `"profile"` is also accepted for legacy files. |
| `exportedBy` | no | Free text. Good place for the datasheet name and revision. |
| `exportedAt` | no | RFC 3339 timestamp. |
| `profiles` | yes | At least one. Several meters can ship in one file. |

A bare profile object (no envelope) also imports. Prefer the envelope — it carries provenance.

## Profile

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Letters, digits, `-`, `_` only. Becomes a filename in the importer's library. |
| `brand` | yes | Non-empty. |
| `model` | yes | Non-empty. |
| `description` | no | Defaults to `""`. Say where the map came from and what's unverified. |
| `source` | no | Omit. Defaults to `{"kind":"user"}`; the importer retags it as `imported`. |
| `function` | yes | Default read function for points that don't override it. |
| `defaultUnitId` | yes | 1-247. |
| `suggestedRtu` | no | `{"baudRate":9600,"dataBits":8,"parity":"even","stopBits":1}`. |
| `points` | yes | At least one. |

There is no block start or count. The app derives the requests from the points
(`plan_reads`), so parameters can sit anywhere in the address space.

## Point

| Field | Required | Notes |
|---|---|---|
| `key` | yes | Unique within the profile. `snake_case`; used as the column name in exports. |
| `label` | yes | What a human reads. |
| `address` | yes | **0-based wire address.** Not the 40001-style number on the datasheet. |
| `format` | yes | See below. |
| `unit` | no | `"V"`, `"kWh"`. Defaults to `""`. |
| `function` | no | Overrides the profile default for this one parameter. Omit if it matches. |
| `group` | no | Defaults to `instantaneous`. |
| `unverified` | no | Defaults to `false`. Set `true` for anything not confirmed against real hardware. |
| `simBehavior` | no | Omit and the simulator serves zeros for this parameter. |
| `simInitial` | no | Starting value; the value itself for `static`, the base for `counter`. |

## DataFormat

```json
{ "dataType": "float32", "wordOrder": "cdab", "scale": 1.0, "offset": 0.0 }
```

All four fields are required. Decoded value is `raw * scale + offset`.

A "0.1 A resolution" integer register is `uint16` with `scale: 0.1` — raw 2371 reads 237.1 A.

## simBehavior

Tagged by `kind`:

```json
{"kind": "static"}
{"kind": "random",  "min": 228.0, "max": 242.0}
{"kind": "ramp",    "min": 0.0, "max": 100.0, "step": 1.0}
{"kind": "sine",    "min": 0.0, "max": 100.0, "periodS": 30.0}
{"kind": "counter", "step": 1.0}
```

`min` must be strictly less than `max`, and `periodS` greater than 0 — violating either
imports fine but fails when the meter is loaded into the simulator.

## Enum values

| Enum | Values |
|---|---|
| `function` | `read_holding_registers`, `read_input_registers` (also parsed: `read_coils`, `read_discrete_inputs`) |
| `dataType` | `bool`, `uint16`, `int16`, `hex16`, `binary16`, `uint32`, `int32`, `float32`, `uint64`, `int64`, `float64` |
| `wordOrder` | `abcd`, `cdab`, `badc`, `dcba` |
| `group` | `instantaneous`, `energy`, `harmonics`, `diagnostics`, `other` |
| `parity` | `none`, `even`, `odd` |

Register spans: 1 register for the 16-bit types and `bool`, 2 for `uint32`/`int32`/`float32`,
4 for the 64-bit types. `string` exists in the enum but is rejected in meter profiles.

## What the importer rejects

Every one of these is a hard error in `validate_meter_profile`:

- an `id` that isn't a slug, or an empty `id` / `brand` / `model`
- `defaultUnitId` outside 1-247
- zero points
- an empty or duplicated `key`, or an empty `label`
- `dataType: "string"`
- a point whose span exceeds the function's per-request limit
- `address + span` past 65536
- **two points covering the same register on the same function code** — the one people hit.
  A `float32` at 100 owns 100 and 101, so the next parameter starts at 102.

The same address under a *different* function code is a different register and is fine.

## Full example

Two parameters near each other, one far away, one on the other function code —
three requests, planned by the app.

```json
{
  "version": 1,
  "kind": "meter-pack",
  "exportedBy": "ACME-3000 datasheet rev C, table 7",
  "profiles": [
    {
      "id": "acme-3000",
      "brand": "ACME",
      "model": "PowerLogic 3000",
      "description": "From datasheet rev C. Energy registers unverified on hardware.",
      "function": "read_holding_registers",
      "defaultUnitId": 1,
      "suggestedRtu": { "baudRate": 9600, "dataBits": 8, "parity": "even", "stopBits": 1 },
      "points": [
        {
          "key": "voltage_ln",
          "label": "Voltage L-N",
          "address": 100,
          "format": { "dataType": "float32", "wordOrder": "cdab", "scale": 1.0, "offset": 0.0 },
          "unit": "V",
          "group": "instantaneous",
          "simBehavior": { "kind": "random", "min": 228.0, "max": 242.0 },
          "simInitial": 230.0
        },
        {
          "key": "current_a",
          "label": "Current A",
          "address": 102,
          "format": { "dataType": "uint16", "wordOrder": "cdab", "scale": 0.1, "offset": 0.0 },
          "unit": "A",
          "group": "instantaneous",
          "simBehavior": { "kind": "random", "min": 0.5, "max": 9.0 },
          "simInitial": 5.0
        },
        {
          "key": "energy_import",
          "label": "Energy import",
          "address": 3000,
          "format": { "dataType": "uint32", "wordOrder": "cdab", "scale": 0.01, "offset": 0.0 },
          "unit": "kWh",
          "group": "energy",
          "unverified": true,
          "simBehavior": { "kind": "counter", "step": 1.0 },
          "simInitial": 100000.0
        },
        {
          "key": "device_temp",
          "label": "Device temperature",
          "address": 30,
          "format": { "dataType": "int16", "wordOrder": "cdab", "scale": 0.1, "offset": 0.0 },
          "unit": "degC",
          "function": "read_input_registers",
          "group": "diagnostics",
          "simBehavior": { "kind": "sine", "min": 30.0, "max": 55.0, "periodS": 60.0 }
        }
      ]
    }
  ]
}
```

---
name: meter-profile
description: Use when adding a new meter to ModbusOpen's built-in library, editing an existing meter profile, or translating a vendor register map / the Carbon Minus firmware's meter_register_constants.py into a ModbusOpen profile. Ensures every profile is verified against a real datasheet or source file before it can show a number.
---

# Adding or editing a meter profile

A wrong number is worse than an error. Never invent data types or scales.

## Where a register map comes from

1. **Carbon Minus firmware** (parameter-major dicts in
   `meter_register_constants.py`, per-meter overrides in `meter_codes/*.py`).
2. **Vendor datasheet** (register list + data type + byte/word order).
3. **Live capture** in the app (Meter editor → *Capture from current poll*).

### Firmware transpose rules (verified from source)

| Fact | Rule |
|---|---|
| Read function | FC03 holding registers |
| Default quantity | 100 (`MAXIMUM_NO_COUNT`) |
| Address base in tables | 1-based documented |
| Wire address | `doc_addr − 1` (`METER_REG_OFFSET = 1`) |
| Default decode | float32 **CDAB** |
| RTU defaults | 9600 8-E-1 |
| String-valued dict entries | Not mapped — drop them |
| Per-meter type/scale | From `meter_codes/<meter>.py` only |

Regenerate bulk skeletons with:

```bash
python3 scripts/extract_meter_profiles.py \
  --firmware /path/to/iot_firmware_v2 \
  --out src-tauri/src/modbus/meters/builtin
```

Then **reconcile** each profile by hand. Extracted points are `unverified: true`.

## The addressing trap

- Internally **always 0-based wire addresses**.
- Convert to 1-based / 4xxxx **only at the display layer**.
- A map that says "register 101" is wire `100`.
- Off-by-one is the #1 bug source in this repo (AGENTS.md).

## Establishing the data type

1. Open `meter_codes/<meter>.py` (or the datasheet).
2. Note word order, scale, and multi-register layout.
3. float32 CDAB is the *default*, never the assumption.
4. If you cannot establish type/scale, leave `"unverified": true` and ship the
   profile with the Unverified badge. **Do not guess.**

## JSON schema (worked example)

File: `src-tauri/src/modbus/meters/builtin/<id>.json`

```json
{
  "id": "lt-electrical-meter",
  "brand": "L&T",
  "model": "4-quadrant energy meter",
  "description": "Verified from docs/reference/device-profiles.md",
  "source": { "kind": "built_in" },
  "function": "read_holding_registers",
  "blockStart": 100,
  "blockCount": 120,
  "defaultUnitId": 1,
  "suggestedRtu": {
    "baudRate": 9600,
    "dataBits": 8,
    "parity": "even",
    "stopBits": 1
  },
  "points": [
    {
      "key": "active_power",
      "label": "Active Power",
      "address": 100,
      "format": {
        "dataType": "float32",
        "wordOrder": "cdab",
        "scale": 1.0,
        "offset": 0.0
      },
      "unit": "kW",
      "group": "instantaneous",
      "unverified": false,
      "simBehavior": { "kind": "random", "min": 145.0, "max": 155.0 },
      "simInitial": 150.0
    }
  ]
}
```

Optional `simBehavior` / `simInitial` drive the simulator when the profile is
loaded as a slave (*Load in simulator* in the meter library).

## Register it

1. Add/edit the JSON under `src-tauri/src/modbus/meters/builtin/`.
2. Add `include_str!("builtin/<file>.json")` to `BUILTIN_JSON` in
   `src-tauri/src/modbus/meters/mod.rs`.
3. Run tests:

```bash
cd src-tauri && cargo test meters && cargo clippy --all-targets -- -D warnings
```

4. End-to-end: load the profile into ModbusOpen's simulator, scan it with the
   scanner, confirm a known value. Cross-check with `mbpoll` if available
   (`modbus-test-rig` skill).

## Verification checklist before the profile ships

- [ ] Parses and passes `validate_meter_profile`
- [ ] Every point lies inside `[blockStart, blockStart + blockCount)` for its span
- [ ] Data type + word order + scale taken from a named source (file path or datasheet)
- [ ] Unverified points are marked; profile badge is honest
- [ ] Simulated or real device read-back matches expected values
- [ ] Raw hex column still visible next to every decoded value

## Symptom → cause

| Symptom | Likely cause |
|---|---|
| Values ~65536× off | Wrong word order |
| Value halved/doubled | Wrong scale |
| Everything shifted by one | Address base (0 vs 1) |
| All zeros | Wrong block start or FC04 instead of FC03 |
| Exception 02 | Point/block outside the device map |
| Plausible but wrong float | Guessed CDAB without checking meter_codes |

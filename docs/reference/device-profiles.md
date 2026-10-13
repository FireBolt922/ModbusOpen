# Device profiles

Real register maps, extracted from the working simulator scripts at
`carbon_minus_iot_firmware_v2/iot_firmware_v2/modbus_simulator/`.

These are **ground truth** — they've been read by actual meters in the field. They are
reference data for the decoder and example inputs for the app; they are not bundled runtime
profiles. The repository's `profiles/` directory contains example `.mbmeter.json` packs that
users import manually. The app stores imported profiles in the user's meter library rather than
loading files from the repository automatically. They remain useful as conformance data for
verifying the decoder ([testing §5](../06-testing.md#5-verify-against-the-existing-scripts)).

## What the original scripts actually are

Worth being precise, because the naming misleads. They are **not** slave simulators. Each one is a
Modbus **TCP client** that connects to an existing slave at `192.168.1.69:502` and pushes values in
with FC16 (`write_registers`). The slave is somewhere else; these just inject data into it.

ModbusOpen's simulator inverts this: it **is** the slave. Same register maps, same value
generation, but it listens instead of connecting. That's strictly better for testing — no separate
slave process to run.

Two other notes carried over:

- They target `pymodbus` 2.x (`pymodbus.client.sync`, `BinaryPayloadBuilder`), both removed in
  pymodbus 3.8+. `read_data.py` already mixes in the 3.x `device_id=` kwarg, so the folder no longer
  runs against a single pymodbus version. Nothing to fix — ModbusOpen replaces them — but don't
  copy the API usage.
- Every 32-bit value uses `byteorder=Endian.Big, wordorder=Endian.Little`, which is
  **[CDAB](data-types-word-order.md)**.

---

## Profile 1 — L&T electrical meter

Source: `electrical_write_data.py`

```
Transport      TCP
Unit ID        1
Block          Holding registers, 120 registers from wire address 100
Data type      float32 CDAB (uint32 CDAB for run hours)
Update rate    1000 ms
```

Documented addresses in the source are 1-based (`101`, `109`, …); the offsets are computed as
`reg - 100 - 1`, giving 0-based wire addresses relative to the block start at 100.

| Doc addr | Wire addr | Tag | Type | Behaviour |
|---|---|---|---|---|
| 101 | 100–101 | Active Power | float32 CDAB | random 145.0 – 155.0 |
| 109 | 108–109 | Reactive Power | float32 CDAB | random 10.0 – 12.0 |
| 117 | 116–117 | Power Factor | float32 CDAB | random 0.95 – 0.99 |
| 125 | 124–125 | Demand Total | float32 CDAB | random 48.0 – 52.0 |
| 133 | 132–133 | Frequency | float32 CDAB | random 49.9 – 50.1 |
| 149 | 148–149 | Voltage Average | float32 CDAB | random 225.0 – 235.0 |
| 151 | 150–151 | Current Total | float32 CDAB | random 14.0 – 16.0 |
| 159 | 158–159 | Energy Received | float32 CDAB | random 1000.0 – 1001.0 |
| 161 | 160–161 | VAH Received | float32 CDAB | random 1050.0 – 1051.0 |
| 217 | 216–217 | Run Hours | uint32 CDAB | counter, +1/hour, start 100 |

All other registers in the 120-register block are zero. That's realistic — real meter maps are
sparse, and it's a good test of whether the scanner handles zero-filled gaps sensibly.

**This is the best M1 acceptance target.** It exercises float32 CDAB, a mixed uint32 tag, a sparse
map, and a realistic 120-register read (just under the 125-register FC03 limit).

---

## Profile 2 — VFD (variable frequency drive)

Source: `vfd_write_data.py`

```
Transport      TCP
Unit ID        1
Block          Holding registers, 25 registers from wire address 256 (0x100)
Data type      uint16 with per-register scaling
Update rate    1000 ms
```

Note the contrast with the meter: all 16-bit integers with implied decimal scaling, no floats.
This is very common on drives, and it's exactly why [scale/offset](data-types-word-order.md#scale-and-offset)
belongs in the data format.

| Hex | Wire | Tag | Raw | Scale | Real |
|---|---|---|---|---|---|
| 0x100 | 256 | Running Frequency | 5179 | 0.01 | 51.79 Hz |
| 0x101 | 257 | Running Speed | 1485 | 1 | 1485 rpm |
| 0x102 | 258 | Phase U DC Voltage | 540 | 1 | 540 V |
| 0x103 | 259 | Phase V DC Voltage | 541 | 1 | 541 V |
| 0x104 | 260 | Phase W DC Voltage | 539 | 1 | 539 V |
| 0x105 | 261 | Input Voltage Uab | 415 | 1 | 415 V |
| 0x106 | 262 | Input Voltage Ubc | 414 | 1 | 414 V |
| 0x107 | 263 | Input Voltage Uca | 416 | 1 | 416 V |
| 0x108 | 264 | Input Current Ia | 13 | 0.1 | 1.3 A |
| 0x109 | 265 | Input Current Ib | 7 | 0.1 | 0.7 A |
| 0x10A | 266 | Input Current Ic | 2 | 0.1 | 0.2 A |
| 0x10B | 267 | Output Current Iu | 5 | 0.1 | 0.5 A |
| 0x10C | 268 | Output Current Iv | 3 | 0.1 | 0.3 A |
| 0x10D | 269 | Output Current Iw | 2 | 0.1 | 0.2 A |
| 0x10E | 270 | Output Voltage Uuv | 415 | 1 | 415 V |
| 0x10F | 271 | Output Voltage Uvw | 414 | 1 | 414 V |
| 0x110 | 272 | Output Voltage Uwu | 416 | 1 | 416 V |
| 0x111 | 273 | Running Time | 25 | 1 | 25 h |
| **0x112** | **274** | **Fault Indication** | 0 | — | fault code |
| **0x113** | **275** | **Operation Record** | 0 | — | 3 = reset |
| **0x114** | **276** | **Alarm Indication** | 0 | — | alarm code |
| 0x115 | 277 | Given Speed | 1485 | 1 | 1485 rpm |
| 0x116 | 278 | Input Power | 5500 | 1 | 5500 W |
| 0x117 | 279 | Input Power Factor | 98 | 0.01 | 0.98 |
| 0x118 | 280 | Output Power | 5200 | 1 | 5200 W |

### Fault/alarm cycling — deferred to v2

The original script runs a 20-second state machine: 10 s normal → inject a random fault + alarm
for 1 s → clear → at t=20 s write operation code 3 (reset) → repeat.

That needs a `Sequence` behaviour (timed list of states) which v1's five behaviours don't cover.
It's in the [backlog](../backlog.md). The v1 profile ships these three registers as `static 0`, and
the user can edit them by hand in the live table to trigger a fault — which is arguably more useful
for testing anyway, since you control *when*.

Fault and alarm code lists (for a future `Sequence` behaviour and for value annotation) are in
`vfd_write_data.py` — 44 fault codes and 26 alarm codes. Copy them verbatim when implementing;
don't retype them.

---

## Profile 3 — Flow meter

Source: `other_meters_write_data.py`

```
Transport      TCP
Unit ID        2          ← note: different unit ID from the others
Block          Holding registers, 4 registers from wire address 0
Update rate    1000 ms
```

| Wire | Tag | Type | Behaviour |
|---|---|---|---|
| 0–1 | Flow Rate | float32 CDAB | random 5.0 – 15.0 |
| 2–3 | Totaliser | uint32 CDAB | counter, +10/s |

Small, but valuable for two reasons: it starts at **wire address 0** (which catches off-by-one bugs
that a block starting at 100 would hide), and it uses **unit ID 2**, so running it alongside profile 1
gives a two-slave test — exactly what the M1 "change unit ID on the fly" acceptance criterion needs.

---

## Implementation notes

1. The files under `profiles/` are example `.mbmeter.json` packs, not files the app bundles or
   loads automatically. The format is documented in
   [Meter pack (shareable)](../05-data-model.md#meter-pack-shareable).
2. Import a pack from the app's **Meters → Import** action. The import path previews each profile,
   validates it, and lets the user skip, overwrite, or rename duplicate IDs.
3. Imported profiles are stored in the user's OS app-data `meters/` library and can then be used
   by the app's supported meter workflows.
4. To propose a new meter pack, add the datasheet/source details to the
   [meter profile issue template](../../issues/9) before opening a PR.

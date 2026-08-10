---
name: meter-config
description: Build a shareable ModbusOpen meter config file (.mbmeter.json) from a datasheet, register table, spreadsheet, PDF, or firmware source — so a meter map can be created once and imported by the whole team. Use this whenever someone wants to create, write, generate, hand-edit, fix, review, or share a meter profile / meter pack / register map / parameter list for ModbusOpen, or asks how to get a device's registers into the app without typing them into the editor one at a time. Also use it when an existing .mbmeter.json is rejected on import, imports but reads wrong values, or simulates as all zeros.
---

# Meter config files

A meter config is a JSON file describing a device's register map. One person builds it,
everyone else imports it — so a mistake in this file is a mistake on every machine that
receives it, discovered later and somewhere else. That asymmetry is what this skill is about.

Read `references/schema.md` before writing any JSON. It has the exact field names, enum
spellings, and the full worked example. Don't write the file from memory.

## The one rule that matters

**Never invent a register address.** If the source doesn't state where a parameter lives,
it doesn't go in the file. A fabricated address doesn't fail loudly — it reads a real
register that means something else, and a plausible number appears on a dashboard next to
live switchgear. Leave the parameter out and say which ones you left out and why.

Same goes for anything you inferred rather than read: mark the point `"unverified": true`
and note it in `description`. The person importing this has no way to know what you were
sure about unless you tell them in the file.

## Workflow

### 1. Settle the addressing base before anything else

`address` in the file is **always the 0-based wire address**. Datasheets almost never print
that. This is the single most common way a meter config ends up reading the wrong register,
and it's silent — every value is wrong by a constant offset and still looks like a number.

| The datasheet prints | Subtract | Implies |
|---|---|---|
| `40001`-style (4xxxx) | 40001 | holding registers, `read_holding_registers` |
| `30001`-style (3xxxx) | 30001 | input registers, `read_input_registers` |
| plain, starting at 1 | 1 | ask which function |
| plain, starting at 0 | 0 | already the wire address |

Watch for the tell: a table whose first row is `40001` or `1` is offset. A table starting
at `0`, or one that says "protocol address" / "wire address" / "PLC address − 1", is not.
Some vendors print both columns — use the one that starts at 0.

If the source is genuinely ambiguous, ask. Guessing here is worse than a question, because
the resulting file is confidently wrong. When you do settle it, say so in one line
("read as 4xxxx, so 40101 → wire 100") — that's the sentence the user can check.

### 2. Extract the parameters

For each row of the register table you need: name, address, data type, and unit.

Map the datasheet's vocabulary to the enums in `references/schema.md`:

| Datasheet says | Use |
|---|---|
| "float", "IEEE-754", "REAL", "2 registers" with decimals | `float32` |
| "unsigned", "2 registers", a counter | `uint32` |
| "signed 16-bit", temperature or power that can go negative | `int16` |
| "resolution 0.1", "value ×10", "scaling factor 100" | integer type + `scale` |

`scale` multiplies the raw register value. Work out the direction from a worked example
rather than a habit — real maps in this shop use both: "resolution 0.1 A" means the register
holds 2371 for 237.1 A, so `scale: 0.1`, but a sheet whose register counts in units of ten
needs `scale: 10.0`. Getting the direction backwards is a 100× error in a number the reader
has no intuition for, so if the sheet gives a sample reading, check against it.

Word order for multi-register values is usually *not* on the datasheet, and there is no
safe universal default — the real maps here run roughly two-thirds `cdab` to one-third
`abcd`, split by vendor rather than by anything you can derive (Schneider maps are `abcd`,
most others `cdab`). If the source or a sibling map from the same vendor tells you, follow
it. Otherwise use `cdab`, mark the points `unverified`, and say in `description` that word
order is an assumption — the symptom of a wrong guess is a wildly wrong float (`3.6e-38`
territory), not an error, so the recipient needs to know to check it first.

Keys are `snake_case`, unique, and stable — a colleague's logs and exports are keyed on
them, so renaming one later breaks their history. Derive from the label.

### 3. Watch for overlaps as you go

A `float32` at 100 occupies **100 and 101**. The next parameter starts at 102. Two
parameters sharing a register is a hard rejection on import, and it's the failure the
checker catches most often — usually a table of 32-bit values whose addresses increment
by 1 instead of 2. If you see that pattern, the addresses are probably fine and the data
type is wrong, or vice versa; look at the whole table before deciding which.

### 4. Give every parameter a simulation behaviour

`simBehavior` is what makes the shared file useful to someone with no hardware in front of
them — they import it, hit Load in simulator, and see plausible readings. Omit it and their
meter serves a wall of zeros, which looks exactly like a broken config.

Pick something realistic for what the parameter measures: `random` in a narrow band for a
voltage, `counter` for an energy total, `sine` for a temperature. The range costs nothing to
get roughly right and is what makes a demo look real.

One trap: an integer register can't hold a fraction. A `random` between 0.5 and 0.9 on a
`uint16` quantises to 0 or 1 and looks frozen — unless `scale` divides it back down, which
is exactly what a scaled integer already does. The checker warns about this.

### 5. Check it

```bash
python3 .agents/skills/meter-config/scripts/check_meter_pack.py <file>
```

This mirrors the app's own validation and read planner. If it passes, the import dialog
will accept the file; if it warns, the file imports but something will behave oddly.

It also prints the read plan — how many Modbus requests the meter takes per poll. Worth
reading back to the user: a map whose parameters are spread out is several requests, and
that's expected and fine (the app plans them; nothing is dropped). But a plan with far more
requests than the table has clusters usually means an address got mistyped by an order of
magnitude.

Fix and re-run until clean. Don't hand over a file the checker rejects.

### 6. Hand it over

Name it `<id>.mbmeter.json`. Tell the user where it is and what the colleague does:
**Meters → Import**, pick the file, confirm. If they already have a meter with that id the
importer offers rename, overwrite, or skip.

Then say plainly what's in the file and what isn't: how many parameters, which ones you
marked unverified, which rows of the source you skipped, and what you assumed (addressing
base, word order). That paragraph is the handover — it's what stops the recipient trusting
a number nobody has checked.

## Reviewing or fixing an existing file

Run the checker first — it names the problem in the app's own words. Then:

| Symptom | Usually |
|---|---|
| Rejected on import | The checker says why. Overlapping registers or a non-slug `id` most often. |
| Every value wrong by a constant | Addressing base — the whole table is off by 40001 or 1. |
| Floats absurd (`1e-40`, `3e38`) | `wordOrder`. Try `abcd` if `cdab` was assumed. |
| Values 10× / 100× off | `scale` inverted, or applied when the register was already scaled. |
| One parameter reads garbage, rest fine | Wrong `dataType` for that row, or it overlaps its neighbour. |
| Simulates as all zeros | No `simBehavior` on any point. |
| A parameter never updates | Its address isn't covered — check the read plan the checker prints. |

## Multiple meters in one file

`profiles` is a list. A pack of a whole product family imports in one go, which is usually
what a team wants. Each profile needs its own unique `id`.

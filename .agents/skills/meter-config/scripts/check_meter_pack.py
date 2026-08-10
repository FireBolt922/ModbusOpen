#!/usr/bin/env python3
"""Check a .mbmeter.json file the way ModbusOpen will when someone imports it.

This mirrors `validate_meter_profile` (src-tauri/src/modbus/validate.rs),
`plan_reads` and `profile_to_simulator_config`
(src-tauri/src/modbus/meters/mod.rs). If this script is happy, the import
dialog will be too — and the read plan printed here is the one the poll engine
will actually execute.

    python3 check_meter_pack.py path/to/meter.mbmeter.json

Exit status is 0 when the file imports cleanly, 1 when it doesn't.
Warnings never fail the check; they flag things that import fine but behave
badly (most often a meter that simulates as a wall of zeros).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# --- the enums, exactly as serde spells them on disk ------------------------

MAX_QUANTITY = {
    "read_coils": 2000,
    "read_discrete_inputs": 2000,
    "read_holding_registers": 125,
    "read_input_registers": 125,
}
READ_FUNCTIONS = set(MAX_QUANTITY)

REGISTER_SPAN = {
    "bool": 1,
    "uint16": 1,
    "int16": 1,
    "hex16": 1,
    "binary16": 1,
    "uint32": 2,
    "int32": 2,
    "float32": 2,
    "uint64": 4,
    "int64": 4,
    "float64": 4,
    "string": 0,  # rejected in meter profiles
}
WORD_ORDERS = {"abcd", "cdab", "badc", "dcba"}
GROUPS = {"instantaneous", "energy", "harmonics", "diagnostics", "other"}
BEHAVIOR_FIELDS = {
    "static": (),
    "random": ("min", "max"),
    "ramp": ("min", "max", "step"),
    "sine": ("min", "max", "periodS"),
    "counter": ("step",),
}

ADDRESS_SPACE = 0x1_0000
MAX_WASTED_REGISTERS = 32  # keep in step with modbus/meters/mod.rs


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def error(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)


# --- validation -------------------------------------------------------------


def is_slug(value: str) -> bool:
    return value != "" and all(c.isascii() and (c.isalnum() or c in "-_") for c in value)


def check_profile(profile: dict, report: Report) -> None:
    """Reject anything `validate_meter_profile` would reject, with its reasons."""
    where = profile.get("id") or "<no id>"

    pid = profile.get("id", "")
    if not isinstance(pid, str) or not pid.strip():
        report.error(f"{where}: meter id can't be empty")
    elif not is_slug(pid):
        # The id becomes a filename in the importer's meter library, so a
        # shared file must not be able to name a path outside it.
        report.error(
            f"{where}: id must use only letters, digits, '-' and '_' "
            "(e.g. 'schneider-pm5320')"
        )

    for field in ("brand", "model"):
        if not str(profile.get(field, "")).strip():
            report.error(f"{where}: {field} can't be empty")

    unit = profile.get("defaultUnitId")
    if not isinstance(unit, int) or isinstance(unit, bool) or not 1 <= unit <= 247:
        report.error(f"{where}: defaultUnitId must be 1-247, got {unit!r}")

    # `source` is an untagged-by-kind enum in Rust: anything but these two
    # spellings fails to deserialize before validation even runs.
    source = profile.get("source")
    if source is not None:
        if not isinstance(source, dict) or source.get("kind") not in ("user", "imported"):
            report.error(
                f"{where}: source must be omitted, {{\"kind\":\"user\"}} or "
                f'{{"kind":"imported","from":"..."}} — got {source!r}'
            )
        elif source.get("kind") == "imported" and not isinstance(source.get("from"), str):
            report.error(f"{where}: source kind 'imported' needs a string 'from'")

    default_fn = profile.get("function")
    if default_fn not in READ_FUNCTIONS:
        report.error(
            f"{where}: function must be one of {sorted(READ_FUNCTIONS)}, got {default_fn!r}"
        )
        default_fn = "read_holding_registers"

    points = profile.get("points")
    if not isinstance(points, list) or not points:
        report.error(f"{where}: a meter needs at least one parameter")
        return

    owner: dict[tuple[str, int], str] = {}
    keys: set[str] = set()
    animated = 0

    for i, point in enumerate(points):
        label = point.get("key") or f"points[{i}]"
        tag = f"{where}/{label}"

        key = point.get("key", "")
        if not str(key).strip():
            report.error(f"{tag}: key can't be empty")
        elif key in keys:
            report.error(f"{tag}: duplicate key '{key}'")
        else:
            keys.add(key)

        if not str(point.get("label", "")).strip():
            report.error(f"{tag}: needs a label")

        fmt = point.get("format")
        if not isinstance(fmt, dict):
            report.error(f"{tag}: missing 'format' object")
            continue

        dtype = fmt.get("dataType")
        if dtype not in REGISTER_SPAN:
            report.error(f"{tag}: unknown dataType {dtype!r}")
            continue
        if dtype == "string":
            report.error(f"{tag}: the string data type isn't supported in meter profiles")
            continue
        span = REGISTER_SPAN[dtype]

        if fmt.get("wordOrder") not in WORD_ORDERS:
            report.error(
                f"{tag}: wordOrder must be one of {sorted(WORD_ORDERS)}, "
                f"got {fmt.get('wordOrder')!r}"
            )
        for num in ("scale", "offset"):
            if not isinstance(fmt.get(num), (int, float)) or isinstance(fmt.get(num), bool):
                report.error(f"{tag}: format.{num} must be a number")
        if fmt.get("scale") == 0:
            report.warn(f"{tag}: scale is 0, so this parameter always reads 0")

        group = point.get("group", "instantaneous")
        if group not in GROUPS:
            report.error(f"{tag}: group must be one of {sorted(GROUPS)}, got {group!r}")

        fn = point.get("function") or default_fn
        if fn not in READ_FUNCTIONS:
            report.error(f"{tag}: function must be one of {sorted(READ_FUNCTIONS)}, got {fn!r}")
            fn = default_fn

        addr = point.get("address")
        if not isinstance(addr, int) or isinstance(addr, bool) or addr < 0 or addr > 0xFFFF:
            report.error(f"{tag}: address must be a 0-based wire address 0-65535, got {addr!r}")
            continue

        if span > MAX_QUANTITY[fn]:
            report.error(f"{tag}: needs {span} registers but {fn} allows {MAX_QUANTITY[fn]}")
        if addr + span > ADDRESS_SPACE:
            report.error(f"{tag}: address {addr} + {span} registers runs past the address space")
            continue

        for reg in range(addr, addr + span):
            prev = owner.get((fn, reg))
            if prev is not None:
                # Overlapping parameters decode from partly the same bytes and
                # produce plausible garbage rather than an error — far worse
                # than a rejected file.
                report.error(
                    f"{where}: '{prev}' and '{key}' both cover register {reg} on {fn} "
                    "— check their addresses and data types"
                )
            else:
                owner[(fn, reg)] = str(key)

        behavior = point.get("simBehavior")
        if behavior is not None:
            animated += 1
            scale = fmt.get("scale")
            check_behavior(
                behavior, tag, dtype,
                scale if isinstance(scale, (int, float)) and scale else 1.0,
                report,
            )

    if points and animated == 0:
        report.warn(
            f"{where}: no parameter has simBehavior, so loading this meter into the "
            "simulator serves zeros for everything"
        )


def check_behavior(
    behavior: object, tag: str, dtype: str, scale: float, report: Report
) -> None:
    """Simulator rules — these bite on 'Load in simulator', not on import."""
    if not isinstance(behavior, dict):
        report.error(f"{tag}: simBehavior must be an object")
        return
    kind = behavior.get("kind")
    if kind not in BEHAVIOR_FIELDS:
        report.error(f"{tag}: simBehavior.kind must be one of {sorted(BEHAVIOR_FIELDS)}")
        return
    for field in BEHAVIOR_FIELDS[kind]:
        if not isinstance(behavior.get(field), (int, float)) or isinstance(
            behavior.get(field), bool
        ):
            report.error(f"{tag}: simBehavior '{kind}' needs a numeric '{field}'")
            return

    if kind in ("random", "ramp", "sine") and behavior["min"] >= behavior["max"]:
        report.error(f"{tag}: simBehavior min must be less than max")
    if kind == "sine" and behavior["periodS"] <= 0:
        report.error(f"{tag}: simBehavior period must be greater than 0 seconds")

    # An integer register can't hold a fraction. A 0..1 random on a uint16
    # quantises to a dead-looking 0 or 1. What matters is the span in *raw*
    # register counts, not engineering units — a 0.5..0.9 A range on a
    # milliamp register (scale 0.001) moves 400 counts and animates fine.
    if kind in ("random", "ramp", "sine") and dtype not in ("float32", "float64"):
        raw_span = abs(behavior["max"] - behavior["min"]) / abs(scale)
        if raw_span < 1:
            report.warn(
                f"{tag}: {dtype} is a whole-number register and the simulated range covers "
                f"only {raw_span:.3g} register counts — it will look frozen. Widen the range "
                f"or lower format.scale"
            )


# --- read planning (mirrors plan_reads) -------------------------------------


def plan_reads(profile: dict) -> list[dict]:
    groups: list[tuple[str, list[dict]]] = []
    default_fn = profile.get("function", "read_holding_registers")
    for point in profile.get("points", []):
        fn = point.get("function") or default_fn
        for existing_fn, lst in groups:
            if existing_fn == fn:
                lst.append(point)
                break
        else:
            groups.append((fn, [point]))

    plan: list[dict] = []
    for fn, points in groups:
        points = sorted(points, key=lambda p: p.get("address", 0))
        max_quantity = MAX_QUANTITY.get(fn, 125)
        start = end = 0
        open_block = False

        for point in points:
            span = max(1, REGISTER_SPAN.get(point.get("format", {}).get("dataType"), 1))
            addr = point.get("address", 0)
            point_end = min(addr + span, ADDRESS_SPACE)

            if open_block:
                gap = max(0, addr - end)
                if point_end - start <= max_quantity and gap <= MAX_WASTED_REGISTERS:
                    end = max(end, point_end)
                    continue
                plan.append({"function": fn, "startAddress": start, "quantity": end - start})
            start, end, open_block = addr, point_end, True

        if open_block:
            plan.append({"function": fn, "startAddress": start, "quantity": end - start})
    return plan


def describe_plan(profile: dict) -> list[str]:
    plan = plan_reads(profile)
    lines = []
    word = "request" if len(plan) == 1 else "requests"
    lines.append(f"  reads in {len(plan)} {word} per poll:")
    used = sum(
        max(1, REGISTER_SPAN.get(p.get("format", {}).get("dataType"), 1))
        for p in profile.get("points", [])
    )
    fetched = 0
    for i, block in enumerate(plan, 1):
        first, last = block["startAddress"], block["startAddress"] + block["quantity"] - 1
        fetched += block["quantity"]
        covered = sum(
            1
            for p in profile.get("points", [])
            if (p.get("function") or profile.get("function")) == block["function"]
            and first <= p.get("address", 0) <= last
        )
        lines.append(
            f"    {i}. {block['function']} wire {first}-{last} "
            f"({block['quantity']} registers, {covered} parameters)"
        )
    if fetched > used:
        lines.append(
            f"  {fetched} registers fetched for {used} of data "
            f"({fetched - used} spare ride along inside the groups)"
        )
    return lines


# --- entry point ------------------------------------------------------------


def profiles_from(payload: object, report: Report) -> list[dict]:
    """Accept a pack envelope or a bare profile, as the importer does."""
    if isinstance(payload, dict) and "profiles" in payload:
        kind = payload.get("kind")
        if kind not in ("meter-pack", "profile"):
            report.error(f"unsupported pack kind {kind!r} — expected 'meter-pack'")
        if payload.get("version") != 1:
            report.error(f"pack version must be 1, got {payload.get('version')!r}")
        profiles = payload.get("profiles")
        if not isinstance(profiles, list) or not profiles:
            report.error("pack contains no meter profiles")
            return []
        return [p for p in profiles if isinstance(p, dict)]
    if isinstance(payload, dict):
        return [payload]
    report.error("file isn't a meter pack or a single meter profile")
    return []


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    path = Path(argv[1])
    report = Report()

    try:
        payload = json.loads(path.read_text())
    except FileNotFoundError:
        print(f"FAIL  no such file: {path}")
        return 1
    except json.JSONDecodeError as e:
        print(f"FAIL  {path.name} isn't valid JSON — {e}")
        return 1

    profiles = profiles_from(payload, report)
    summaries: list[str] = []
    for profile in profiles:
        check_profile(profile, report)
        name = f"{profile.get('brand', '?')} {profile.get('model', '?')}"
        summaries.append(
            f"  {profile.get('id', '?')} — {name}, "
            f"{len(profile.get('points') or [])} parameters, unit {profile.get('defaultUnitId')}"
        )
        summaries.extend(describe_plan(profile))

    print(f"{path.name}: {len(profiles)} profile(s)")
    for line in summaries:
        print(line)

    for warning in report.warnings:
        print(f"WARN  {warning}")
    for error in report.errors:
        print(f"FAIL  {error}")

    if report.errors:
        print(f"\n{len(report.errors)} problem(s) — this file will be rejected on import.")
        return 1
    print("\nOK — imports cleanly.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

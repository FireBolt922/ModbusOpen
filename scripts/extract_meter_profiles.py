#!/usr/bin/env python3
"""
Transpose Carbon Minus firmware meter maps (parameter-major) into ModbusOpen
meter profiles (meter-major JSON).

Provenance-only tool: run against a local checkout of carbon_minus_iot_firmware_v2.
Generated profiles default to float32 CDAB and unverified=true except where this
script hard-codes verified maps (L&T electrical, VFD, flow meter from
docs/reference/device-profiles.md).

Usage:
  python3 development/extract_meter_profiles.py \\
    --firmware ~/Desktop/CarbonMinusProjects/carbon_minus_iot_firmware_v2/iot_firmware_v2 \\
    --out src-tauri/src/modbus/meters/builtin
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

# Electrical meters with real integer register maps. Excludes PLC, DLMS,
# flow/BTU/sensor placeholders, and string-only sample entries.
INCLUDE_COMPANIES = {
    "L_T",
    "L_T_VEGA",
    "SCHNEIDER",
    "SCHNEIDER_6400",
    "SCHNEIDER_6433",
    "SCHNEIDER_6436H",
    "SCHNEIDER_6300",
    "SCHNEIDER_EM_7230",
    "SCHNEIDER_EM_1200",
    "SCHNEIDER_6433H",
    "SCHNEIDER_PM_5320",
    "COMPACT_SCHNEIDER",
    "RISH_Master_3430",
    "RISH_EM1330",
    "RISH_LM_1360",
    "RISH_MASTER_3440",
    "RISH_DELTA_ENERGY_NX",
    "ELMEASURE",
    "SECURE_ELITE_440_ABS",
    "SECURE_ELITE_440",
    "SECURE_ELITE_100",
    "SELEC",
    "SELEC_383A",
    "SELEC_384",
    "SELEC_386",
    "SELEC_MFM384RC",
    "SIEMENS_7KT0310",
    "SIEMENS_PAC3200",
    "DIGI_250",
    "DIGI_620",
    "DIGI_720",
    "MEATROL_ME_337",
    "GOBLIN_TRINITY",
    "TRINITY_NF_29",
    "PM130_PLUS",
    "SOCOMEC_A40",
    "QUASAR",
    "EMFIS_HPL_VIE",
    "ICD_MFM_9012",
}

BRAND_MODEL = {
    "L_T": ("L&T", "4-quadrant energy meter"),
    "L_T_VEGA": ("L&T", "VEGA"),
    "SCHNEIDER": ("Schneider", "EM series (generic)"),
    "SCHNEIDER_6400": ("Schneider", "6400"),
    "SCHNEIDER_6433": ("Schneider", "6433"),
    "SCHNEIDER_6436H": ("Schneider", "6436H"),
    "SCHNEIDER_6300": ("Schneider", "6300"),
    "SCHNEIDER_EM_7230": ("Schneider", "EM 7230"),
    "SCHNEIDER_EM_1200": ("Schneider", "EM 1200"),
    "SCHNEIDER_6433H": ("Schneider", "6433H"),
    "SCHNEIDER_PM_5320": ("Schneider", "PM 5320"),
    "COMPACT_SCHNEIDER": ("Schneider", "Compact"),
    "RISH_Master_3430": ("RISH", "Master 3430"),
    "RISH_EM1330": ("RISH", "EM1330"),
    "RISH_LM_1360": ("RISH", "LM 1360"),
    "RISH_MASTER_3440": ("RISH", "Master 3440"),
    "RISH_DELTA_ENERGY_NX": ("RISH", "Delta Energy NX"),
    "ELMEASURE": ("Elmeasure", "Elmeasure"),
    "SECURE_ELITE_440_ABS": ("Secure", "Elite 440 ABS"),
    "SECURE_ELITE_440": ("Secure", "Elite 440"),
    "SECURE_ELITE_100": ("Secure", "Elite 100"),
    "SELEC": ("Selec", "SELEC"),
    "SELEC_383A": ("Selec", "383A"),
    "SELEC_384": ("Selec", "384"),
    "SELEC_386": ("Selec", "386"),
    "SELEC_MFM384RC": ("Selec", "MFM384RC"),
    "SIEMENS_7KT0310": ("Siemens", "7KT0310"),
    "SIEMENS_PAC3200": ("Siemens", "PAC3200"),
    "DIGI_250": ("Digi", "250"),
    "DIGI_620": ("Digi", "620"),
    "DIGI_720": ("Digi", "720"),
    "MEATROL_ME_337": ("Meatrol", "ME-337"),
    "GOBLIN_TRINITY": ("Goblin", "Trinity"),
    "TRINITY_NF_29": ("Trinity", "NF-29"),
    "PM130_PLUS": ("SATEC", "PM130 Plus"),
    "SOCOMEC_A40": ("Socomec", "A40"),
    "QUASAR": ("Quasar", "Quasar"),
    "EMFIS_HPL_VIE": ("EMFIS", "HPL VIE"),
    "ICD_MFM_9012": ("ICD", "MFM-9012"),
}

PARAM_META = {
    "ACTIVE_POWER": ("Active Power", "kW", "instantaneous"),
    "REACTIVE_POWER": ("Reactive Power", "kVAr", "instantaneous"),
    "APPARENT_POWER": ("Apparent Power", "kVA", "instantaneous"),
    "POWER_FACTOR": ("Power Factor", "", "instantaneous"),
    "FREQUENCY": ("Frequency", "Hz", "instantaneous"),
    "VOLTAGE_AVERAGE": ("Voltage Average", "V", "instantaneous"),
    "VOLTAGE_L1": ("Voltage L1", "V", "instantaneous"),
    "VOLTAGE_L2": ("Voltage L2", "V", "instantaneous"),
    "VOLTAGE_L3": ("Voltage L3", "V", "instantaneous"),
    "VOLTAGE_L1_L2": ("Voltage L1-L2", "V", "instantaneous"),
    "VOLTAGE_L2_L3": ("Voltage L2-L3", "V", "instantaneous"),
    "VOLTAGE_L3_L1": ("Voltage L3-L1", "V", "instantaneous"),
    "CURRENT_TOTAL": ("Current Total", "A", "instantaneous"),
    "CURRENT_L1": ("Current L1", "A", "instantaneous"),
    "CURRENT_L2": ("Current L2", "A", "instantaneous"),
    "CURRENT_L3": ("Current L3", "A", "instantaneous"),
    "DEMAND_TOTAL": ("Demand Total", "kW", "instantaneous"),
    "ENERGY_RECEIVED": ("Energy Received", "kWh", "energy"),
    "ENERGY_DELIVERED": ("Energy Delivered", "kWh", "energy"),
    "ENERGY_TOTAL": ("Energy Total", "kWh", "energy"),
    "VAH_RECEIVED": ("VAH Received", "kVAh", "energy"),
    "RUN_HOURS": ("Run Hours", "h", "diagnostics"),
    "THD_VOLTAGE": ("THD Voltage", "%", "harmonics"),
    "THD_CURRENT": ("THD Current", "%", "harmonics"),
}


# Per-meter transport and encoding, read out of the firmware's own
# modbus_main/meter_codes/<meter>.py. The blanket "FC03 + float32 + CDAB"
# default is correct only for the L&T-style meters; these are the exceptions.
#
#   FC04  - the meter class calls read_input_registers / register_type="input"
#   ABCD  - the class assembles bind_data as [raw[i+1], raw[i]] before
#           wordorder=Endian.Little; [raw[i], raw[i+1]] means CDAB (the default)
FC04_METERS = {
    "RISH_EM1330", "RISH_LM_1360", "RISH_MASTER_3440", "RISH_DELTA_ENERGY_NX",
    "SELEC", "SELEC_383A", "SELEC_384", "SELEC_386", "SELEC_MFM384RC",
    "SIEMENS_7KT0310", "QUASAR", "SIEMENS_PAC3200",
}

ABCD_METERS = {
    "SCHNEIDER_PM_5320", "SCHNEIDER_6400", "SOCOMEC_A40", "SIEMENS_PAC3200",
    "RISH_EM1330", "RISH_LM_1360", "RISH_MASTER_3440", "RISH_DELTA_ENERGY_NX",
    "DIGI_720", "GOBLIN_TRINITY", "QUASAR", "L_T_VEGA", "MEATROL_ME_337",
    "EMFIS_HPL_VIE",
}

# 32-bit values decode as signed integers, not IEEE-754 floats.
INT32_METERS = {
    "L_T_VEGA", "SOCOMEC_A40", "GOBLIN_TRINITY", "QUASAR",
    "DIGI_250", "DIGI_620", "DIGI_720", "EMFIS_HPL_VIE",
}

# Entirely 16-bit: TRINITY_NF_29 uses decode_16bit_uint throughout, and
# PM130_PLUS encodes every value as a raw 0-9999 range word.
UINT16_METERS = {"TRINITY_NF_29", "PM130_PLUS"}


def format_for(company: str) -> dict:
    """The register encoding this meter actually uses."""
    if company in UINT16_METERS:
        data_type = "uint16"
    elif company in INT32_METERS:
        data_type = "int32"
    else:
        data_type = "float32"
    return {
        "dataType": data_type,
        "wordOrder": "abcd" if company in ABCD_METERS else "cdab",
        "scale": 1.0,
        "offset": 0.0,
    }


# Plausible live behaviour per parameter, so loading any profile into the
# simulator produces a meter that looks like a meter instead of a wall of
# zeros. Ranges are nominal 3-phase 415 V / 50 Hz engineering units, matching
# the hand-written L&T profile's style. Cumulative registers count up.
SIM_DEFAULTS = {
    "active_power": ("random", 145.0, 155.0),
    "reactive_power": ("random", 10.0, 12.0),
    "demand_total": ("random", 48.0, 52.0),
    "power_factor": ("random", 0.95, 0.99),
    "frequency": ("random", 49.9, 50.1),
    "voltage_average": ("random", 225.0, 235.0),
    "r_phase_voltage": ("random", 225.0, 235.0),
    "y_phase_voltage": ("random", 225.0, 235.0),
    "b_phase_voltage": ("random", 225.0, 235.0),
    "average_line_voltage": ("random", 405.0, 420.0),
    "current_total": ("random", 14.0, 16.0),
    "r_phase_current": ("random", 4.5, 5.5),
    "y_phase_current": ("random", 4.5, 5.5),
    "b_phase_current": ("random", 4.5, 5.5),
    "n_phase_current": ("random", 0.0, 1.5),
    "voltage_unbalance": ("random", 0.0, 3.0),
    "current_unbalance": ("random", 0.0, 3.0),
    "phase_red_voltage_harmonics": ("random", 1.0, 5.0),
    "phase_yellow_voltage_harmonics": ("random", 1.0, 5.0),
    "phase_blue_voltage_harmonics": ("random", 1.0, 5.0),
    "phase_red_current_harmonics": ("random", 1.0, 5.0),
    "phase_yellow_current_harmonics": ("random", 1.0, 5.0),
    "phase_blue_current_harmonics": ("random", 1.0, 5.0),
    "energy_received": ("counter", 1.0, 1000.0),
    "energy_delivered": ("counter", 1.0, 500.0),
    "vah_received": ("counter", 1.0, 1050.0),
    "varh_inductive_received": ("counter", 1.0, 200.0),
    "varh_capacitive_received": ("counter", 1.0, 150.0),
    "run_hours": ("counter", 1.0, 100.0),
}


def sim_defaults_for(key: str, fmt: dict):
    """(behavior, initial) for a parameter, or (None, None) if we have no idea.

    Integer register types can't hold 0.95 or 49.9, so a range that would
    quantise to nothing is lifted by the firmware's usual x1000 convention —
    the raw register content a scaled meter would actually carry.
    """
    spec = SIM_DEFAULTS.get(key)
    if spec is None:
        return None, None
    kind, a, b = spec
    is_int = fmt["dataType"] in ("uint16", "int16", "uint32", "int32", "uint64", "int64")

    if kind == "counter":
        step, start = a, b
        if is_int and step < 1.0:
            step = 1.0
        return {"kind": "counter", "step": step}, start

    lo, hi = a, b
    if is_int and hi < 10.0:
        lo, hi = lo * 1000.0, hi * 1000.0
    return {"kind": "random", "min": lo, "max": hi}, None


def slugify(company: str) -> str:
    s = company.lower().replace("&", "and")
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s


def param_key(name: str) -> str:
    return name.lower()


def parse_starting_address(text: str) -> dict[str, int]:
    m = re.search(r"STARTING_ADDRESS\s*=\s*\{(.*?)\n\}", text, re.S)
    if not m:
        raise SystemExit("STARTING_ADDRESS not found")
    out: dict[str, int] = {}
    for line in m.group(1).splitlines():
        mm = re.search(r"MeterCompany\.(\w+)\s*:\s*(\d+)", line)
        if mm:
            out[mm.group(1)] = int(mm.group(2))
    return out


def parse_parameter_maps(text: str) -> dict[str, dict[str, int]]:
    """Return company -> {PARAM_NAME: doc_address} for integer-mapped params."""
    company_params: dict[str, dict[str, int]] = defaultdict(dict)
    # Match NAME = { ... }
    for m in re.finditer(
        r"^([A-Z][A-Z0-9_]*)\s*=\s*\{(.*?)^\s*\}",
        text,
        re.S | re.M,
    ):
        name, body = m.group(1), m.group(2)
        if name in ("STARTING_ADDRESS", "MAXIMUM_NO_COUNT") or name.startswith("GET_"):
            continue
        for mm in re.finditer(
            r"MeterCompany\.(\w+)\s*:\s*(\d+)\s*(?:,|$)",
            body,
        ):
            company, addr = mm.group(1), int(mm.group(2))
            if company in INCLUDE_COMPANIES:
                company_params[company][name] = addr
    return company_params


def float32_cdab() -> dict:
    return {
        "dataType": "float32",
        "wordOrder": "cdab",
        "scale": 1.0,
        "offset": 0.0,
    }


def uint32_cdab() -> dict:
    return {
        "dataType": "uint32",
        "wordOrder": "cdab",
        "scale": 1.0,
        "offset": 0.0,
    }


def uint16_scaled(scale: float) -> dict:
    return {
        "dataType": "uint16",
        "wordOrder": "cdab",
        "scale": scale,
        "offset": 0.0,
    }


def point(
    key: str,
    label: str,
    address: int,
    fmt: dict,
    unit: str = "",
    group: str = "instantaneous",
    unverified: bool = True,
    sim_behavior=None,
    sim_initial=None,
) -> dict:
    p = {
        "key": key,
        "label": label,
        "address": address,
        "format": fmt,
        "unit": unit,
        "group": group,
        "unverified": unverified,
    }
    if sim_behavior is not None:
        p["simBehavior"] = sim_behavior
    if sim_initial is not None:
        p["simInitial"] = sim_initial
    return p


def verified_lt() -> dict:
    """Ground truth from docs/reference/device-profiles.md Profile 1."""
    pts = [
        point(
            "active_power",
            "Active Power",
            100,
            float32_cdab(),
            "kW",
            "instantaneous",
            False,
            {"kind": "random", "min": 145.0, "max": 155.0},
            150.0,
        ),
        point(
            "reactive_power",
            "Reactive Power",
            108,
            float32_cdab(),
            "kVAr",
            "instantaneous",
            False,
            {"kind": "random", "min": 10.0, "max": 12.0},
            11.0,
        ),
        point(
            "power_factor",
            "Power Factor",
            116,
            float32_cdab(),
            "",
            "instantaneous",
            False,
            {"kind": "random", "min": 0.95, "max": 0.99},
            0.97,
        ),
        point(
            "demand_total",
            "Demand Total",
            124,
            float32_cdab(),
            "kW",
            "instantaneous",
            False,
            {"kind": "random", "min": 48.0, "max": 52.0},
            50.0,
        ),
        point(
            "frequency",
            "Frequency",
            132,
            float32_cdab(),
            "Hz",
            "instantaneous",
            False,
            {"kind": "random", "min": 49.9, "max": 50.1},
            50.0,
        ),
        point(
            "voltage_average",
            "Voltage Average",
            148,
            float32_cdab(),
            "V",
            "instantaneous",
            False,
            {"kind": "random", "min": 225.0, "max": 235.0},
            230.0,
        ),
        point(
            "current_total",
            "Current Total",
            150,
            float32_cdab(),
            "A",
            "instantaneous",
            False,
            {"kind": "random", "min": 14.0, "max": 16.0},
            15.0,
        ),
        point(
            "energy_received",
            "Energy Received",
            158,
            float32_cdab(),
            "kWh",
            "energy",
            False,
            {"kind": "random", "min": 1000.0, "max": 1001.0},
            1000.5,
        ),
        point(
            "vah_received",
            "VAH Received",
            160,
            float32_cdab(),
            "kVAh",
            "energy",
            False,
            {"kind": "random", "min": 1050.0, "max": 1051.0},
            1050.5,
        ),
        point(
            "run_hours",
            "Run Hours",
            216,
            uint32_cdab(),
            "h",
            "diagnostics",
            False,
            {"kind": "counter", "step": 1.0},
            100.0,
        ),
    ]
    return {
        "id": "lt-electrical-meter",
        "brand": "L&T",
        "model": "4-quadrant energy meter",
        "description": "Verified from docs/reference/device-profiles.md (electrical_write_data.py). Float32 CDAB holding registers from wire 100.",
        "source": {"kind": "built_in"},
        "function": "read_holding_registers",
        "blockStart": 100,
        "blockCount": 120,
        "defaultUnitId": 1,
        "suggestedRtu": {
            "baudRate": 9600,
            "dataBits": 8,
            "parity": "even",
            "stopBits": 1,
        },
        "points": pts,
    }


def verified_vfd() -> dict:
    rows = [
        ("running_frequency", "Running Frequency", 256, 0.01, "Hz", 5179),
        ("running_speed", "Running Speed", 257, 1.0, "rpm", 1485),
        ("phase_u_dc_voltage", "Phase U DC Voltage", 258, 1.0, "V", 540),
        ("phase_v_dc_voltage", "Phase V DC Voltage", 259, 1.0, "V", 541),
        ("phase_w_dc_voltage", "Phase W DC Voltage", 260, 1.0, "V", 539),
        ("input_voltage_uab", "Input Voltage Uab", 261, 1.0, "V", 415),
        ("input_voltage_ubc", "Input Voltage Ubc", 262, 1.0, "V", 414),
        ("input_voltage_uca", "Input Voltage Uca", 263, 1.0, "V", 416),
        ("input_current_ia", "Input Current Ia", 264, 0.1, "A", 13),
        ("input_current_ib", "Input Current Ib", 265, 0.1, "A", 7),
        ("input_current_ic", "Input Current Ic", 266, 0.1, "A", 2),
        ("output_current_iu", "Output Current Iu", 267, 0.1, "A", 5),
        ("output_current_iv", "Output Current Iv", 268, 0.1, "A", 3),
        ("output_current_iw", "Output Current Iw", 269, 0.1, "A", 2),
        ("output_voltage_uuv", "Output Voltage Uuv", 270, 1.0, "V", 415),
        ("output_voltage_uvw", "Output Voltage Uvw", 271, 1.0, "V", 414),
        ("output_voltage_uwu", "Output Voltage Uwu", 272, 1.0, "V", 416),
        ("running_time", "Running Time", 273, 1.0, "h", 25),
        ("fault_indication", "Fault Indication", 274, 1.0, "", 0),
        ("operation_record", "Operation Record", 275, 1.0, "", 0),
        ("alarm_indication", "Alarm Indication", 276, 1.0, "", 0),
        ("given_speed", "Given Speed", 277, 1.0, "rpm", 1485),
        ("input_power", "Input Power", 278, 1.0, "W", 5500),
        ("input_power_factor", "Input Power Factor", 279, 0.01, "", 98),
        ("output_power", "Output Power", 280, 1.0, "W", 5200),
    ]
    pts = []
    for key, label, addr, scale, unit, raw in rows:
        pts.append(
            point(
                key,
                label,
                addr,
                uint16_scaled(scale),
                unit,
                "diagnostics" if "fault" in key or "alarm" in key or "operation" in key else "instantaneous",
                False,
                {"kind": "static"},
                float(raw) * scale if scale != 1.0 else float(raw),
            )
        )
    return {
        "id": "vfd",
        "brand": "Generic",
        "model": "VFD",
        "description": "Verified from docs/reference/device-profiles.md (vfd_write_data.py). Uint16 with per-register scale.",
        "source": {"kind": "built_in"},
        "function": "read_holding_registers",
        "blockStart": 256,
        "blockCount": 25,
        "defaultUnitId": 1,
        "points": pts,
    }


def verified_flow() -> dict:
    return {
        "id": "flow-meter",
        "brand": "Generic",
        "model": "Flow meter",
        "description": "Verified from docs/reference/device-profiles.md (other_meters_write_data.py). Unit ID 2, block at wire 0.",
        "source": {"kind": "built_in"},
        "function": "read_holding_registers",
        "blockStart": 0,
        "blockCount": 4,
        "defaultUnitId": 2,
        "points": [
            point(
                "flow_rate",
                "Flow Rate",
                0,
                float32_cdab(),
                "m3/h",
                "instantaneous",
                False,
                {"kind": "random", "min": 5.0, "max": 15.0},
                10.0,
            ),
            point(
                "totaliser",
                "Totaliser",
                2,
                uint32_cdab(),
                "m3",
                "energy",
                False,
                {"kind": "counter", "step": 10.0},
                0.0,
            ),
        ],
    }


def profile_from_firmware(
    company: str, start: int, params: dict[str, int]
) -> dict | None:
    if not params:
        return None
    brand, model = BRAND_MODEL.get(company, (company, company))
    # FC03/FC04 allow 125 registers per request. Sizing the block to the data
    # (rather than the firmware's conservative MAXIMUM_NO_COUNT of 100) keeps
    # ~87 parameters that would otherwise be dropped without a trace.
    # Points beyond this reach — harmonics at 21299, energy at 3191 — need a
    # second block and are reported below, not silently discarded.
    BLOCK_LIMIT = 125
    points = []
    out_of_reach = []
    collisions = []
    claimed = {}  # wire address -> parameter that owns it
    kept = []  # (param, wire) in address order, after collision/reach filtering
    fmt = format_for(company)
    span = 1 if fmt["dataType"] in ("uint16", "int16") else 2
    for pname, doc_addr in sorted(params.items(), key=lambda x: x[1]):
        wire = doc_addr - 1  # METER_REG_OFFSET = 1
        if wire < start:
            # Some maps list absolute 1-based that sit inside the block after offset.
            continue
        # The value must fit entirely inside the block.
        if wire + span > start + BLOCK_LIMIT:
            out_of_reach.append((pname, wire))
            continue
        # Several firmware maps give two parameters the same address (a
        # copy-paste slip the runtime's elif chain hides by taking whichever it
        # checks first). Two rows reading one register would show the same
        # number under two names, so keep the first and report the rest.
        if wire in claimed:
            collisions.append((pname, claimed[wire], wire))
            continue
        claimed[wire] = pname
        kept.append((pname, wire))

    if not kept:
        return None

    # Register width from address spacing.
    #
    # Several maps place parameters one register apart. A 2-register value
    # there would overlap its neighbour and both would decode from partly the
    # same bytes — which is exactly what a wrong-width bug looks like on
    # screen. The map's own spacing is the evidence: a parameter with only one
    # register before the next one IS one register wide.
    narrowed = []
    for i, (pname, wire) in enumerate(kept):
        width = span
        if i + 1 < len(kept):
            gap = kept[i + 1][1] - wire
            if gap < span:
                width = max(1, gap)
        # The block end is the other hard constraint.
        width = min(width, start + BLOCK_LIMIT - wire)
        point_fmt = fmt
        if width < span:
            point_fmt = dict(fmt)
            point_fmt["dataType"] = (
                "int16" if fmt["dataType"] in ("int32", "int16") else "uint16"
            )
            narrowed.append(pname)
        label, unit, group = PARAM_META.get(
            pname, (pname.replace("_", " ").title(), "", "other")
        )
        key = param_key(pname)
        behavior, initial = sim_defaults_for(key, point_fmt)
        points.append(
            point(
                key,
                label,
                wire,
                point_fmt,
                unit,
                group,
                True,  # unverified until reconciled with meter_codes/
                behavior,
                initial,
            )
        )
    if narrowed:
        print(
            f"  {company}: {len(narrowed)} params are 1 register apart, so they "
            f"are 16-bit not 32-bit: {', '.join(narrowed)}"
        )
    if not points:
        return None
    if collisions:
        for dropped, kept, wire in collisions:
            print(
                f"  {company}: address {wire} claimed by both {kept} and "
                f"{dropped} — kept {kept}, dropped {dropped} (check the datasheet)"
            )
    if out_of_reach:
        names = ", ".join(f"{n}@{w}" for n, w in sorted(out_of_reach, key=lambda x: x[1]))
        print(
            f"  {company}: {len(out_of_reach)} params need a second block "
            f"(beyond {start}+{BLOCK_LIMIT}): {names}"
        )
    # Cover exactly what the points need, never more than one request allows.
    block_span = max(p["address"] + span for p in points) - start
    block_count = max(1, min(BLOCK_LIMIT, block_span))
    return {
        "id": slugify(company),
        "brand": brand,
        "model": model,
        "description": (
            f"Auto-extracted from firmware meter_register_constants.py for {company}. "
            "Default float32 CDAB; mark verified after checking meter_codes/."
        ),
        "source": {"kind": "built_in"},
        "function": (
            "read_input_registers"
            if company in FC04_METERS
            else "read_holding_registers"
        ),
        "blockStart": start,
        "blockCount": block_count,
        "defaultUnitId": 1,
        "suggestedRtu": {
            "baudRate": 9600,
            "dataBits": 8,
            "parity": "even",
            "stopBits": 1,
        },
        "points": points,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--firmware", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    constants = args.firmware / "common_files_iot" / "meter_register_constants.py"
    if not constants.is_file():
        print(f"missing {constants}", file=sys.stderr)
        return 1

    text = constants.read_text()
    starts = parse_starting_address(text)
    maps = parse_parameter_maps(text)

    args.out.mkdir(parents=True, exist_ok=True)

    # Always write the three verified device profiles first.
    verified = {
        "lt-electrical-meter": verified_lt(),
        "vfd": verified_vfd(),
        "flow-meter": verified_flow(),
    }
    written = []
    for pid, prof in verified.items():
        path = args.out / f"{pid}.json"
        path.write_text(json.dumps(prof, indent=2) + "\n")
        written.append(pid)

    # Firmware-derived electrical meters (skip L_T — covered by verified L&T).
    for company in sorted(INCLUDE_COMPANIES):
        if company == "L_T":
            continue
        start = starts.get(company, 0)
        params = maps.get(company, {})
        prof = profile_from_firmware(company, start, params)
        if not prof:
            print(f"skip {company}: no mappable params (start={start})")
            continue
        # Avoid colliding with verified ids
        if prof["id"] in verified:
            prof["id"] = prof["id"] + "-fw"
        path = args.out / f"{prof['id']}.json"
        path.write_text(json.dumps(prof, indent=2) + "\n")
        written.append(prof["id"])
        print(f"wrote {prof['id']}: {len(prof['points'])} points @ {start}")

    print(f"done: {len(written)} profiles → {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

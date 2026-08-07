"""Local pymodbus RTU slave for RTU smoke-testing ModbusOpen, over a virtual
serial pair (no diagslave available in this environment).

Set up the pair first:
  socat -d -d pty,raw,echo=0,link=/tmp/ttyA pty,raw,echo=0,link=/tmp/ttyB

Then run this script bound to /tmp/ttyA; point ModbusOpen (or a test) at
/tmp/ttyB, 9600 8-N-1. Same register map as testrig/slave.py so the two
transports are directly comparable:
  unit 1 — float32 CDAB meter-style values starting at wire address 100
  unit 2 — every holding register is 7 (for mid-poll unit-ID switching)

Requires: pymodbus >= 3.11 (tested on 3.14).
"""

from __future__ import annotations

import asyncio
import struct
import sys

from pymodbus.datastore import (
    ModbusDeviceContext,
    ModbusSequentialDataBlock,
    ModbusServerContext,
)
from pymodbus.server import StartAsyncSerialServer


def f32_cdab(v: float) -> list[int]:
    hi, lo = struct.unpack(">HH", struct.pack(">f", v))
    return [lo, hi]


regs = [0] * 200
regs[100:102] = f32_cdab(231.0)  # Voltage
regs[102:104] = f32_cdab(15.0)  # Current
regs[104:106] = f32_cdab(50.0)  # Frequency
regs[106:108] = f32_cdab(0.975)  # Power factor

ctx = ModbusServerContext(
    devices={
        1: ModbusDeviceContext(hr=ModbusSequentialDataBlock(1, regs)),
        2: ModbusDeviceContext(hr=ModbusSequentialDataBlock(1, [7] * 200)),
    },
)

if __name__ == "__main__":
    port = sys.argv[1] if len(sys.argv) > 1 else "/tmp/ttyA"
    print(f"Modbus RTU slave on {port} 9600 8-N-1 (units 1, 2)")
    asyncio.run(
        StartAsyncSerialServer(
            context=ctx, port=port, baudrate=9600, bytesize=8, parity="N", stopbits=1
        )
    )

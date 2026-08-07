"""Local pymodbus TCP slave for ModbusOpen development.

Serves two unit IDs on 127.0.0.1:5020 (unprivileged):
  unit 1 — float32 CDAB meter-style values starting at wire address 100
  unit 2 — every holding register is 7 (for mid-poll unit-ID switching)

Requires: pymodbus >= 3.11 (tested on 3.14).
"""

from __future__ import annotations

import asyncio
import struct

from pymodbus.datastore import (
    ModbusDeviceContext,
    ModbusSequentialDataBlock,
    ModbusServerContext,
)
from pymodbus.server import StartAsyncTcpServer


def f32_cdab(v: float) -> list[int]:
    """float32, big-endian bytes, word-swapped — the CDAB layout the real meters use."""
    hi, lo = struct.unpack(">HH", struct.pack(">f", v))
    return [lo, hi]


regs = [0] * 200
regs[100:102] = f32_cdab(231.0)  # Voltage
regs[102:104] = f32_cdab(15.0)  # Current
regs[104:106] = f32_cdab(50.0)  # Frequency
regs[106:108] = f32_cdab(0.975)  # Power factor

# pymodbus ≥3.11: SequentialDataBlock start address is 1-based (values[0] ==
# wire address 0). Passing 0 raises TypeError on 3.14.
ctx = ModbusServerContext(
    devices={
        1: ModbusDeviceContext(hr=ModbusSequentialDataBlock(1, regs)),
        2: ModbusDeviceContext(hr=ModbusSequentialDataBlock(1, [7] * 200)),
    },
)

if __name__ == "__main__":
    print("Modbus TCP slave on 127.0.0.1:5020  (units 1, 2)")
    asyncio.run(StartAsyncTcpServer(context=ctx, address=("127.0.0.1", 5020)))

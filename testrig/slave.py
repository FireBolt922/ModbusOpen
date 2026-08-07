import asyncio
import struct

from pymodbus.datastore import (
    ModbusSequentialDataBlock,
    ModbusServerContext,
    ModbusSlaveContext,
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

ctx = ModbusServerContext(
    slaves={
        1: ModbusSlaveContext(hr=ModbusSequentialDataBlock(0, regs)),
        2: ModbusSlaveContext(hr=ModbusSequentialDataBlock(0, [7] * 200)),
    },
    single=False,
)

if __name__ == "__main__":
    asyncio.run(StartAsyncTcpServer(context=ctx, address=("127.0.0.1", 5020)))

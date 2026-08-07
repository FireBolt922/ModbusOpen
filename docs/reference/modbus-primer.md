# Modbus primer

The whole protocol, in one page. Read this before writing any protocol code.

Modbus is from 1979 and it shows — but that's also why it's everywhere. It's a request/response
protocol with exactly one master (client) issuing requests and slaves (servers) answering.
There is no broadcast discovery, no self-description, and no data typing. **The device tells you
nothing about itself.** You must know its register map in advance. That fact is the entire reason
tools like ModbusOpen exist.

---

## The four data models

Every Modbus device presents up to four tables. Each is separately addressed, each starts at 0.

| Table | Size | Access | Read FC | Write FC | Legacy notation |
|---|---|---|---|---|---|
| **Coils** | 1 bit | read/write | 01 | 05, 15 | `0xxxx` (00001–09999) |
| **Discrete Inputs** | 1 bit | read-only | 02 | — | `1xxxx` (10001–19999) |
| **Input Registers** | 16 bit | read-only | 04 | — | `3xxxx` (30001–39999) |
| **Holding Registers** | 16 bit | read/write | 03 | 06, 16 | `4xxxx` (40001–49999) |

In practice, **holding registers (FC03) carry ~90% of real traffic.** Many devices implement only
that table, and some map their input registers to the same memory. If FC03 fails, try FC04 before
concluding the device is dead.

### The addressing trap

The four tables are **separate address spaces**, all starting at 0 on the wire.

The `4xxxx` notation is a legacy documentation convention that squashes them into one numbering
scheme, and it is **1-based**:

```
Documentation says:  40001    →  wire address 0    in the holding register table
Documentation says:  40101    →  wire address 100
Documentation says:  30001    →  wire address 0    in the input register table
```

Vendors are wildly inconsistent — some docs say `40101`, some say `4x0101`, some say `101`, some
say `100`. **Off-by-one is the single most common Modbus bug.** ModbusOpen's answer is to always
display both the 0-based wire address and the 1-based notation side by side, so a mismatch is
visible instead of mysterious.

Internally, ModbusOpen stores **only 0-based wire addresses**. Conversion happens at the display
layer, never in the core.

---

## PDU and ADU

The **PDU** (Protocol Data Unit) is the part that's identical across every transport:

```
┌──────────────┬─────────────────────────┐
│ Function code│  Data                   │
│   1 byte     │  0–252 bytes            │
└──────────────┴─────────────────────────┘
   max PDU = 253 bytes
```

The **ADU** (Application Data Unit) wraps the PDU with whatever the transport needs for addressing
and integrity. This is the *only* thing RTU and TCP differ in.

### Modbus RTU ADU — serial

```
┌─────────┬──────────────┬───────────┬─────────┐
│ Address │ Function code│   Data    │  CRC-16 │
│ 1 byte  │   1 byte     │  0–252 B  │ 2 bytes │
└─────────┴──────────────┴───────────┴─────────┘
   max ADU = 256 bytes
   frames are delimited by 3.5 character times of silence
```

- **Address** is the slave ID, 1–247. `0` is broadcast (write-only, no response). 248–255 reserved.
- **CRC-16** poly `0xA001` (reflected), init `0xFFFF`, transmitted **low byte first** — note that
  this is the opposite endianness from everything else in the frame.
- There is **no length field**. The receiver knows a frame ended because the line went quiet.
  This is why serial timing matters and why RTU over a badly-buffered USB adapter can be flaky.

### Modbus TCP ADU — Ethernet

```
┌───────────────── MBAP header (7 bytes) ─────────────────┬──────────────┬───────────┐
│ Transaction ID │ Protocol ID │  Length  │  Unit ID      │ Function code│   Data    │
│    2 bytes     │  2 bytes    │ 2 bytes  │  1 byte       │   1 byte     │  0–252 B  │
│                │  always 0   │          │               │              │           │
└────────────────┴─────────────┴──────────┴───────────────┴──────────────┴───────────┘
   max ADU = 260 bytes.  All multi-byte fields big-endian.
```

- **Transaction ID** — echoed by the slave. Lets you match responses to requests and pipeline
  multiple outstanding requests on one socket.
- **Protocol ID** — always `0x0000` for Modbus.
- **Length** — byte count of everything *after* the length field, i.e. `1 (unit) + 1 (FC) + data`.
- **Unit ID** — the same idea as the RTU slave address. On a native Ethernet device it's usually
  ignored (send `1` or `255`). On a **serial gateway** it's essential: it selects which downstream
  RS-485 device the gateway forwards to.
- **No CRC** — TCP already provides checksums and retransmission.

### Modbus RTU over TCP

A third, unofficial-but-common variant: the complete RTU ADU (with its CRC, no MBAP) shoved down a
TCP socket. Cheap serial-to-Ethernet converters do this. It's in the [backlog](../backlog.md), not v1
— but recognize it, because a user hitting one with our TCP mode will see garbage and needs to be
told why.

---

## A transaction, end to end

Read 2 holding registers starting at wire address 100 from unit 1.

**TCP request**
```
00 01   00 00   00 06   01   03   00 64   00 02
│       │       │       │    │    │       └── quantity = 2
│       │       │       │    │    └────────── start address = 100 (0x0064)
│       │       │       │    └─────────────── FC03 read holding registers
│       │       │       └──────────────────── unit ID = 1
│       │       └──────────────────────────── length = 6 bytes follow
│       └──────────────────────────────────── protocol ID = 0
└──────────────────────────────────────────── transaction ID = 1
```

**TCP response**
```
00 01   00 00   00 07   01   03   04   43 67   00 00
                                  │    └───────────── 2 registers of data
                                  └── byte count = 4
```

**The same request in RTU**
```
01   03   00 64   00 02   C5 CD
│    │    │       │       └── CRC-16, low byte first
│    │    │       └────────── quantity
│    │    └────────────────── start address
│    └─────────────────────── FC03
└──────────────────────────── slave address
```

Identical PDU (`03 00 64 00 02`) in both. Only the wrapper changes — which is exactly why
ModbusOpen's transport layer is a trait with two implementations and everything above it is shared.

---

## Exception responses

When a slave can't serve a request, it replies with the function code **OR'd with `0x80`**,
followed by a one-byte exception code:

```
Request:   01 03 00 64 00 02 ...
Response:  01 83 02 ...
              │  └── exception code 02 = Illegal Data Address
              └───── 0x03 | 0x80
```

| Code | Name | What it usually actually means |
|---|---|---|
| 01 | Illegal Function | Device doesn't implement this FC. Try FC03 vs FC04. |
| 02 | Illegal Data Address | **The common one.** Off-by-one, wrong addressing base, or the range runs past the end of the table. |
| 03 | Illegal Data Value | Quantity out of range (asked for >125 registers), or a write value the device rejects. |
| 04 | Slave Device Failure | Internal device error. |
| 05 | Acknowledge | Accepted, still working. Poll again. |
| 06 | Slave Device Busy | Back off and slow the poll rate. |
| 08 | Memory Parity Error | Device memory fault. |
| 0A | Gateway Path Unavailable | The gateway has no route for that unit ID. |
| 0B | Gateway Target Device Failed To Respond | **Common with gateways.** The gateway is fine; the downstream serial device isn't answering. Check baud/wiring on the far side. |

Codes `0A`/`0B` only come from gateways, and distinguishing them from a plain timeout is genuinely
useful diagnostic information — a `0B` proves your TCP path works and narrows the fault to the
serial segment.

**An exception is a successful transaction.** The device is alive and talking. ModbusOpen keeps
polling and displays the exception; only a dead transport ends a session.

---

## Quantity limits

Hard limits from the spec, imposed by the 253-byte max PDU. Enforce these **client-side**, before
sending — a rejected request wastes a full timeout.

| FC | Operation | Max per request |
|---|---|---|
| 01 | Read Coils | 2000 bits |
| 02 | Read Discrete Inputs | 2000 bits |
| 03 | Read Holding Registers | **125 registers** |
| 04 | Read Input Registers | **125 registers** |
| 15 | Write Multiple Coils | 1968 bits |
| 16 | Write Multiple Registers | **123 registers** |

Note the asymmetry: you can read 125 but only write 123, because the write request carries the
address and byte-count overhead in the same PDU.

Reading a 120-register meter map fits in one transaction. Reading 200 does not — ModbusOpen must
split it into chunks and stitch the results. (v1 caps quantity at the limit and tells the user;
auto-chunking is [backlog](../backlog.md).)

---

## Practical gotchas

1. **Devices lie about what they support.** A device may accept FC03 for a range it doesn't
   populate and return zeros rather than exception 02.
2. **Word order is undefined by the spec** for anything larger than 16 bits. See
   [data types and word order](data-types-word-order.md). This is the second most common bug.
3. **Unit ID matters on TCP more than people expect** — always, when there's a gateway involved.
4. **Broadcast (address 0) gets no response.** Don't wait for one; don't count it as a timeout.
5. **Some devices need a settling delay** between transactions and will simply ignore requests
   that come too fast. If a device is flaky at 100 ms, try 500 ms before blaming the wiring.
6. **RS-485 is half duplex.** Only one device transmits at a time; the master must wait for a
   complete response (or a timeout) before sending again. Never pipeline on RTU.

---

## Sources

- [Modbus function codes reference](https://modbus.app/modbus-function-codes.html)
- [Modbus TCP protocol explained — MBAP header](https://controllerstech.com/modbus-tcp-protocol-explained/)
- [Understanding Modbus protocol: RTU vs TCP](https://controllerstech.com/understanding-modbus-protocol/)
- [Modbus exception codes explained](https://scadaprotocols.com/modbus-exception-codes-explained/)
- [Modbus RTU vs TCP comparison](https://www.wevolver.com/article/modbus-rtu-vs-tcp)

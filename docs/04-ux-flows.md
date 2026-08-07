# 04 — UX flows

Design rule for every screen below: **the default path requires no reading.** Pre-fill every field
with the value that's right 80% of the time, and put the one button that matters where the eye
lands.

---

## Home

```
┌──────────────────────────────────────────────────────────────────────┐
│  ModbusOpen                                              ⚙  ?  ◐     │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│    ┌────────────────────────┐    ┌────────────────────────┐          │
│    │   📡                   │    │   🖥                    │          │
│    │   Scan                 │    │   Simulate             │          │
│    │                        │    │                        │          │
│    │   Read from a device   │    │   Pretend to be        │          │
│    │                        │    │   a device             │          │
│    │   Poll registers,      │    │   Serve registers to   │          │
│    │   decode values,       │    │   test your master     │          │
│    │   write back           │    │   without hardware     │          │
│    │                        │    │                        │          │
│    │   Modbus master        │    │   Modbus slave         │          │
│    └────────────────────────┘    └────────────────────────┘          │
│                                                                      │
│    Recent                                                            │
│    ▸ TCP  192.168.1.69:502  unit 1        ·  2 minutes ago           │
│    ▸ RTU  /dev/ttyUSB0  9600 8N1  unit 3  ·  yesterday               │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

Plain language first ("Read from a device"), jargon second ("Modbus master") — a newcomer isn't
blocked, an expert isn't slowed down. Recent connections reconnect in one click; that's the real
fast path for anyone using this daily.

---

## Scanner → transport picker

```
┌──────────────────────────────────────────────────────────────────────┐
│  ← Back              Scan — choose a connection                      │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│    ┌──────────────────────────┐   ┌──────────────────────────┐       │
│    │  TCP                     │   │  RTU                     │       │
│    │  Ethernet / Wi-Fi        │   │  Serial — RS-485/RS-232  │       │
│    │  Device has an IP        │   │  USB adapter or COM port │       │
│    │                          │   │                          │       │
│    │                          │   │  2 ports detected        │       │
│    └──────────────────────────┘   └──────────────────────────┘       │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

The RTU card shows a live detected-port count. Zero ports is itself the answer to "why can't I
find my device" — surface it before they click.

---

## Scanner → TCP setup

```
┌──────────────────────────────────────────────────────────────────────┐
│  ← Back              Scan over TCP                                   │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│    Host or IP        [ 192.168.1.69                    ]             │
│    Port              [ 502     ]                                     │
│    Unit / Slave ID   [ 1       ]   (0–247, changeable later)         │
│                                                                      │
│    ▸ Advanced                                                        │
│      Timeout         [ 1000 ] ms                                     │
│      Retries         [ 1    ]                                        │
│                                                                      │
│                                          [    Connect    ]           │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

Four visible fields, three pre-filled. Advanced is collapsed. **Connect** is the only primary button.

---

## Scanner → RTU setup

```
┌──────────────────────────────────────────────────────────────────────┐
│  ← Back              Scan over RTU (serial)                          │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│    Serial port    [ /dev/tty.usbserial-A50285BI    ▾ ]  ⟳            │
│                     FTDI FT232R USB UART                             │
│                                                                      │
│    Baud rate      [ 9600  ▾ ]     Unit / Slave ID  [ 1  ]            │
│    Format         [ 8-N-1 ▾ ]     ← data bits · parity · stop bits   │
│                                                                      │
│    ▸ Advanced                                                        │
│      Data bits [8▾]  Parity [None▾]  Stop bits [1▾]                  │
│      Timeout [1000] ms   Inter-frame delay [ auto ] ms               │
│                                                                      │
│                                          [    Connect    ]           │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

Notes:
- The port dropdown shows the **product description** under the device path. `FTDI FT232R USB UART`
  is far more recognizable than `/dev/tty.usbserial-A50285BI`.
- **Format** is a single combined control with presets (8-N-1, 8-E-1, 8-O-1, 8-N-2). Nobody wants
  three dropdowns for one concept. Advanced splits them for the rare odd case.
- **Inter-frame delay** defaults to `auto`, computed as 3.5 character times (and clamped to
  1.75 ms above 19200 baud, per spec). See [serial timing](reference/serial-timing.md).
- If no ports are found: *"No serial ports detected. Plug in your USB-RS485 adapter and click ⟳.
  On Linux you may need to be in the `dialout` group."*

---

## Scanner → workspace  ★ the main screen

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ ● Connected  TCP 192.168.1.69:502          [Disconnect]      ⚙  ?  ◐               │
├────────────────────────────────────────────────────────────────────────────────────┤
│ Unit [ 1 ]  Function [ 03 Read Holding ▾ ]  Start [ 100 ]  Qty [ 20 ]              │
│ Interval [ 1000 ] ms   [ ⏸ Pause ]  [ ↻ Read once ]      Format [ float32 CDAB ▾ ] │
├────────────────────────────────────────────────────────────────────────────────────┤
│  Address    4x        Raw (hex)      Value              Name                       │
│  ───────────────────────────────────────────────────────────────────────────────   │
│  100–101    40101     43 67 00 00    231.0              Voltage L1                 │
│  102–103    40103     41 70 00 00    15.0               Current L1                 │
│  104–105    40105     42 48 00 00    50.0               Frequency                  │
│  106–107    40107     3F 79 99 9A    0.975              Power Factor               │
│  108–109    40109     44 96 00 00    1200.0             Active Power               │
│  …                                                                                 │
├────────────────────────────────────────────────────────────────────────────────────┤
│ ▸ Write   ▸ Frame log (2,481)                                                      │
├────────────────────────────────────────────────────────────────────────────────────┤
│ TX 1,247  RX 1,247  Err 0   ·   4.2 / 6.1 / 22 ms   ·   1.00 Hz   ·   no errors    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

Behaviours:

- **Everything in the poll bar is live.** Change unit, start, quantity, interval, or format and it
  takes effect next cycle. No reconnect, no re-arm, no Apply button.
- **Raw hex is a permanent column, not an option.** If the format is wrong, the user can see it.
- **Two address columns.** `100–101` is the 0-based wire address (spanning two registers because
  this is a float32); `40101` is 1-based Modbus notation. Off-by-one is the most common Modbus
  bug and showing both kills it.
- **Name** is optional and user-set (M5), persisted in the session.
- **Double-click a Value cell to write it** (M3).
- **Stats footer reads left to right as a story:** counters, latency min/avg/max, actual achieved
  rate, and the last error. "Actual rate" catches the case where a 100 ms interval is silently
  running at 3 Hz because each transaction takes 300 ms.
- **Per-row format override** via right-click, for maps that mix types (a float32 block followed by
  a uint32 counter — exactly the L&T map).

### Error state

```
│ TX 1,320  RX 1,247  Err 73  ·  4.2/6.1/22 ms  ·  0.94 Hz                           │
│ ⚠ Illegal Data Address (02) — unit 1 has no register at 40201.                      │
│   Try a lower start address or check the addressing base.                           │
```

The table keeps its last good values, dimmed, with a "stale" marker. Polling continues. The user
adjusts the start address and watches it come back — that's the actual debugging loop.

---

## Scanner → write panel

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│  Write                                                                     ✕       │
├────────────────────────────────────────────────────────────────────────────────────┤
│  Function  [ 06 Write Single Register ▾ ]    Unit [ 1 ]    Address [ 40107 ]        │
│  Type      [ uint16 ▾ ]                      Value [ 1500        ]                  │
│                                                                                     │
│  Will send:  01 06 00 6A 05 DC 28 3B                                                │
│                                                        [ Cancel ]  [ Write ]        │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**The frame preview is the point.** Showing the exact bytes before sending builds trust and catches
mistakes — and writing a wrong register to live equipment is the one genuinely dangerous thing this
app can do.

---

## Scanner → frame log

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│  Frame log                        [ ⏸ ]  [ Clear ]  [ Copy ]  [ Export ]     ✕     │
├────────────────────────────────────────────────────────────────────────────────────┤
│  12:04:31.204  TX  00 01 00 00 00 06 01 03 00 64 00 14                             │
│                    └MBAP──────────┘ │  │  └addr┘ └qty┘                             │
│                                     │  └ FC03 Read Holding                          │
│                                     └ unit 1                                        │
│  12:04:31.209  RX  00 01 00 00 00 2B 01 03 28 43 67 00 00 41 70 …      (5.2 ms)    │
│  12:04:32.204  TX  00 02 00 00 00 06 01 03 00 64 00 14                             │
│  12:04:32.211  RX  00 02 00 00 00 03 01 83 02                          (6.8 ms)    │
│                    ⚠ Exception: Illegal Data Address (02)                           │
└────────────────────────────────────────────────────────────────────────────────────┘
```

Annotated hex, not bare hex. Field boundaries under the TX line, exceptions decoded inline, RTT on
every response. This is the feature that makes ModbusOpen better than a wrapped CLI.

---

## Simulator → setup

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│  ← Back              Simulate a device                                             │
├────────────────────────────────────────────────────────────────────────────────────┤
│  Transport   ( • ) TCP   listen on port [ 502  ]                                    │
│              (   ) RTU   port [ /dev/ttyUSB0 ▾ ]  [ 9600 ▾ ]  [ 8-N-1 ▾ ]           │
│                                                                                     │
│  Load a profile  [ L&T electrical meter ▾ ]  [ Load ]      or build one below       │
│                                                                                     │
│  Slaves                                                          [ + Add slave ]    │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  │ Unit 1  "Electrical meter"                                          ✎  🗑  │    │
│  │   Holding registers  100 – 219  (120 regs)                                 │    │
│  │   ▸ 12 tags configured                                                     │    │
│  ├────────────────────────────────────────────────────────────────────────────┤    │
│  │ Unit 2  "Flow meter"                                                ✎  🗑  │    │
│  │   Holding registers  0 – 3  (4 regs)                                       │    │
│  │   ▸ 2 tags configured                                                      │    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
│                                                            [   Start server   ]     │
└────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Simulator → tag editor

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│  Tag — unit 1                                                              ✕       │
├────────────────────────────────────────────────────────────────────────────────────┤
│  Name      [ Active Power                    ]                                      │
│  Address   [ 100 ]   Type [ float32 ▾ ]  Word order [ CDAB ▾ ]  → occupies 100–101  │
│                                                                                     │
│  Behaviour [ random ▾ ]     Min [ 145.0 ]  Max [ 155.0 ]  Update every [ 1000 ] ms  │
│                                                                                     │
│              static · random · ramp · sine · counter                                │
│                                                                                     │
│  Preview   151.3 → 147.8 → 154.1 → 149.2 …                                          │
│                                                        [ Cancel ]  [ Save ]         │
└────────────────────────────────────────────────────────────────────────────────────┘
```

The live preview means you can see the behaviour is right before a master ever connects. `→ occupies
100–101` updates as the type changes — making multi-register footprints visible prevents accidental
tag overlap, which is otherwise a silent, baffling bug.

---

## Simulator → workspace

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ ● Serving  TCP :502  ·  2 slaves  ·  1 master connected     [Stop]                 │
├────────────────────────────────────────────────────────────────────────────────────┤
│  Unit 1 — Electrical meter                                                          │
│  Address   Name              Type            Behaviour        Value                 │
│  ────────────────────────────────────────────────────────────────────────────────   │
│  100–101   Active Power      float32 CDAB    random           151.34                │
│  108–109   Reactive Power    float32 CDAB    random            11.02                │
│  116–117   Power Factor      float32 CDAB    random             0.973               │
│  216–217   Run Hours         uint32  CDAB    counter          1,204        ✎        │
│  …                                                                                  │
├────────────────────────────────────────────────────────────────────────────────────┤
│  ▸ Frame log (842)     Master 192.168.1.42 — last read 40 ms ago                    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

Any value is directly editable (✎), which overrides the animation until you re-enable it — that's
how you force a specific value to test the master's handling of it. Writes arriving from the master
appear here live, with a brief highlight flash.

---

## Cross-cutting

| Concern | Rule |
|---|---|
| Theme | Dark by default (this is a tool used in panels and server rooms), light available |
| Density | Compact. Tabular numbers everywhere — digits must align vertically or the table is unreadable |
| Font | UI sans; **monospace with tabular figures** for all addresses, hex, and values |
| Colour | Use it only for state: green connected, amber stale, red error. Never decorative |
| Shortcuts | `Space` pause/resume · `Ctrl/Cmd+K` connect · `Ctrl/Cmd+L` frame log · `Ctrl/Cmd+E` export |
| Empty states | Every empty state says what to do next, never just "No data" |
| Destructive actions | Writes always confirm, always show the frame preview first |

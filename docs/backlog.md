# Backlog

Ideas that are **not** in v1. Add here instead of expanding the current milestone.
Nothing in this file is a commitment.

## Likely next (M6+)

- **Modbus ASCII** — small delta once RTU works; `tokio-modbus` doesn't ship it, so we'd write the framer.
- **RTU over TCP** — very common with cheap serial gateways. `tokio-modbus` supports it natively.
- **Multiple connections in tabs** — poll two devices side by side.
- **Slave ID scan** — sweep unit IDs 1–247 and report which respond. Genuinely useful on unknown buses.
- **Register map import** — CSV/XLSX of address→name→type, so the table reads in engineering terms.
- **Trend chart** — one selected tag plotted over time. Resist turning this into a SCADA package.

## Maybe

- FC 43 / 14 Read Device Identification — nice for "what am I even talking to?"
- FC 08 diagnostics (loopback, comm event counters)
- Modbus TCP server discovery via port-502 subnet sweep
- `.mbopen` session diffing
- Headless CLI mode sharing the Rust core (`modbusopen scan --tcp ... --json`)
- Frame log export in a Wireshark-readable format
- Simulator: replay from a recorded CSV
- Simulator: fault injection — deliberately return exceptions, drop responses, add latency
  (very useful for testing master-side robustness)

## Probably never

- OPC-UA / MQTT / BACnet bridging — different product
- Modbus/TLS — almost nobody deploys it
- Mobile app
- Cloud sync of sessions

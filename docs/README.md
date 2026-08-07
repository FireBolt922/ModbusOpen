# ModbusOpen documentation

## Design docs

| # | Doc | Purpose |
|---|---|---|
| 01 | [Vision and scope](01-vision-and-scope.md) | What we're building, for whom, what's out of scope, how it compares to existing tools |
| 02 | [Tech stack decision](02-tech-stack-decision.md) | ADRs: Tauri over Electron/Qt/PySide, Rust core, one app for both modes |
| 03 | [Architecture](03-architecture.md) | Module layout, IPC contract, threading model, data flow |
| 04 | [UX flows](04-ux-flows.md) | Every screen, with wireframes |
| 05 | [Data model](05-data-model.md) | Rust/TS types, session file format, device profile format |
| 06 | [Testing](06-testing.md) | Test rig, virtual serial ports, test vectors, manual checklists |

## Protocol reference

Read these before writing protocol code. They exist so nobody has to re-derive Modbus from
scattered vendor PDFs.

| Doc | Contents |
|---|---|
| [Modbus primer](reference/modbus-primer.md) | The whole protocol in one page: PDU/ADU, RTU vs TCP framing, transactions, the four data models |
| [Function codes](reference/function-codes.md) | Every FC we support, request/response layouts, quantity limits, exception codes |
| [Data types and word order](reference/data-types-word-order.md) | ABCD/CDAB/BADC/DCBA, IEEE-754 across registers, test vectors |
| [Serial timing](reference/serial-timing.md) | Baud/parity/stop, 3.5-char silence, CRC-16, RS-485 wiring gotchas |
| [Device profiles](reference/device-profiles.md) | Real register maps (L&T meter, VFD, flow meter) carried over from existing simulator scripts |

## Also

- [PLAN.md](../PLAN.md) — milestones and acceptance criteria
- [AGENTS.md](../AGENTS.md) — agent operating manual
- [backlog.md](backlog.md) — ideas parked for after v1

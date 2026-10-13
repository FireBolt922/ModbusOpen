# ModbusOpen

A fast, clean, cross-platform Modbus **scanner** and **simulator** — the tool you open when you
need to know *"is this device actually talking, and what is it saying?"* in under 30 seconds.

Think ModScan/ModSim, but modern, free, and pleasant to use.

**[Download ModbusOpen](https://firebolt922.github.io/ModbusOpen/)** for Windows, macOS or Linux.

| | |
|---|---|
| **Scanner** | Modbus master. Connect over TCP or RTU, poll registers, decode them into real values, write back. |
| **Simulator** | Modbus slave. Pretend to be a meter/VFD/PLC so you can test your master without hardware. |

**Platforms:** Windows, Ubuntu/Linux, macOS (Intel + Apple Silicon)
**Stack:** Tauri v2 + React/TypeScript UI, Rust core (`tokio-modbus`)
**Status:** ✅ M0 (Skeleton), ✅ M1 (TCP Scanner) complete · 🚧 M2 (RTU) and M3 (Writes/Frame log)
implemented and mostly verified, a couple of checks outstanding · M4 (Simulator) not started —
see [PLAN.md](PLAN.md) for the milestone breakdown

---

## Start here

| Document | What it answers |
|---|---|
| **[PLAN.md](PLAN.md)** | **The master plan.** Milestones, task breakdown, acceptance criteria, risks. Read this first. |
| [docs/01-vision-and-scope.md](docs/01-vision-and-scope.md) | What we're building, who for, and what we are deliberately *not* building |
| [docs/02-tech-stack-decision.md](docs/02-tech-stack-decision.md) | Why Tauri + Rust, and what we rejected |
| [docs/03-architecture.md](docs/03-architecture.md) | Module layout, IPC contract, threading model |
| [docs/04-ux-flows.md](docs/04-ux-flows.md) | Every screen, click by click |
| [docs/05-data-model.md](docs/05-data-model.md) | Types, session files, device profiles |
| [docs/06-testing.md](docs/06-testing.md) | How to test without hardware |
| [docs/reference/](docs/reference/) | Modbus protocol reference — function codes, word order, serial timing |
| [AGENTS.md](AGENTS.md) | Operating manual for AI agents working in this repo |
| [DEVELOPMENT.md](DEVELOPMENT.md) | **Run it locally.** Prerequisites, setup, dev/build/test commands, troubleshooting |
| [RELEASING.md](RELEASING.md) | Cutting a release, the download site, and the `RELEASE_TOKEN` setup |

## Quick start

```bash
pnpm install
pnpm tauri dev
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for prerequisites and platform-specific setup.

## License

[MIT](LICENSE). Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

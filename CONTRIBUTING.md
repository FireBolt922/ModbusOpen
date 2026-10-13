# Contributing to ModbusOpen

Thanks for helping. Bug reports, meter profiles, docs fixes and code are all welcome.

## Ways to contribute

- **Report a bug** — open an issue with the *Bug report* template. Device make/model, transport
  (TCP or RTU) and the frame log are the most useful things you can include.
- **Share a meter profile** — a `.mbmeter.json` for a device you own saves everyone else from
  typing the register map in by hand. Use the *Meter profile* issue template or open a PR adding
  it under [`profiles/`](profiles/).
- **Fix or build something** — look for issues labelled `good first issue` or `help wanted`. For
  anything bigger than a small fix, open an issue first so we can agree on the approach before
  you spend time on it. Check [PLAN.md](PLAN.md) for what is in scope for the current milestone.

## Set up

Follow [DEVELOPMENT.md](DEVELOPMENT.md) — prerequisites, `pnpm install`, `pnpm tauri dev`, and
how to run a simulated Modbus device (`testrig/slave.py`) so you don't need hardware.

**pnpm only.** Don't commit a `package-lock.json` or `yarn.lock`.

## Before you open a PR

Run the same checks CI runs — a PR can't merge until they pass:

```bash
pnpm build
pnpm test:scripts
cd src-tauri
cargo fmt -- --check
cargo clippy --all-targets -- -D warnings
cargo test
```

CI uses the latest stable Rust, which can have newer clippy lints than your local toolchain.
If CI flags something you can't reproduce, `rustup update stable` and re-run clippy.

If you touched the UI, smoke-test it against the test rig and say what you checked in the PR.

## Code conventions

The full list is in [AGENTS.md](AGENTS.md#conventions). The ones that matter most:

- Never show a wrong value silently. A decode that can't be trusted shows an error instead.
- Any change to encoding/decoding comes with unit tests using known vectors — read
  [`docs/reference/`](docs/reference/) first.
- No `unwrap()` / `expect()` outside tests and `main`.
- Rust ↔ UI calls go through Tauri commands/events the same way as existing ones
  ([docs/03-architecture.md](docs/03-architecture.md#ipc-contract)).

## Pull requests

1. Fork the repo and branch from `main`.
2. Keep each PR to one change. Small PRs get reviewed faster.
3. Fill in the PR template, and link the issue it closes (`Closes #123`).
4. PRs are squash-merged, so the PR title becomes the commit message — make it describe the change.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Be kind.

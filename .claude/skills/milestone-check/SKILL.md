---
name: milestone-check
description: Use before declaring any ModbusOpen milestone (M0–M5) complete. Runs the build/test gates and the manual smoke checklist for that milestone, then updates PLAN.md. Also use when the user asks "is M1 done?" or "can we move to the next milestone?".
---

# Milestone completion check

A milestone is done when every gate below passes. Not when the code compiles, and not when the
happy path works once.

## 1. Automated gates

Run all of these. Every one must be clean.

```bash
cd src-tauri
cargo fmt --check
cargo clippy -- -D warnings
cargo test
cd ..
npm run typecheck
npm run build
```

If `cargo test` skips `#[ignore]`d integration tests, run them explicitly:
```bash
cargo test -- --ignored
```

## 2. Milestone acceptance criteria

Open `PLAN.md`, find the current milestone, and walk its acceptance checklist. **Actually perform
each check** — do not reason about whether it would pass. Report each as pass/fail with evidence
(the value you saw, the error message you got).

## 3. Manual smoke

Run the sections of `docs/06-testing.md#3-manual-smoke-checklist` that the milestone touches:

| Milestone | Sections |
|---|---|
| M0 | — (acceptance criteria only) |
| M1 | Connection (TCP), Polling, Decoding |
| M2 | Connection (RTU), Polling |
| M3 | Writes, Frame log, Decoding (all formats) |
| M4 | Simulator, plus Connection + Polling as a regression pass |
| M5 | Everything, plus Cross-platform |

Set up the rig first — use the `modbus-test-rig` skill.

## 4. Regression pass

Later milestones must not break earlier ones. From M2 onward, re-run the previous milestone's
acceptance criteria. This is where "I changed the transport trait and TCP silently broke" gets caught.

## 5. Cross-platform

M0 and M5 require all three platforms. M1–M4 can be validated on the dev machine, but confirm CI
is still green for all three targets — a Rust dependency that doesn't build on Windows should
surface at the milestone boundary, not at release.

## 6. Report honestly

State plainly what passed, what failed, and what you skipped and why. A milestone with 9 of 10
criteria met is **not** complete — say so and name the tenth.

If something failed:
- Fix it and re-run the full check, or
- If it's genuinely out of scope, move it to `docs/backlog.md` with a note, and say explicitly in
  the report that the criterion was descoped rather than met.

Never mark a criterion passed based on it having worked earlier in the session.

## 7. Close it out

Once everything passes:

1. Update the milestone's status in `PLAN.md` (tick the boxes, mark it ✅ Complete).
2. Update the status line in `README.md`.
3. Note anything discovered that changes later milestones — a wrong estimate, a new risk, an
   assumption that didn't hold.
4. Commit with a message naming the milestone and what now works:

```
M1: TCP scanner — connect, poll FC03, decode float32/uint32 across 4 word orders

Polls a live device at 1 Hz with live retuning of unit ID, address, quantity,
and interval. Codec has full test coverage against the reference vectors.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

Then start the next milestone — and only the next one.

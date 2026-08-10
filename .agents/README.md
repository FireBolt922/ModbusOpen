# Portable agent skills

This directory is the canonical, harness-neutral home for ModbusOpen's project skills.
Each skill follows the open Agent Skills bundle shape: one `SKILL.md` file with `name` and
`description` frontmatter, plus optional `scripts/`, `references/`, and `evals/` resources.

## Rules and discovery

- Repository-wide contributor rules live in [`../AGENTS.md`](../AGENTS.md).
- The current milestone and its acceptance criteria live in [`../PLAN.md`](../PLAN.md).
- Portable skill definitions live in [`skills/`](skills/).
- `.claude/skills/` is a compatibility mirror for Claude Code's project-level discovery.
- `.claude/settings.local.json` remains Claude-specific configuration and is intentionally not
  copied here.

## Available skills

| Skill | Purpose |
|---|---|
| `modbus-protocol` | Protocol framing, addressing, decoding, exceptions, CRC, and timing |
| `tauri-ipc` | Rust-to-React Tauri commands, events, shared state, and errors |
| `modbus-test-rig` | Local TCP/RTU test devices and independent cross-check tools |
| `meter-config` | Create, validate, repair, and share `.mbmeter.json` meter packs |
| `milestone-check` | Run milestone build, test, smoke, and acceptance gates |

## Maintenance contract

Treat `.agents/skills/` as the source of truth. When changing a skill:

1. Make the change under `.agents/skills/<skill>/`.
2. Apply the same change to `.claude/skills/<skill>/` in the same commit.
3. Keep paths inside instructions repository-relative or relative to the skill directory; do not
   depend on a particular agent product's home directory or command syntax.
4. Preserve bundled scripts, references, and evals with the skill.
5. Check that the two skill trees are identical before handing off:

   ```bash
   diff -ru .agents/skills .claude/skills
   ```

This duplication is deliberate: it keeps the repository usable by harnesses that read
`.agents/skills/` while retaining Claude Code's `.claude/skills/` discovery convention.

## Decision log

- **Canonical location:** `.agents/skills/`, because the repository is intended for multiple agent
  harnesses rather than one vendor-specific runtime.
- **Compatibility strategy:** retain real files under `.claude/skills/` instead of symlinks so
  checkouts behave consistently on Windows, Linux, and macOS.
- **Rules location:** keep `AGENTS.md` at the repository root; do not duplicate the operating manual
  into vendor-specific folders.
- **Local settings:** do not generalize `.claude/settings.local.json`; permissions and MCP enablement
  are harness-specific configuration, not portable project instructions.

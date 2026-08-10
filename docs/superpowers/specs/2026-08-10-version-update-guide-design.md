# Version Update Guide Design

## Goal

Add a short `VERSION_UPDATE.md` file at the repository root that serves as the everyday quick reference for changing the ModbusOpen software version.

## Contents

The guide will include:

- The `pnpm version:set` command with a custom Git commit message.
- The same command without a message and the generated default message.
- A concise list of the files and checks handled automatically.
- Brief recovery steps for dirty version files and failed verification.
- A clear note that the command does not tag, push, publish, or trigger GitHub Actions.

The guide will stay focused on running the existing script. It will not duplicate release-workflow documentation or explain semantic versioning in depth.

## Verification

Compare every documented command and behavior against `pnpm version:set --help` and `scripts/update-version.mjs`.


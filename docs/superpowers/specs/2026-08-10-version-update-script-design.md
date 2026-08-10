# Version Update Script Design

## Goal

Provide one cross-platform command that accepts a software version and an optional Git commit message, synchronizes every ModbusOpen version source, verifies the project, and creates a focused version-bump commit.

## Command

The script will be exposed through pnpm:

```bash
pnpm version:set 0.1.2 "chore: prepare v0.1.2"
```

It will accept a version with or without a leading `v`. Files will always store the normalized version without the `v`. When the commit-message argument is omitted, the script will use `chore: bump version to v<version>`.

## Behavior

The Node.js script will:

1. Validate the requested value as a semantic version and reject the current version.
2. Confirm that `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock` have no pre-existing uncommitted changes.
3. Update the version in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.
4. Run `cargo check --manifest-path src-tauri/Cargo.toml` so Cargo updates its own lockfile entry.
5. Run `pnpm build`.
6. Verify that all four files contain the normalized version.
7. Stage only those four version files and create the Git commit.

Unrelated working-tree changes are allowed and will remain unstaged. The script will never create a tag, push commits, invoke GitHub Actions, or publish a release.

## Failures and Recovery

Invalid or missing versions, an empty explicit commit message, dirty target files, command failures, and inconsistent output will produce a concise error and a non-zero exit code. If verification fails after files are changed, the files will remain uncommitted so the user can inspect the failure; the script will not discard or overwrite work automatically.

## Verification

- Exercise help, missing-argument, invalid-version, and same-version paths without changing files.
- Run the update logic against a temporary fixture repository to verify synchronized edits, selective staging, and the default/custom commit messages.
- Run `pnpm build` after adding the script.


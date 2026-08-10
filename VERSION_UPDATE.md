# Update the Software Version

Run these commands from the project root.

## With a Git commit message

```bash
pnpm version:set 0.1.2 "chore: prepare v0.1.2"
```

## Without a Git commit message

```bash
pnpm version:set 0.1.2
```

The default message will be `chore: bump version to v0.1.2`.

## What happens automatically

The script validates the version, updates all four version files, runs `cargo check` and `pnpm build`, then commits only the version files.

It does **not** create a tag, push to GitHub, publish a release, or trigger GitHub Actions.

## If it fails

- **Version files have changes:** commit or stash those changes, then run the command again.
- **Build or check failed:** inspect the error and `git diff`. To retry from the original version, restore the four generated changes and rerun:

  ```bash
  git restore package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
  ```


# Releasing ModbusOpen

Releases are one click. The `release` workflow tests `main`, bumps the version, tags it, builds
installers for every platform, publishes the GitHub release and refreshes the download site:

**https://firebolt922.github.io/ModbusOpen/**

## Cut a release

1. GitHub → **Actions** → **release** → **Run workflow** (leave "Use workflow from" on `main`).
2. Pick **patch**, **minor** or **major**, or type an exact **version** such as `1.3.0-beta.1`.
3. Tick **Pre-release** for betas. A version with a `-suffix` is always a pre-release.
4. **Run workflow.**

Or from a terminal with the GitHub CLI:

```bash
gh workflow run release.yml -f bump=minor
gh workflow run release.yml -f version=1.3.0-beta.1
```

What the run does, in order:

| Job | What happens |
|---|---|
| test | The full CI suite (build, fmt, clippy, cargo test, script tests) on the current `main` |
| prepare | Bumps `package.json`, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`; commits `chore: bump version to vX.Y.Z` to `main`; tags `vX.Y.Z` |
| create | Creates a draft release with notes generated from merged PRs since the last tag |
| build | Builds macOS (Apple Silicon and Intel), Windows and Linux installers and attaches them |
| publish | Publishes the release. Stable releases become the "latest" download |
| pages | Rebuilds the download site with the new release |

Nothing is published until every installer has built. A stable release shows up on the
download site as the main download; pre-releases appear only in the release history.

## One-time setup

### 1. The `RELEASE_TOKEN` secret

`main` and `v*` tags are protected by rulesets, so the workflow's built-in token can't push the
version commit or the tag. It uses a fine-grained token that acts as you instead.

1. GitHub → your avatar → **Settings** → **Developer settings** → **Personal access tokens** →
   **Fine-grained tokens** → **Generate new token**.
2. **Repository access:** Only select repositories → `FireBolt922/ModbusOpen`.
3. **Permissions → Repository permissions → Contents:** Read and write. Nothing else.
4. Pick an expiry (up to a year) and generate it.
5. Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**,
   name `RELEASE_TOKEN`, paste the token.

When the token expires, the release fails at its first step with "The RELEASE_TOKEN secret is
missing" or an authentication error. Generate a new one and update the secret.

### 2. GitHub Pages

Repo → **Settings** → **Pages** → **Source:** GitHub Actions. The `pages` workflow does the
rest. It also runs when `site/` changes on `main`, when you edit or publish a release by hand,
and from **Actions → pages → Run workflow**.

## When something fails

- **test fails:** nothing was changed. Fix `main` and run the release again.
- **prepare fails with "main moved":** someone merged while the run was starting. Run it again.
- **prepare fails with "Tag … already exists":** pick a higher version.
- **A build fails:** the version commit, tag and draft release already exist. Fix the cause
  on `main` if needed, then open the failed run and use **Re-run failed jobs**. It reuses the
  same tag and draft and publishes once everything builds. To abandon the release instead,
  delete the draft release and the tag, then release a new patch version.

## Checks on every push

`ci.yml` runs on a push to any branch and on every pull request to `main`: `pnpm build`, the
script tests (`pnpm test:scripts`), `cargo fmt --check`, `cargo clippy -D warnings`,
`cargo test`, and a check that the Tauri npm packages and Rust crates are on matching versions.
Pull requests can't merge until it passes.

## Bumping the version locally

You don't need this for a release. It's for testing a version change on a branch.

```bash
pnpm version:set patch                   # 1.1.1 → 1.1.2
pnpm version:set minor                   # 1.1.1 → 1.2.0
pnpm version:set 2.0.0-beta.1            # exact version
pnpm version:set patch "chore: v1.1.2"   # custom commit message
pnpm version:set patch --no-verify       # skip cargo check + pnpm build
```

It updates the four version files, checks they agree, runs `cargo check` and `pnpm build`
(unless `--no-verify`), and commits only those files. It refuses a version lower than the
current one. It doesn't tag or push.

If it fails part-way, restore the version files and try again:

```bash
git restore package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
```

## The download site

The site's source is `site/` (static HTML, CSS and JS). `scripts/build-site.mjs` copies it to
`_site/` and writes `releases.json` from the GitHub Releases API, so the page makes no API calls
of its own. To preview locally:

```bash
node scripts/build-site.mjs        # uses live release data
cd _site && python3 -m http.server 8000
```

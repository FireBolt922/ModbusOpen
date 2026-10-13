#!/usr/bin/env node
// Builds the GitHub Pages download site into `_site/`: copies `site/` and
// writes `releases.json` from the GitHub Releases API, so the page itself
// needs no API calls (no rate limits, works the moment it loads).
//
//   GITHUB_TOKEN=… node scripts/build-site.mjs              # live data
//   node scripts/build-site.mjs --from fixtures.json         # offline preview
//
// GITHUB_REPOSITORY (owner/name) defaults to this repo.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO = "FireBolt922/ModbusOpen";
const OS_ORDER = ["macos", "windows", "linux", "other"];

/**
 * What a release asset is, from its file name. Tauri names installers like
 * `ModbusOpen_1.2.0_aarch64.dmg`, `ModbusOpen_1.2.0_x64-setup.exe`,
 * `ModbusOpen_1.2.0_amd64.AppImage`, `ModbusOpen-1.2.0-1.x86_64.rpm`.
 * Returns null for files people shouldn't download by hand (updater
 * signatures, latest.json).
 */
export function classifyAsset(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".sig") || lower === "latest.json") return null;

  const arch = /(aarch64|arm64)/.test(lower)
    ? "arm64"
    : /universal/.test(lower)
      ? "universal"
      : /(x64|x86_64|amd64)/.test(lower)
        ? "x64"
        : null;

  if (lower.endsWith(".dmg")) {
    const label =
      arch === "arm64" ? "Apple Silicon" : arch === "universal" ? "Universal" : "Intel";
    return { os: "macos", arch, kind: "dmg", label: `${label} (.dmg)`, rank: 1 };
  }
  if (lower.endsWith(".app.tar.gz")) {
    const label = arch === "arm64" ? "Apple Silicon" : "Intel";
    return { os: "macos", arch, kind: "app", label: `${label} app bundle (.tar.gz)`, rank: 3 };
  }
  if (lower.endsWith(".exe")) {
    return { os: "windows", arch, kind: "exe", label: "Installer (.exe)", rank: 1 };
  }
  if (lower.endsWith(".msi")) {
    return { os: "windows", arch, kind: "msi", label: "MSI package (.msi)", rank: 2 };
  }
  if (lower.endsWith(".appimage")) {
    return { os: "linux", arch, kind: "appimage", label: "AppImage", rank: 1 };
  }
  if (lower.endsWith(".deb")) {
    return { os: "linux", arch, kind: "deb", label: "Debian / Ubuntu (.deb)", rank: 2 };
  }
  if (lower.endsWith(".rpm")) {
    return { os: "linux", arch, kind: "rpm", label: "Fedora / RHEL (.rpm)", rank: 3 };
  }
  return { os: "other", arch, kind: "file", label: name, rank: 9 };
}

/** Shapes raw GitHub API releases into what the page renders. */
export function toSiteData(rawReleases, repo = DEFAULT_REPO) {
  const releases = rawReleases
    .filter((r) => !r.draft)
    .map((r) => ({
      tag: r.tag_name,
      version: r.tag_name.replace(/^v/, ""),
      name: r.name || r.tag_name,
      prerelease: Boolean(r.prerelease),
      publishedAt: r.published_at,
      url: r.html_url,
      notesHtml: r.body_html || "",
      assets: (r.assets || [])
        .map((a) => {
          const info = classifyAsset(a.name);
          return info && {
            name: a.name,
            url: a.browser_download_url,
            size: a.size,
            ...info,
          };
        })
        .filter(Boolean)
        .sort(
          (a, b) =>
            OS_ORDER.indexOf(a.os) - OS_ORDER.indexOf(b.os) ||
            a.rank - b.rank ||
            a.name.localeCompare(b.name),
        ),
    }))
    .sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));

  const latest = releases.find((r) => !r.prerelease) || null;
  return {
    repo,
    repoUrl: `https://github.com/${repo}`,
    generatedAt: new Date().toISOString(),
    latestTag: latest ? latest.tag : null,
    releases,
  };
}

async function fetchReleases(repo, token) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`,
      {
        headers: {
          // `full` adds body_html: GitHub renders and sanitises the notes.
          Accept: "application/vnd.github.full+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
    );
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status} for ${repo} releases: ${await res.text()}`);
    }
    const batch = await res.json();
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const repo = process.env.GITHUB_REPOSITORY || DEFAULT_REPO;
  const fromIndex = process.argv.indexOf("--from");
  const raw =
    fromIndex !== -1
      ? JSON.parse(readFileSync(process.argv[fromIndex + 1], "utf8"))
      : await fetchReleases(repo, process.env.GITHUB_TOKEN);

  const out = path.join(root, "_site");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(path.join(root, "site"), out, { recursive: true });

  const icon = path.join(root, "src-tauri", "icons", "128x128.png");
  if (existsSync(icon)) cpSync(icon, path.join(out, "icon.png"));

  const data = toSiteData(raw, repo);
  writeFileSync(path.join(out, "releases.json"), `${JSON.stringify(data, null, 2)}\n`);
  console.log(
    `Built _site/ with ${data.releases.length} release(s); latest stable: ${data.latestTag ?? "none"}.`,
  );
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    console.error(`Site build failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}

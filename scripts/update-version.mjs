#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_FILES = [
  "package.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];

// SemVer 2.0.0, including optional prerelease and build metadata.
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function commandName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

export function runProcess(command, args, { cwd, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.error) {
    throw new Error(`Could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = capture ? (result.stderr || result.stdout).trim() : "";
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}${detail ? `: ${detail}` : ""}`,
    );
  }

  return capture ? result.stdout : "";
}

export function normalizeVersion(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("Provide a version, for example: 0.1.2");
  }

  const trimmed = input.trim();
  const version = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(
      `“${input}” is not a valid semantic version (expected something like 0.1.2).`,
    );
  }
  return version;
}

export const BUMP_KINDS = ["patch", "minor", "major"];

function parseCore(version) {
  const [core, prerelease] = version.split("+")[0].split(/-(.*)/s);
  const [major, minor, patch] = core.split(".").map(Number);
  return { major, minor, patch, prerelease: prerelease || undefined };
}

/**
 * npm-style bump: `patch` on 1.2.3 → 1.2.4, `minor` → 1.3.0, `major` → 2.0.0.
 * A prerelease is "finished" by the bump it is heading to, so `patch` on
 * 1.3.0-beta.1 → 1.3.0 and `minor` on 1.3.0-beta.1 → 1.3.0.
 */
export function bumpVersion(current, kind) {
  const v = parseCore(normalizeVersion(current));
  switch (kind) {
    case "patch":
      return v.prerelease
        ? `${v.major}.${v.minor}.${v.patch}`
        : `${v.major}.${v.minor}.${v.patch + 1}`;
    case "minor":
      return v.prerelease && v.patch === 0
        ? `${v.major}.${v.minor}.0`
        : `${v.major}.${v.minor + 1}.0`;
    case "major":
      return v.prerelease && v.minor === 0 && v.patch === 0
        ? `${v.major}.0.0`
        : `${v.major + 1}.0.0`;
    default:
      throw new Error(
        `Unknown bump “${kind}” (expected ${BUMP_KINDS.join(", ")}).`,
      );
  }
}

/** Accepts a bump keyword or an explicit version. */
export function resolveVersion(input, current) {
  const trimmed = typeof input === "string" ? input.trim() : input;
  return BUMP_KINDS.includes(trimmed)
    ? bumpVersion(current, trimmed)
    : normalizeVersion(trimmed);
}

/** SemVer precedence on major.minor.patch, then "prerelease < release". */
export function compareVersions(a, b) {
  const x = parseCore(a);
  const y = parseCore(b);
  for (const key of ["major", "minor", "patch"]) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  if (x.prerelease === y.prerelease) return 0;
  if (!x.prerelease) return 1;
  if (!y.prerelease) return -1;
  return x.prerelease < y.prerelease ? -1 : 1;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function cargoTomlVersion(contents) {
  const match = contents.match(
    /^\[package\][\s\S]*?^version\s*=\s*"([^"\r\n]+)"/m,
  );
  if (!match) throw new Error("Could not find [package].version in Cargo.toml.");
  return match[1];
}

function cargoLockVersion(contents) {
  const match = contents.match(
    /\[\[package\]\]\r?\nname = "modbusopen"\r?\nversion = "([^"\r\n]+)"/,
  );
  if (!match) throw new Error("Could not find the modbusopen package in Cargo.lock.");
  return match[1];
}

function versionsAt(repoRoot) {
  return {
    packageJson: readJson(path.join(repoRoot, "package.json")).version,
    tauriConfig: readJson(
      path.join(repoRoot, "src-tauri", "tauri.conf.json"),
    ).version,
    cargoToml: cargoTomlVersion(
      readFileSync(path.join(repoRoot, "src-tauri", "Cargo.toml"), "utf8"),
    ),
    cargoLock: cargoLockVersion(
      readFileSync(path.join(repoRoot, "src-tauri", "Cargo.lock"), "utf8"),
    ),
  };
}

function assertVersionsMatch(repoRoot, expected) {
  const versions = versionsAt(repoRoot);
  const mismatches = Object.entries(versions).filter(
    ([, version]) => version !== expected,
  );
  if (mismatches.length > 0) {
    const details = mismatches
      .map(([source, version]) => `${source}=${version}`)
      .join(", ");
    throw new Error(`Version sources are inconsistent: ${details}; expected ${expected}.`);
  }
}

function updateVersionSources(repoRoot, version) {
  const packagePath = path.join(repoRoot, "package.json");
  const packageJson = readJson(packagePath);
  packageJson.version = version;
  writeJson(packagePath, packageJson);

  const tauriPath = path.join(repoRoot, "src-tauri", "tauri.conf.json");
  const tauriConfig = readJson(tauriPath);
  tauriConfig.version = version;
  writeJson(tauriPath, tauriConfig);

  const cargoPath = path.join(repoRoot, "src-tauri", "Cargo.toml");
  const cargoToml = readFileSync(cargoPath, "utf8");
  const versionPattern =
    /^(\[package\][\s\S]*?^version\s*=\s*")[^"\r\n]+(".*)$/m;
  if (!versionPattern.test(cargoToml)) {
    throw new Error("Could not update [package].version in Cargo.toml.");
  }
  writeFileSync(
    cargoPath,
    cargoToml.replace(versionPattern, (_, before, after) => {
      return `${before}${version}${after}`;
    }),
  );

  // Rewrite our own entry in Cargo.lock directly, so a bump doesn't need a
  // full `cargo check` (CI's release job runs without Tauri's system libs).
  const lockPath = path.join(repoRoot, "src-tauri", "Cargo.lock");
  const lockPattern =
    /(\[\[package\]\]\r?\nname = "modbusopen"\r?\nversion = ")[^"\r\n]+(")/;
  const cargoLock = readFileSync(lockPath, "utf8");
  if (!lockPattern.test(cargoLock)) {
    throw new Error("Could not update the modbusopen package in Cargo.lock.");
  }
  writeFileSync(lockPath, cargoLock.replace(lockPattern, `$1${version}$2`));
}

function ensureVersionFilesAreClean(repoRoot, execute) {
  const status = execute("git", ["status", "--porcelain", "--", ...VERSION_FILES], {
    cwd: repoRoot,
    capture: true,
  }).trim();
  if (status !== "") {
    throw new Error(
      `Version files already have uncommitted changes:\n${status}\nCommit or stash them before running this command.`,
    );
  }
}

export function runVersionUpdate({
  repoRoot,
  versionInput,
  commitMessage,
  verify = true,
  execute = runProcess,
}) {
  const currentVersion = versionsAt(repoRoot).packageJson;
  assertVersionsMatch(repoRoot, currentVersion);
  const version = resolveVersion(versionInput, currentVersion);

  if (version === currentVersion) {
    throw new Error(`The project is already at version ${version}.`);
  }
  if (compareVersions(version, currentVersion) < 0) {
    throw new Error(
      `${version} is lower than the current version ${currentVersion}.`,
    );
  }

  const messageWasProvided = commitMessage !== undefined;
  const message = messageWasProvided
    ? commitMessage.trim()
    : `chore: bump version to v${version}`;
  if (message === "") {
    throw new Error("The commit message cannot be empty.");
  }

  ensureVersionFilesAreClean(repoRoot, execute);
  updateVersionSources(repoRoot, version);

  if (verify) {
    execute(commandName("cargo"), [
      "check",
      "--manifest-path",
      "src-tauri/Cargo.toml",
    ], { cwd: repoRoot });
    execute(commandName("pnpm"), ["build"], { cwd: repoRoot });
  }

  assertVersionsMatch(repoRoot, version);
  execute("git", ["diff", "--check", "--", ...VERSION_FILES], {
    cwd: repoRoot,
  });
  execute("git", ["add", "--", ...VERSION_FILES], { cwd: repoRoot });
  execute(
    "git",
    ["commit", "--only", "-m", message, "--", ...VERSION_FILES],
    { cwd: repoRoot },
  );

  return { version, message };
}

function usage() {
  return [
    "Usage: pnpm version:set <patch|minor|major|version> [commit message] [--no-verify]",
    "",
    "Examples:",
    "  pnpm version:set patch",
    '  pnpm version:set 0.1.2 "chore: prepare v0.1.2"',
    "  pnpm version:set v0.2.0 --no-verify   # skip cargo check + pnpm build",
  ].join("\n");
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h") {
    console.log(usage());
    return;
  }

  const verify = !args.includes("--no-verify");
  const [versionInput, ...messageParts] = args.filter(
    (arg) => arg !== "--no-verify",
  );
  const commitMessage = messageParts.length > 0 ? messageParts.join(" ") : undefined;
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const result = runVersionUpdate({
    repoRoot,
    versionInput,
    commitMessage,
    verify,
  });
  console.log(
    `Updated ModbusOpen to v${result.version} and committed as “${result.message}”.`,
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Version update failed: ${message}`);
    process.exitCode = 1;
  }
}

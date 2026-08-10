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
  execute = runProcess,
}) {
  const version = normalizeVersion(versionInput);
  const currentVersion = versionsAt(repoRoot).packageJson;
  assertVersionsMatch(repoRoot, currentVersion);

  if (version === currentVersion) {
    throw new Error(`The project is already at version ${version}.`);
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

  execute(commandName("cargo"), [
    "check",
    "--manifest-path",
    "src-tauri/Cargo.toml",
  ], { cwd: repoRoot });
  execute(commandName("pnpm"), ["build"], { cwd: repoRoot });

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
    "Usage: pnpm version:set <version> [commit message]",
    "",
    "Examples:",
    '  pnpm version:set 0.1.2 "chore: prepare v0.1.2"',
    "  pnpm version:set v0.2.0",
  ].join("\n");
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h") {
    console.log(usage());
    return;
  }

  const [versionInput, ...messageParts] = args;
  const commitMessage = messageParts.length > 0 ? messageParts.join(" ") : undefined;
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const result = runVersionUpdate({
    repoRoot,
    versionInput,
    commitMessage,
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

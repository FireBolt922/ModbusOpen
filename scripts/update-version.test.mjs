import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bumpVersion,
  compareVersions,
  normalizeVersion,
  resolveVersion,
  runProcess,
  runVersionUpdate,
} from "./update-version.mjs";

function writeFixtureFile(root, relativePath, contents) {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "modbusopen-version-script-"));
  writeFixtureFile(
    root,
    "package.json",
    `${JSON.stringify({ name: "fixture", version: "0.1.1", scripts: {} }, null, 2)}\n`,
  );
  writeFixtureFile(
    root,
    "src-tauri/tauri.conf.json",
    `${JSON.stringify({ productName: "ModbusOpen", version: "0.1.1" }, null, 2)}\n`,
  );
  writeFixtureFile(
    root,
    "src-tauri/Cargo.toml",
    '[package]\nname = "modbusopen"\nversion = "0.1.1"\nedition = "2021"\n',
  );
  writeFixtureFile(
    root,
    "src-tauri/Cargo.lock",
    'version = 4\n\n[[package]]\nname = "modbusopen"\nversion = "0.1.1"\n',
  );
  writeFixtureFile(root, "unrelated.txt", "before\n");

  runProcess("git", ["init", "--quiet"], { cwd: root });
  runProcess("git", ["config", "user.name", "Version Script Test"], {
    cwd: root,
  });
  runProcess("git", ["config", "user.email", "version-script@example.test"], {
    cwd: root,
  });
  runProcess("git", ["add", "."], { cwd: root });
  runProcess("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  writeFixtureFile(root, "unrelated.txt", "after\n");

  return root;
}

function fixtureExecutor(root) {
  return (command, args, options = {}) => {
    if (command === "cargo" || command === "cargo.cmd") {
      assert.deepEqual(args, [
        "check",
        "--manifest-path",
        "src-tauri/Cargo.toml",
      ]);
      const cargoToml = readFileSync(
        path.join(root, "src-tauri", "Cargo.toml"),
        "utf8",
      );
      const version = cargoToml.match(/^version = "([^"]+)"$/m)?.[1];
      assert.ok(version);
      const lockPath = path.join(root, "src-tauri", "Cargo.lock");
      writeFileSync(
        lockPath,
        readFileSync(lockPath, "utf8").replace(
          /(name = "modbusopen"\nversion = ")[^"]+/,
          `$1${version}`,
        ),
      );
      return "";
    }
    if (command === "pnpm" || command === "pnpm.cmd") {
      assert.deepEqual(args, ["build"]);
      return "";
    }
    return runProcess(command, args, options);
  };
}

function readFixtureVersions(root) {
  const packageVersion = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  ).version;
  const tauriVersion = JSON.parse(
    readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  ).version;
  const cargoVersion = readFileSync(
    path.join(root, "src-tauri", "Cargo.toml"),
    "utf8",
  ).match(/^version = "([^"]+)"$/m)?.[1];
  const lockVersion = readFileSync(
    path.join(root, "src-tauri", "Cargo.lock"),
    "utf8",
  ).match(/name = "modbusopen"\nversion = "([^"]+)"/)?.[1];
  return [packageVersion, tauriVersion, cargoVersion, lockVersion];
}

test("normalizes valid versions and rejects invalid versions", () => {
  assert.equal(normalizeVersion("v0.2.0"), "0.2.0");
  assert.equal(normalizeVersion("1.0.0-beta.1"), "1.0.0-beta.1");
  assert.throws(() => normalizeVersion("1.2"), /not a valid semantic version/);
  assert.throws(() => normalizeVersion("01.2.3"), /not a valid semantic version/);
});

test("updates every source and commits only version files", () => {
  const root = createFixture();
  try {
    const result = runVersionUpdate({
      repoRoot: root,
      versionInput: "v0.1.2",
      commitMessage: "release: prepare v0.1.2",
      execute: fixtureExecutor(root),
    });

    assert.deepEqual(result, {
      version: "0.1.2",
      message: "release: prepare v0.1.2",
    });
    assert.deepEqual(readFixtureVersions(root), [
      "0.1.2",
      "0.1.2",
      "0.1.2",
      "0.1.2",
    ]);
    assert.equal(
      runProcess("git", ["log", "-1", "--format=%s"], {
        cwd: root,
        capture: true,
      }).trim(),
      "release: prepare v0.1.2",
    );
    const committedFiles = runProcess(
      "git",
      ["show", "--pretty=format:", "--name-only", "HEAD"],
      { cwd: root, capture: true },
    )
      .trim()
      .split("\n")
      .sort();
    assert.deepEqual(committedFiles, [
      "package.json",
      "src-tauri/Cargo.lock",
      "src-tauri/Cargo.toml",
      "src-tauri/tauri.conf.json",
    ]);
    assert.equal(
      runProcess("git", ["status", "--porcelain", "--", "unrelated.txt"], {
        cwd: root,
        capture: true,
      }).trim(),
      "M unrelated.txt",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses a default commit message", () => {
  const root = createFixture();
  try {
    const result = runVersionUpdate({
      repoRoot: root,
      versionInput: "0.2.0",
      execute: fixtureExecutor(root),
    });
    assert.equal(result.message, "chore: bump version to v0.2.0");
    assert.equal(
      runProcess("git", ["log", "-1", "--format=%s"], {
        cwd: root,
        capture: true,
      }).trim(),
      "chore: bump version to v0.2.0",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects the current version and dirty version files", () => {
  const root = createFixture();
  try {
    assert.throws(
      () =>
        runVersionUpdate({
          repoRoot: root,
          versionInput: "0.1.1",
          execute: fixtureExecutor(root),
        }),
      /already at version 0\.1\.1/,
    );

    const packagePath = path.join(root, "package.json");
    writeFileSync(packagePath, `${readFileSync(packagePath, "utf8")}\n`);
    assert.throws(
      () =>
        runVersionUpdate({
          repoRoot: root,
          versionInput: "0.1.2",
          execute: fixtureExecutor(root),
        }),
      /Version files already have uncommitted changes/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bumps patch, minor and major like npm", () => {
  assert.equal(bumpVersion("1.1.1", "patch"), "1.1.2");
  assert.equal(bumpVersion("1.1.1", "minor"), "1.2.0");
  assert.equal(bumpVersion("1.1.1", "major"), "2.0.0");
  // A prerelease is finished by the bump it is heading to.
  assert.equal(bumpVersion("1.3.0-beta.1", "patch"), "1.3.0");
  assert.equal(bumpVersion("1.3.0-beta.1", "minor"), "1.3.0");
  assert.equal(bumpVersion("2.0.0-rc.1", "major"), "2.0.0");
  assert.equal(bumpVersion("1.3.1-beta.1", "minor"), "1.4.0");
  assert.throws(() => bumpVersion("1.1.1", "huge"), /Unknown bump/);
});

test("resolves keywords and explicit versions", () => {
  assert.equal(resolveVersion("minor", "0.4.2"), "0.5.0");
  assert.equal(resolveVersion(" v0.6.0 ", "0.4.2"), "0.6.0");
});

test("orders versions by semver precedence", () => {
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.2.3-beta.1", "1.2.3"), -1);
  assert.equal(compareVersions("1.2.3", "1.2.3-rc.1"), 1);
});

test("bump keyword with --no-verify updates Cargo.lock without cargo or pnpm", () => {
  const root = createFixture();
  try {
    const execute = (command, args, options = {}) => {
      assert.ok(
        !/^(cargo|pnpm)(\.cmd)?$/.test(command),
        `${command} must not run when verify is false`,
      );
      return runProcess(command, args, options);
    };
    const result = runVersionUpdate({
      repoRoot: root,
      versionInput: "minor",
      verify: false,
      execute,
    });
    assert.equal(result.version, "0.2.0");
    assert.deepEqual(readFixtureVersions(root), [
      "0.2.0",
      "0.2.0",
      "0.2.0",
      "0.2.0",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects going backwards", () => {
  const root = createFixture();
  try {
    assert.throws(
      () =>
        runVersionUpdate({
          repoRoot: root,
          versionInput: "0.1.0",
          execute: fixtureExecutor(root),
        }),
      /lower than the current version 0\.1\.1/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

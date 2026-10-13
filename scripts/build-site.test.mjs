import assert from "node:assert/strict";
import test from "node:test";
import { classifyAsset, toSiteData } from "./build-site.mjs";

test("classifies Tauri installer names by OS, arch and kind", () => {
  const cases = {
    "ModbusOpen_1.2.0_aarch64.dmg": ["macos", "arm64", "dmg"],
    "ModbusOpen_1.2.0_x64.dmg": ["macos", "x64", "dmg"],
    "ModbusOpen_universal.app.tar.gz": ["macos", "universal", "app"],
    "ModbusOpen_1.2.0_x64-setup.exe": ["windows", "x64", "exe"],
    "ModbusOpen_1.2.0_x64_en-US.msi": ["windows", "x64", "msi"],
    "ModbusOpen_1.2.0_amd64.AppImage": ["linux", "x64", "appimage"],
    "ModbusOpen_1.2.0_amd64.deb": ["linux", "x64", "deb"],
    "ModbusOpen-1.2.0-1.x86_64.rpm": ["linux", "x64", "rpm"],
  };
  for (const [name, [os, arch, kind]] of Object.entries(cases)) {
    const info = classifyAsset(name);
    assert.deepEqual([info.os, info.arch, info.kind], [os, arch, kind], name);
  }
  assert.equal(classifyAsset("ModbusOpen_x64.app.tar.gz.sig"), null);
  assert.equal(classifyAsset("latest.json"), null);
});

test("drops drafts, sorts newest first and picks the latest stable", () => {
  const data = toSiteData([
    { tag_name: "v1.0.0", published_at: "2026-01-01T00:00:00Z", assets: [] },
    { tag_name: "v1.2.0-beta.1", prerelease: true, published_at: "2026-03-01T00:00:00Z", assets: [] },
    { tag_name: "v1.1.0", published_at: "2026-02-01T00:00:00Z", assets: [] },
    { tag_name: "v1.3.0", draft: true, published_at: null, assets: [] },
  ]);
  assert.deepEqual(
    data.releases.map((r) => r.tag),
    ["v1.2.0-beta.1", "v1.1.0", "v1.0.0"],
  );
  assert.equal(data.latestTag, "v1.1.0");
});

test("orders assets by OS then preference, hiding signatures", () => {
  const [release] = toSiteData([
    {
      tag_name: "v1.0.0",
      published_at: "2026-01-01T00:00:00Z",
      assets: [
        { name: "ModbusOpen_1.0.0_x64_en-US.msi", browser_download_url: "u1", size: 1 },
        { name: "ModbusOpen_1.0.0_x64-setup.exe", browser_download_url: "u2", size: 1 },
        { name: "ModbusOpen_x64.app.tar.gz.sig", browser_download_url: "u3", size: 1 },
        { name: "ModbusOpen_1.0.0_amd64.deb", browser_download_url: "u4", size: 1 },
      ],
    },
  ]).releases;
  assert.deepEqual(
    release.assets.map((a) => a.kind),
    ["exe", "msi", "deb"],
  );
});

test("no stable release means no latest", () => {
  const data = toSiteData([
    { tag_name: "v0.1.0-alpha", prerelease: true, published_at: "2026-01-01T00:00:00Z", assets: [] },
  ]);
  assert.equal(data.latestTag, null);
  assert.equal(data.releases.length, 1);
});

# App Version Label Design

## Goal

Show the owner name and installed software version as `FireBolt — v0.1.1` in the bottom-right corner of every ModbusOpen screen.

## Design

A small shared `AppVersion` React component will render once beside the router in `App.tsx`, keeping the label visible across all routes. It will use fixed positioning with muted text, safe spacing from the window edges, and no pointer interaction so it does not interfere with screen controls.

The component will read the packaged version through Tauri's `getVersion()` API. Until that asynchronous call completes, or if the UI is opened outside Tauri, the component will render no version label rather than show a misleading value.

The release version will be changed to `0.1.1` in the three existing version sources: `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`. The visible label treats the Tauri configuration as the packaged runtime source of truth.

## Verification

- Build the TypeScript/Vite frontend with `pnpm build`.
- Confirm the version sources all contain `0.1.1`.
- Confirm the component is mounted outside `Routes`, making it route-independent.

## Scope

This change only adds the attribution/version label and increments the patch version. It does not add update checking, automatic updates, release automation, or other branding changes.

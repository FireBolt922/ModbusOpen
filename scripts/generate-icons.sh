#!/usr/bin/env bash
#
# Regenerates the whole ModbusOpen icon set from the SVG masters.
#
#   src-tauri/icons/icon-source.svg        -> everything 48px and up
#   src-tauri/icons/icon-source-small.svg  -> the 32px Linux/tray icon
#
# Requires: rsvg-convert (brew install librsvg). Run via `pnpm icons`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ICONS="$ROOT/src-tauri/icons"
MASTER="$ICONS/icon-source.svg"
MASTER_SMALL="$ICONS/icon-source-small.svg"

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "error: rsvg-convert not found. Install it with: brew install librsvg" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> Rendering 1024px master from $(basename "$MASTER")"
rsvg-convert -w 1024 -h 1024 -f png -o "$TMP/master.png" "$MASTER"

echo "==> Generating platform icon set (png / ico / icns)"
(cd "$ROOT" && pnpm exec tauri icon "$TMP/master.png" --output "$ICONS")

echo "==> Dropping the iOS/Android sets (ModbusOpen is desktop-only)"
rm -rf "$ICONS/ios" "$ICONS/android"

echo "==> Overriding 32x32.png with the simplified small-size mark"
rsvg-convert -w 32 -h 32 -f png -o "$ICONS/32x32.png" "$MASTER_SMALL"

# Rebuild the .icns so that everything 32px and below uses the simplified mark.
# The detailed logo turns to mush at Finder-list-view sizes.
if command -v iconutil >/dev/null 2>&1; then
  echo "==> Rebuilding icon.icns with a crisp small-size mark"
  SET="$TMP/ModbusOpen.iconset"
  mkdir -p "$SET"
  for spec in 16:icon_16x16 32:icon_16x16@2x 32:icon_32x32; do
    rsvg-convert -w "${spec%%:*}" -h "${spec%%:*}" -f png \
      -o "$SET/${spec##*:}.png" "$MASTER_SMALL"
  done
  for spec in 64:icon_32x32@2x 128:icon_128x128 256:icon_128x128@2x \
              256:icon_256x256 512:icon_256x256@2x 512:icon_512x512 \
              1024:icon_512x512@2x; do
    rsvg-convert -w "${spec%%:*}" -h "${spec%%:*}" -f png \
      -o "$SET/${spec##*:}.png" "$MASTER"
  done
  iconutil -c icns "$SET" -o "$ICONS/icon.icns"
fi

echo "==> Done. Icons written to src-tauri/icons/"

#!/usr/bin/env bash
set -euo pipefail

# Tauri builds .app before its DMG script mounts an intermediate image. Finder
# can briefly keep that image busy at detach. Retry only that known transient,
# reusing the compiled production binary via the supported `tauri bundle` CLI.
# No forced unmounts, Finder kills, indexing changes, or signing changes.
# Upstream: https://github.com/tauri-apps/tauri/tree/dev/crates/tauri-bundler/src/bundle/macos/dmg
TARGET="${1:?Expected an Apple target triple}"
case "$TARGET" in
  aarch64-apple-darwin|x86_64-apple-darwin) ;;
  *) echo "Unsupported macOS target: $TARGET" >&2; exit 2 ;;
esac
LOG=$(mktemp "${TMPDIR:-/tmp}/pupa-dmg.XXXXXX")
trap 'rm -f "$LOG"' EXIT
STATUS=0
run_logged() {
  set +e
  "$@" 2>&1 | tee "$LOG"
  STATUS=${PIPESTATUS[0]}
  set -e
}

run_logged npm run dist -- --target "$TARGET" --bundles dmg --ci -- --locked
for RETRY in 1 2; do
  if [ "$STATUS" -eq 0 ]; then exit 0; fi
  if ! grep -Eq 'hdiutil:.*Resource busy' "$LOG" || ! grep -Eq '(error running|failed to run) bundle_dmg\.sh' "$LOG"; then
    exit "$STATUS"
  fi
  DELAY=$((RETRY * 20))
  echo "::warning::DMG detach is temporarily busy. Retrying packaging only ($RETRY/2) after ${DELAY}s."
  sleep "$DELAY"
  run_logged npm run tauri -- bundle --target "$TARGET" --bundles dmg --ci
done
if [ "$STATUS" -eq 0 ]; then exit 0; fi
# A fallback is allowed only for the same known packaging transient, never for
# Rust compilation, signing, permissions, or unrelated packaging failures.
if ! grep -Eq 'hdiutil:.*Resource busy' "$LOG" || ! grep -Eq '(error running|failed to run) bundle_dmg\.sh' "$LOG"; then exit "$STATUS"; fi
APP="src-tauri/target/$TARGET/release/bundle/macos/Pupa.app"
PLIST="$APP/Contents/Info.plist"
VERSION=$(node -p "require('./package.json').version")
[ -f "$PLIST" ] && [ -x "$APP/Contents/MacOS/pupa" ] || exit "$STATUS"
[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$PLIST")" = jp.kuro0315.pupa ] || exit "$STATUS"
[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$PLIST")" = "$VERSION" ] || exit "$STATUS"
ARCH=x86_64; [ "$TARGET" != aarch64-apple-darwin ] || ARCH=arm64
/usr/bin/lipo -verify_arch "$ARCH" "$APP/Contents/MacOS/pupa"
OUT="src-tauri/target/$TARGET/release/bundle/macos-zip"
mkdir -p "$OUT"
ZIP="$OUT/Pupa-$VERSION-$ARCH.app.zip"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
/usr/bin/unzip -tq "$ZIP"
/usr/bin/unzip -Z1 "$ZIP" | grep -Fx 'Pupa.app/Contents/MacOS/pupa'
echo '::warning::DMG packaging remained busy. Delivering the verified production .app ZIP instead; this is not a DMG.'
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf 'DMG packaging failed with transient hdiutil Resource busy after two retries. Delivered a verified production Pupa.app ZIP for %s instead. No signing or notarization claim.\n' "$TARGET" >> "$GITHUB_STEP_SUMMARY"
fi

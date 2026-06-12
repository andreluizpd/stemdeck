#!/usr/bin/env bash
# Build a relocatable Rubber Band CLI pack for macOS desktop (arm64 / x64).
# Output: .build/StemDeck-rubberband-macOS-${ARCH}.tar.zst
# Layout inside the archive (extract into DATA_DIR/ffmpeg/):
#   rubberband
#   lib/*.dylib
set -euo pipefail

ARCH="${ARCH:-arm64}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD_DIR="${REPO_ROOT}/.build"
STAGING="${BUILD_DIR}/rubberband-staging-${ARCH}"
ARCHIVE_NAME="StemDeck-rubberband-macOS-${ARCH}.tar.zst"
ARCHIVE_PATH="${BUILD_DIR}/${ARCHIVE_NAME}"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "ERROR: make-rubberband-pack.sh must run on macOS" >&2
  exit 1
fi

if [[ "$ARCH" != "arm64" && "$ARCH" != "x64" ]]; then
  echo "ERROR: ARCH must be arm64 or x64, got '${ARCH}'" >&2
  exit 1
fi

for cmd in brew tar otool install_name_tool; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: required command not found on PATH: $cmd" >&2
    exit 1
  fi
done

run_arch() {
  if [[ "$ARCH" == "x64" && "$(uname -m)" == "arm64" ]]; then
    arch -x86_64 "$@"
  else
    "$@"
  fi
}

echo "==> Installing Rubber Band via Homebrew (${ARCH})"
run_arch brew install rubberband

RB_BIN="$(run_arch brew --prefix rubberband)/bin/rubberband"
if [[ ! -f "$RB_BIN" ]]; then
  echo "ERROR: rubberband binary not found at ${RB_BIN}" >&2
  exit 1
fi

RB_MACHINE="$(run_arch file -b "$RB_BIN")"
if [[ "$ARCH" == "arm64" && "$RB_MACHINE" != *arm64* ]]; then
  echo "ERROR: expected arm64 rubberband, got: ${RB_MACHINE}" >&2
  exit 1
fi
if [[ "$ARCH" == "x64" && "$RB_MACHINE" != *x86_64* ]]; then
  echo "ERROR: expected x86_64 rubberband, got: ${RB_MACHINE}" >&2
  exit 1
fi

rm -rf "$STAGING"
mkdir -p "$STAGING/lib"
cp "$RB_BIN" "$STAGING/rubberband"
chmod +w "$STAGING/rubberband"

# Recursively copy Homebrew dylib dependencies and rewrite load paths to
# @executable_path/lib so the binary runs from the portable ffmpeg folder.
bundle_deps() {
  local target=$1
  local seen_file="${STAGING}/.bundled-deps"
  touch "$seen_file"
  local dep base dest

  while IFS= read -r dep; do
    case "$dep" in
      @*|/usr/lib/*|/System/*|/Library/*) continue ;;
    esac
    base="$(basename "$dep")"
    dest="${STAGING}/lib/${base}"
    if ! grep -Fxq "$dep" "$seen_file" 2>/dev/null; then
      echo "$dep" >>"$seen_file"
      if [[ ! -f "$dest" ]]; then
        if [[ ! -f "$dep" ]]; then
          echo "ERROR: missing dependency $dep for $target" >&2
          exit 1
        fi
        cp "$dep" "$dest"
        chmod +w "$dest"
        install_name_tool -id "@executable_path/lib/${base}" "$dest"
        bundle_deps "$dest"
      fi
    fi
    install_name_tool -change "$dep" "@executable_path/lib/${base}" "$target" 2>/dev/null || true
  done < <(otool -L "$target" | tail -n +2 | sed 's/^[[:space:]]*//' | cut -d' ' -f1)
}

echo "==> Bundling dylib dependencies"
bundle_deps "$STAGING/rubberband"
install_name_tool -add_rpath "@executable_path/lib" "$STAGING/rubberband" 2>/dev/null || true

echo "==> Ad-hoc codesign (install_name_tool invalidates Homebrew signatures)"
if ls "${STAGING}/lib/"*.dylib >/dev/null 2>&1; then
  codesign --force --sign - "${STAGING}/lib/"*.dylib
fi
codesign --force --sign - "$STAGING/rubberband"

echo "==> Smoke test"
DYLD_LIBRARY_PATH="${STAGING}/lib" "$STAGING/rubberband" --version >/dev/null

rm -f "$ARCHIVE_PATH"
if command -v zstd >/dev/null 2>&1; then
  tar --zstd -cf "$ARCHIVE_PATH" -C "$STAGING" rubberband lib
else
  ARCHIVE_NAME="StemDeck-rubberband-macOS-${ARCH}.tar.gz"
  ARCHIVE_PATH="${BUILD_DIR}/${ARCHIVE_NAME}"
  tar -czf "$ARCHIVE_PATH" -C "$STAGING" rubberband lib
fi

SHA256="$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')"
SIZE="$(stat -f%z "$ARCHIVE_PATH")"

cat > "${BUILD_DIR}/rubberband-manifest-${ARCH}.json" <<JSON
{
  "arch": "${ARCH}",
  "archiveName": "${ARCHIVE_NAME}",
  "archiveSha256": "${SHA256}",
  "archiveSize": ${SIZE}
}
JSON

echo "==> Rubber Band pack ready"
echo "Archive:  ${ARCHIVE_PATH}"
echo "SHA256:   ${SHA256}"
echo "Manifest: ${BUILD_DIR}/rubberband-manifest-${ARCH}.json"

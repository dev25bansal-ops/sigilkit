#!/usr/bin/env bash
# Single source of truth for the pinned, checksum-verified gitleaks install.
# Used by ci.yml (full-history secret scan) and publish.yml (release secret scan).
# When bumping the version, update the two constants below AND the checksum
# (published on the gitleaks GitHub release page), then re-run:
#   node scripts/validate-workflows.mjs
#
# SECURITY: the binary (~40MB) and its tarball are written to the runner scratch dir, not
# the working tree. Dropping them in the repo root left two large untracked files that
# nothing in .gitignore covered, i.e. one `git add -A` away from being committed.
#
# Contract: the absolute path of the extracted binary is the ONLY thing on stdout
# (all progress/diagnostics go to stderr), so callers can safely do:
#   echo "bin=$(bash scripts/install-gitleaks.sh)" >> "$GITHUB_OUTPUT"
set -euo pipefail

GITLEAKS_VERSION="v8.30.1"
GITLEAKS_SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"

# Download into the runner's scratch dir so the ~40MB binary and its tarball never land in
# the working tree. Falls back to the gitignored outputs/ dir for local runs.
OUT_DIR="${RUNNER_TEMP:-outputs}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

# The tarball name carries the version and the pid, matching install-actionlint.sh. Two installs
# into one OUT_DIR (a local run racing a matrix job, or two local runs) would otherwise share
# "gitleaks.tar.gz", so whichever finished first could `rm -f` the file the other was about to
# verify and extract.
TARBALL="gitleaks-${GITLEAKS_VERSION}-$$.tar.gz"
URL="https://github.com/gitleaks/gitleaks/releases/download/${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION#v}_linux_x64.tar.gz"

cd "$OUT_DIR"
echo "installing gitleaks ${GITLEAKS_VERSION} -> ${OUT_DIR}" >&2

curl -sSfL -o "$TARBALL" "$URL"

# Verify BEFORE extracting. A tar is an executable data format: extracting first would run
# whatever the archive contains before the integrity check ever got a chance to fire.
# `sha256sum -c` reports "OK" on STDOUT, which would corrupt the path-only stdout contract
# below, so its output is redirected to stderr.
echo "${GITLEAKS_SHA256}  ${TARBALL}" | sha256sum -c - >&2

# Extract only the binary. The archive also ships LICENSE and README.md, which have no
# business sitting in the runner scratch dir.
tar -xzf "$TARBALL" gitleaks
chmod +x gitleaks
rm -f "$TARBALL"

# Smoke test: proves the extracted file is a working binary, not just a matching hash.
./gitleaks version >&2

printf '%s\n' "$OUT_DIR/gitleaks"

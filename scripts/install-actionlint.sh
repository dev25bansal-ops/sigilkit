#!/usr/bin/env bash
# Single source of truth for the pinned, checksum-verified actionlint install.
# Used by ci.yml (workflow-lint job) to lint .github/workflows/*.yml.
#
# SECURITY (SEC-07): this replaces `bash <(curl -sSf .../main/scripts/download-actionlint.bash)`.
# That form piped an unpinned script straight from the upstream *default branch* into bash,
# so anyone who could push to rhysd/actionlint:main would get arbitrary code execution in
# every CI run of this repository — with the repo's token and secrets. This script pins both
# the version AND the artifact digest, so a swapped or tampered tarball aborts before `tar`
# ever runs (see the ordering note below), and nothing untrusted is ever piped to a shell.
#
# When bumping the version, update the two constants below AND the checksum
# (published in the release's actionlint_<version>_checksums.txt), then re-run:
#   node scripts/validate-workflows.mjs
#
# Contract: the absolute path of the extracted binary is the ONLY thing on stdout
# (all progress/diagnostics go to stderr), so callers can safely do:
#   echo "bin=$(bash scripts/install-actionlint.sh)" >> "$GITHUB_OUTPUT"
set -euo pipefail

ACTIONLINT_VERSION="v1.7.9"
ACTIONLINT_SHA256="233b280d05e100837f4af1433c7b40a5dcb306e3aa68fb4f17f8a7f45a7df7b4"

# Download into the runner's scratch dir so the ~5MB binary and its tarball never land in
# the working tree (a stray untracked 5MB blob in the repo root is how these get committed
# by accident). Falls back to the gitignored outputs/ dir for local runs.
OUT_DIR="${RUNNER_TEMP:-outputs}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

# The tarball name carries the version and the pid: two installs into one OUT_DIR (a
# local run racing a matrix job, or two local runs) used to share `actionlint.tar.gz`, so
# whichever finished first could `rm -f` the file the other was about to extract.
TARBALL="actionlint-${ACTIONLINT_VERSION}-$$.tar.gz"
URL="https://github.com/rhysd/actionlint/releases/download/${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION#v}_linux_amd64.tar.gz"

cd "$OUT_DIR"
echo "installing actionlint ${ACTIONLINT_VERSION} -> ${OUT_DIR}" >&2

curl -sSfL -o "$TARBALL" "$URL"

# Verify BEFORE extracting. A tar is an executable data format: extracting first would run
# whatever the archive contains before the integrity check ever got a chance to fire.
# `sha256sum -c` reports "OK" on STDOUT, which would corrupt the path-only stdout contract
# below, so its output is redirected to stderr.
echo "${ACTIONLINT_SHA256}  ${TARBALL}" | sha256sum -c - >&2

# Extract only the binary. The archive also ships LICENSE.txt, README.md, docs/ and a man
# page, which have no business sitting in the runner scratch dir.
tar -xzf "$TARBALL" actionlint
chmod +x actionlint
rm -f "$TARBALL"

# Smoke test: proves the extracted file is a working binary, not just a matching hash.
./actionlint -version >&2

printf '%s\n' "$OUT_DIR/actionlint"

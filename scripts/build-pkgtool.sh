#!/usr/bin/env bash
set -euo pipefail

readonly COMMIT="643477263b2644e0803e0f58b8726ea4e3f3b7d4"
readonly REPOSITORY="https://github.com/maxton/LibOrbisPkg.git"
readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SOURCE_DIR="${ROOT}/target/liborbispkg-src"
readonly OUTPUT_DIR="${ROOT}/target/pkgtool"

if ! command -v dotnet >/dev/null; then
  printf 'dotnet was not found; install .NET 8 or run this script with: nix develop "path:$PWD" -c scripts/build-pkgtool.sh\n' >&2
  exit 1
fi

if [[ ! -d "${SOURCE_DIR}/.git" ]]; then
  mkdir -p "$(dirname "${SOURCE_DIR}")"
  git init -q "${SOURCE_DIR}"
  git -C "${SOURCE_DIR}" remote add origin "${REPOSITORY}"
  git -C "${SOURCE_DIR}" fetch --depth 1 origin "${COMMIT}"
  git -C "${SOURCE_DIR}" checkout -q --detach FETCH_HEAD
fi

actual_commit="$(git -C "${SOURCE_DIR}" rev-parse HEAD)"
if [[ "${actual_commit}" != "${COMMIT}" ]]; then
  printf 'unexpected LibOrbisPkg checkout at %s; expected %s\n' "${actual_commit}" "${COMMIT}" >&2
  exit 1
fi

perl -pi -e 's#<TargetFramework>netcoreapp3\.0</TargetFramework>#<TargetFramework>net8.0</TargetFramework>#' \
  "${SOURCE_DIR}/LibOrbisPkg.Core/LibOrbisPkg.Core.csproj" \
  "${SOURCE_DIR}/PkgTool.Core/PkgTool.Core.csproj"

readonly LARGE_PKG_PATCH="${ROOT}/patches/liborbispkg-large-playgo.patch"
if git -C "${SOURCE_DIR}" apply --check "${LARGE_PKG_PATCH}"; then
  git -C "${SOURCE_DIR}" apply "${LARGE_PKG_PATCH}"
elif ! git -C "${SOURCE_DIR}" apply --reverse --check "${LARGE_PKG_PATCH}"; then
  printf 'LibOrbisPkg large-package patch does not apply cleanly\n' >&2
  exit 1
fi

system="$(uname -s)"
machine="$(uname -m)"
case "${system}:${machine}" in
  Darwin:arm64) runtime="osx-arm64" ;;
  Darwin:x86_64) runtime="osx-x64" ;;
  Linux:x86_64) runtime="linux-x64" ;;
  MINGW*:x86_64 | MSYS*:x86_64 | CYGWIN*:x86_64) runtime="win-x64" ;;
  *)
    printf 'unsupported platform: %s %s\n' "${system}" "${machine}" >&2
    exit 1
    ;;
esac

dotnet publish "${SOURCE_DIR}/PkgTool.Core/PkgTool.Core.csproj" \
  --configuration Release \
  --runtime "${runtime}" \
  --self-contained true \
  -p:PublishSingleFile=true \
  -p:DebugType=None \
  -p:DebugSymbols=false \
  --output "${OUTPUT_DIR}"

executable="${OUTPUT_DIR}/PkgTool.Core"
if [[ "${runtime}" == win-* ]]; then
  executable="${executable}.exe"
fi
printf 'Built native PkgTool: %s\n' "${executable}"

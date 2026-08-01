# mkps4

<p align="center">
  <img src="assets/mkps4-logo.png" alt="mkps4 logo" width="420">
</p>

## Introduction

`mkps4` is a cross-platform application that converts PS2 disc images into PS4
packages. It provides a native desktop app and a command-line interface without
requiring Wine or the Windows-only `orbis-pub-cmd.exe`.

> [!NOTE]
> mkps4 has been tested on the following systems:
>
> - macOS arm64
> - NixOS x86_64
>
> Windows support is implemented and should work in principle, but is currently
> unverified.

It supports one to seven ISO or single-file CUE/BIN images, custom package
identity and artwork, emulator compatibility settings, and Lua patches.

## Prerequisites

To create and use a package, you need:

- A PS2 game image that you are legally entitled to use
- A homebrew-enabled PS4 capable of installing custom PKGs
- An internet connection when downloading the emulator collection
- Enough disk space for the source image, temporary project, and final package

An 8 GB game image should generally have at least 10-18 GB of free space,
depending on where the source and output are stored.

## GUI

Download the appropriate archive or installer from the latest GitHub Release:

- macOS Apple Silicon: `mkps4-macos-apple-silicon.zip`
- Linux x86_64: `mkps4-linux-x86_64.AppImage`
- Windows x86_64: `mkps4-windows-x86_64-setup.exe`

The macOS build is ad-hoc signed but not Apple-notarized. After moving
`mkps4.app` to `/Applications`, remove the download quarantine once before
opening:

```sh
xattr -rc /Applications/mkps4.app
```

Make the Linux AppImage executable before launching it:

```sh
chmod +x mkps4-linux-x86_64.AppImage
```

The app guides the complete package workflow:

- Select one to seven ISO or CUE images.
- Choose an installed emulator runtime.
- Set the title, NP title, icon, and optional background artwork.
- Review or override the detected PS2 serial and related IDs.
- Configure rendering, upscaling, universal clamps, and CLUT merge.
- Add an optional emulator config and one or more Lua patches.
- Choose the output PKG and monitor build and validation progress.

Icons must use a 1:1 aspect ratio and are converted to 512x512. Backgrounds
must use a 16:9 aspect ratio and are converted to 1920x1080.

On first launch, the GUI can install the community runtime collection from
`kingkangyu/ps2-classics-emus`. Set `MKPS4_HOME` to use a custom storage
location.

Settings provides the installed version, last update time, emulator-folder
access, and an update/reinstall workflow.

## CLI

Prebuilt CLI archives are attached to each GitHub Release:

- macOS Apple Silicon: `mkps4-cli-macos-apple-silicon.zip`
- Linux x86_64: `mkps4-cli-linux-x86_64.tar.gz`
- Windows x86_64: `mkps4-cli-windows-x86_64.zip`

Build the CLI from the repository root:

```sh
cargo build --release -p mkps4
```

The executable is written to `target/release/mkps4`.

Install the emulator collection, or replace an existing installation:

```sh
cargo run -- setup
cargo run -- setup --force
```

Inspect a disc and print its detected identifiers:

```sh
cargo run -- inspect game.iso
```

Build a package:

```sh
cargo run --release -- build \
  --template "$HOME/.mkps4/emulators/jak-v2" \
  --title "Game Title" \
  --np-title GAME00001 \
  --icon ./icon.png \
  --background ./background.png \
  --rendering native \
  --upscale none \
  --universal-compatibility on \
  --clut-merge off \
  --output ./Game.pkg \
  game.iso
```

Compatibility options are optional. Omitted values preserve the selected
custom config or donor defaults:

- `--rendering native|2x2`
- `--upscale none|edge-smooth`
- `--universal-compatibility on|off`
- `--clut-merge on|off`

Detected disc identity can also be overridden. Supplying `--disc-serial`
derives the related IDs unless they are overridden independently:

- `--disc-serial SLES_523.25`
- `--disc-emulator-id SLES-52325`
- `--disc-title-id SLES52325`

Additional conversion inputs:

- `--content-id`: retain an existing package identity instead of deriving one
- `--config`: replacement `config-emu-ps4.txt`
- `--lua`: emulator Lua patch; may be supplied more than once
- `--background`: optional 16:9 home-screen background
- `--force`: replace an existing output PKG

Use `prepare` with the same conversion options to preserve the generated GP4
project without building a package:

```sh
cargo run -- prepare \
  --template /path/to/template \
  --title "Game Title" \
  --np-title GAME00001 \
  --icon ./icon.png \
  --output ./prepared \
  game.iso
```

Templates may be extracted payload directories or ZIP files containing a
top-level `PS2/` directory. The old `PS2.zip` from PS4 PS2 Classics GUI is not a
compatible runtime. Use a runtime extracted from a known-working package or the
collection installed by `setup`.

Environment variables:

- `MKPS4_HOME`: emulator-store directory
- `MKPS4_TEMPLATE`: default emulator template

Run `mkps4 --help` or `mkps4 <command> --help` for the complete argument list.

## Contributing

The repository is organized as a Cargo workspace with two front ends:

```text
crates/mkps4-core            disc inspection and package workflow
crates/mkps4-emulator-store  runtime download, metadata, and local storage
apps/mkps4-cli               command-line interface
apps/mkps4-gui               Tauri 2 and React desktop interface
```

The package pipeline:

1. Read the root-level `SYSTEM.CNF` and detect the PS2 serial.
2. Stage and validate the selected PS2 Classics emulator runtime.
3. Convert or hard-link up to seven ISO or CUE/BIN disc images.
4. Apply package identity, artwork, emulator settings, and Lua patches.
5. Generate a GP4 project and build it with the native package backend.
6. Validate and atomically move the completed PKG.

Supported inputs are ISO9660 images and single-file CUE/BIN images with
`MODE1/2048`, `MODE1/2352`, `MODE2/2336`, or `MODE2/2352` data tracks.
Multi-file CUE sheets are rejected.

When the input and output use the same filesystem, mkps4 hard-links ISO files
into its temporary project. Cross-filesystem inputs are copied instead, which
accounts for the higher disk-space requirement.

Runtime installation data lives under `~/.mkps4` by default. The
`config.json` file stores the installer version and RFC 3339 update time and is
written only after installation succeeds. It acts as the completion marker for
interrupted-install recovery.

Building from source requires Rust, Cargo, Node.js 20 or newer, pnpm 8, and the
platform-specific
[Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/). Building the
package backend additionally requires Nix, or .NET 8 with Git and Perl.

Install GUI dependencies:

```sh
pnpm --dir apps/mkps4-gui install --frozen-lockfile
```

Final package construction uses the open-source
[LibOrbisPkg](https://github.com/maxton/LibOrbisPkg) `PkgTool` as a native
process. The GUI bundles it; the CLI discovers it on `PATH`, at
`target/pkgtool/PkgTool.Core`, through `MKPS4_PKG_TOOL`, or with `--pkg-tool`.

Build the pinned backend with its large-package PlayGo fix:

```sh
nix develop "path:$PWD" -c scripts/build-pkgtool.sh
```

The script builds upstream commit
`643477263b2644e0803e0f58b8726ea4e3f3b7d4` as a self-contained .NET 8 binary
for the current operating system and architecture.

Run the desktop app against the repository's ignored `emulators/` directory:

```sh
MKPS4_HOME="$PWD" pnpm --dir apps/mkps4-gui tauri dev
```

Before submitting a change, run:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm --dir apps/mkps4-gui build
```

Build the native app for the current platform with:

```sh
pnpm --dir apps/mkps4-gui tauri build
```

Platform bundles are written below `target/release/bundle`. Maintainers can
publish GUI installers and self-contained CLI archives for macOS, Linux, and
Windows through the manually dispatched **Build release** GitHub Actions
workflow.

Keep reusable package behavior in `mkps4-core` and emulator installation logic
in `mkps4-emulator-store`. Do not commit emulator runtimes, game images,
generated packages, or backend build artifacts.

## Disclaimer

mkps4 is an independent open-source project and is not affiliated with or
endorsed by Sony Interactive Entertainment. PlayStation, PS2, and PS4 are
trademarks of their respective owners.

This repository does not include Sony emulator binaries, game images, or other
copyrighted console content. Only use software and game data that you are
legally permitted to use. Emulator runtimes downloaded from third-party sources
remain subject to their own licensing and distribution terms.

Package validation checks structure, hashes, and signatures, but it cannot
guarantee that a package will install or launch correctly on PS4 hardware.
Runtime compatibility varies by game and donor, and a known-working runtime
does not guarantee compatibility with every PS2 title.

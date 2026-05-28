# Catwalk

An open-source, cross-platform model organizer for 3D printer files. Built with Tauri 2, SvelteKit, Svelte 5, Threlte, and Rust.

> **Status:** Early development. Foundations only — library scan, viewer, and tagging are next.

## Goals

- **Beautiful viewer.** First-class 3D inspection of STL, OBJ, and 3MF files with orbit, pan, zoom, wireframe, and measure tools.
- **Smart organization.** Manual tags plus auto-tags inferred from slicer metadata, filenames, and (later) image embeddings.
- **Non-destructive.** Catwalk indexes your existing folders. It never moves or modifies your files.
- **Cross-platform.** macOS, Linux, Windows. No Electron.

## Supported formats (v1)

| Format | Read | Metadata | Thumbnail |
| --- | --- | --- | --- |
| STL  | yes | — | rendered |
| OBJ  | yes | — | rendered |
| 3MF  | yes | Bambu / Orca / Prusa / Cura | embedded preferred |
| G-code | preview only | embedded settings | embedded preferred |
| STEP / STP | deferred | — | — |

## Development

Prerequisites: Rust (stable), Node.js 20+, pnpm.

```sh
pnpm install
pnpm tauri dev
```

> On Linux, the `tauri` script sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` and
> `WEBKIT_DISABLE_COMPOSITING_MODE=1` to work around a WebKitGTK + GBM
> rendering crash that occurs on many distros. These are no-ops on macOS
> and Windows.

## License

[AGPL-3.0-or-later](./LICENSE). If you run a modified version of Catwalk as a network service, you must offer the source to its users.

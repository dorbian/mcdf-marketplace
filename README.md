# MCDF Marketplace

Local-first desktop marketplace tooling for MCDF character archives.

This repository contains a Tauri v2 desktop app with a React frontend and Rust backend. The current implementation focuses on the portable file/archive layer that the marketplace needs before the optional server pieces are added.

## Current features

- Inspect local `.mcdf` files.
- Parse raw or gzip-compressed MCDF files.
- Show MCDF metadata and file layout without sending raw file bytes into the webview.
- Extract MCDF internals before manifest creation.
- Create a local vault manifest from an MCDF that includes the individual internal files/components.
- Split MCDF files into BLAKE3-addressed chunks.
- Store chunks in a local cache under `~/.mcdf-marketplace`.
- Show internal file/component online status from manifest/cache information.
- Rebuild an MCDF from a manifest through an action instead of a dedicated menu page.
- Rebuild fully offline when chunks already exist locally.
- Download missing chunks directly from manifest `attachment_url` values when available.

## Why downloads work without a server

A complete manifest is enough to rebuild an MCDF. The app checks the local chunk cache first. If a chunk is missing and the manifest contains a direct `attachment_url`, the app downloads that chunk directly, verifies its BLAKE3 hash and size, and then rebuilds the final MCDF.

The optional server is only needed for search, Discord auth, upload coordination, moderation, and stable index hosting. See `docs/API_ENDPOINTS.adoc`.

## Development

```bash
pnpm install
pnpm tauri dev
```

## Build

```bash
pnpm install
pnpm tauri build
```

GitHub release builds are handled by `.github/workflows/release.yml`.

## Local cache

Default cache path:

```text
~/.mcdf-marketplace
```

Override it for testing:

```bash
MCDF_MARKETPLACE_HOME=/tmp/mcdf-marketplace pnpm tauri dev
```

## Repository hygiene

Do not commit generated build or dependency directories:

- `node_modules/`
- `dist/`
- `src-tauri/target/`



## Online library locations

The app supports external discovery locations that are not used as chunk storage. This is intended for places such as public Google Drive folders or simple JSON indexes where creators already host a finished `.mcdf` and a preview image.

Required naming convention:

```text
My Character.mcdf
My Character.png
```

The base filename must match. Supported image extensions are `.png`, `.jpg`, `.jpeg`, and `.webp`.

Supported source types:

- `Generic JSON index`: an HTTP JSON document containing `files[]`, `entries[]`, or a top-level array. Each item should contain `name` and `url` or `download_url`.
- `Google Drive folder`: a public folder URL or folder ID. Serverless scanning uses the Google Drive files API and therefore requires a Drive API key in the app or `GOOGLE_DRIVE_API_KEY` while testing.

Online library entries can be prepared for the central system by downloading the MCDF locally, creating a vault manifest, chunking it into the local BLAKE3 cache, and recording the original MCDF URL plus thumbnail URL in the manifest source metadata.


## MCDF internals and online status

An MCDF is treated as a compiled package. Before the app prepares an upload or central-ingestion manifest, it parses the MCDF and records each internal file/component with:

- game paths
- original MCDF/Mare file hash when available
- payload offset
- payload length
- BLAKE3 payload hash
- central status placeholder

The manifest still chunks the compiled MCDF as a transport artifact. The internal component list lets the optional central service check which real contained files are already present, missing, queued, or only available through an external online package.

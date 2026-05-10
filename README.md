# MCDF Marketplace

A desktop marketplace for browsing, uploading, and downloading FFXIV character files (MCDF).

## Features
- Browse public character archives
- Upload MCDF files to the vault
- Download and rebuild MCDF files
- Set consent flags for your characters
- Search and filter by race, gender, tags

## Development

### Prerequisites
- Node.js 20+
- Rust 1.75+
- pnpm

### Setup
```bash
pnpm install
cargo tauri dev
```

### Architecture
- Frontend: React + TypeScript + TailwindCSS
- Backend: Rust (Tauri)
- MCDF parsing: custom Rust implementation
- Auth: Discord OAuth

## Tech Stack
- Tauri 2.x
- React 18
- TypeScript 5
- TailwindCSS 3
- React Query
- Discord OAuth 2
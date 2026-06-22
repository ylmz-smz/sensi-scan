# Repository Guidelines

## Project Structure & Module Organization

This repository is an Electron desktop application built with React and TypeScript.

- `src/main/` contains Electron main-process code, including scanning, provider integration, installation, and persisted decisions.
- `src/preload/` exposes the narrow renderer API through Electron's preload bridge.
- `src/renderer/` contains the React UI and global styles.
- `tests/` contains focused tests for scanner and installer behavior.
- `resources/` holds packaging assets. `out/` and `release/` are generated and must not be committed.

Keep process-specific code in its existing layer. Shared data contracts belong in `src/main/types.ts`; do not bypass the preload boundary from renderer code.

## Build, Test, and Development Commands

Use Node.js 20+ and pnpm:

- `pnpm install` installs locked dependencies.
- `pnpm dev` starts Electron through electron-vite with live reload.
- `pnpm typecheck` runs strict TypeScript checks without emitting files.
- `pnpm test` runs all `tests/*.test.ts` files.
- `pnpm build` creates production output in `out/`.
- `pnpm package` builds platform installers in `release/`; package on the target operating system.

Run `pnpm typecheck`, `pnpm test`, and `pnpm build` before submitting changes.

## Coding Style & Naming Conventions

Follow the existing TypeScript style: two-space indentation, single quotes, no semicolons, and trailing commas in multiline structures. Use `camelCase` for functions and variables, `PascalCase` for React components and types, and `UPPER_SNAKE_CASE` for module constants. Keep functions small, data flow direct, and Electron IPC access explicit. No formatter or linter is configured, so avoid unrelated formatting changes.

## Testing Guidelines

Tests use `node:test` with `node:assert/strict`. Name files `*.test.ts` and describe observable behavior, preferably in Chinese to match the current suite. Add one focused regression test for non-trivial scanner, provider, persistence, or IPC changes. Use temporary directories; never depend on a developer's local repository or credentials.

## Commit & Pull Request Guidelines

The repository has no commit history yet. Use short, imperative commit subjects such as `Fix route detection for React pages`. Keep each commit scoped to one behavior. Pull requests should explain the user-visible change, list verification commands, and note compatibility or security impact. Include screenshots for renderer changes and link the relevant issue when one exists.

## Security & Configuration

Never commit API keys, scan results, local paths, or user code. Preserve the read-only scanning model, HTTPS requirement for remote model endpoints, and the renderer/preload/main trust boundary.

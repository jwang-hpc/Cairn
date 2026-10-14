# Cairn desktop app

A thin Electron + React client over the engine's local API (DR-0002). Everything it does is also possible with `re`.

## Run (from the repository root, in your own terminal)

```sh
corepack pnpm install          # first time: also downloads the Electron binary
corepack pnpm run build        # engine + app main process
corepack pnpm --filter @cairn/desktop dev
```

`dev` serves the UI with hot reload, rebuilds the main process on change, and restarts Electron. The app uses a running
`re serve` if there is one (`<engine home>/api.json`), or starts one and stops it when you quit.

For a production-style run: `corepack pnpm --filter @cairn/desktop build && corepack pnpm --filter @cairn/desktop start`.

## Layout

- `src/main/`: main process: window, security settings, the engine connection (holds the API token).
- `src/preload/`: exposes `window.cairn` (requests, connection state, events); CommonJS, as sandboxed preloads require.
- `src/renderer/`: React UI. It never sees the token; it asks the main process.
- `src/shared/bridge.ts`: the types of that bridge.

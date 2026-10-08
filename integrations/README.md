# Integrations

An integration adds support for one pi extension beyond pi's RPC protocol. The core (`src/`, `webview/`) has no code for a specific pi extension. It calls the hooks of the integrations listed here.

## Layout

- `host.ts`: the host sides of the integrations in this build.
- `web.ts`: the webview sides of the integrations in this build.
- `<name>/`: one integration. Usually `profile.ts` (plain data that both sides use), `host.ts`, `web.ts` and `styles.css`.

To build without an integration, remove it from `host.ts` and `web.ts`.

## Write an integration

1. Make `integrations/<name>/host.ts`. Export a `HostIntegration` (see `src/integrations.ts`):
   - `id`: the same on both sides.
   - `matches(commands)`: true when the session loads the pi extension. Use the commands from `get_commands`.
   - `entryTypes`: `customType`s of session entries that the webview side needs in each snapshot.
   - `create(api)`: the hooks for one chat. `api.prompt()` runs a command in pi, `api.post()` sends to the webview side, `api.setBadge()` sets the badge of the Pi view.
2. Make `integrations/<name>/web.ts`. Export a `WebIntegration` (see `webview/integrations.ts`). Its hooks get snapshots, appended entries, custom messages, notices and slash commands. `api.addToolbarButton()` adds a button to the header row, or to the composer toolbar in editor tabs.
3. Add both to `integrations/host.ts` and `integrations/web.ts`.
4. Import styles as text (`import css from "./styles.css"`) and add them to the page in `create()`. Use the theme tokens of `webview/styles.css`.

The two sides talk with `{ type: "ext", id, payload }`. The payload is free-form.

## Rules

- Code in `integrations/` can import from the core. The core imports only `integrations/host.ts` and `integrations/web.ts`.
- An integration is active only while `matches()` is true. Its webview hooks are not called otherwise, and `onActiveChange(false)` tells it to hide its UI.
- Do not send large data to the webview. Ask only for the entry types that you need.

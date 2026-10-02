# Workarounds

A workaround fills a gap in pi's RPC mode that affects every extension. It is not about one pi extension (that is an [integration](../integrations/README.md)), and it is not part of the core: remove it when pi fixes the gap.

## Layout

- `host.ts`, `web.ts`: the workarounds in this build. To build without one, remove it from both.
- `<name>/`: one workaround. It has a `pi.ts` (a pi extension that the controller loads with `-e`), usually a `host.ts`, sometimes a `web.ts` and `styles.css`, and a README.

## Rules

- A workaround uses the same hooks as an integration (`src/integrations.ts`, `webview/integrations.ts`) and leaves out `matches`: it is always active.
- The `pi.workarounds` setting turns one off (`{ "<name>": false }`). Then its pi extension is not loaded, and the core works without it. Check that when you add one.
- Its README says which gap it fills, how, and when to remove it. Say so if it uses pi internals (anything that is not pi's extension API).
- Keep `pi.ts` free of dependencies, like `src/bridge/piBridge.ts`.
- Hidden status keys and commands start with `vscode:`. The webview hides `vscode:*` commands.

## Workarounds

| Name | Gap | Uses pi internals |
|---|---|---|
| [factory-widgets](factory-widgets/README.md) | RPC mode drops factory widgets. | No |
| [child-runs](child-runs/README.md) | RPC events miss agent sessions that extensions run in the process. | Yes |

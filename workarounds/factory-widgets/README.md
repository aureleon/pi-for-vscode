# factory-widgets

**Gap:** RPC mode forwards only `string[]` widgets. It drops factory widgets (`ctx.ui.setWidget(key, (tui, theme) => component)`), which extensions such as todo lists and agent bars use.

**Workaround:** `pi.ts` wraps the UI context's `setWidget`. It renders factory widgets to text lines at the width of the chat view and sends them as `string[]` widgets again when they change (at most 4 times a second, at most 25 lines).

**Remove when:** pi's RPC mode renders factory widgets itself.

## Files

- `pi.ts`: the widget host and the hidden `/vscode:widget-columns` command.
- `host.ts`: gives a new pi process the width (`PI_VSCODE_WIDGET_COLUMNS`) and tells a running one when the view is resized.
- `web.ts`: reports the width from the core's widget geometry.

## Notes

- The stub TUI has only `requestRender()` and `terminal.columns/rows`. Widgets that need more fail to render and are not shown.
- Widgets are read-only: keys that a widget reads with `onTerminalInput` do nothing.

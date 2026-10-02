import type { WebIntegration } from "../../webview/integrations";

/** Webview side of the factory-widgets workaround: reports how many characters fit in a widget box. */
export const factoryWidgetsWeb: WebIntegration = {
  id: "factory-widgets",
  create(api) {
    api.onWidgetColumns((columns) => api.post({ op: "columns", columns }));
    return {};
  },
};

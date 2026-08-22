import { createBrowserApi } from "./browserApi.js";
import { createController } from "./controller.js";

const DASHBOARD_PATH = "src/dashboard/dashboard.html";

if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.id === "string") {
  const api = createBrowserApi(chrome);
  const controller = createController(api);
  controller.registerAll();

  api.commandsOnCommand((command) => {
    if (command !== "open-dashboard") return Promise.resolve();
    const dashboardUrl = api.runtimeGetURL(DASHBOARD_PATH);
    return api
      .getTabs({})
      .then((tabs) => {
        const existing = tabs.find((t) => typeof t.url === "string" && t.url.startsWith(dashboardUrl));
        if (existing) return api.tabSetActive(existing.id);
        return api.tabsCreate({ url: dashboardUrl, active: true });
      })
      .catch(() => {});
  });

  api.omniboxOnInputChanged((text, addSuggestions) => {
    void controller.handleOmniboxSuggestions(text, addSuggestions).catch(() => {});
  });

  api.omniboxOnInputEntered((text, disposition) => {
    void controller.handleOmniboxEntered(text, disposition).catch(() => {});
  });
}

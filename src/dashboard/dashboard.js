import { MSG } from "../lib/schema.js";
import { message, applyThemeSetting, announce, debounce } from "../shared/uiCommon.js";
import { createStore, initFromStorage } from "./state.js";
import {
  visibleRecords,
  renderHeaderBadge,
  renderSidebar,
  renderList,
  renderBulkToolbar,
  renderBanners,
  renderOnboarding,
  wireListKeyboard,
  toggleSettingsPanel,
  focusSessionName
} from "./render.js";
import { createActions } from "./actions.js";

function concreteTheme(theme) {
  if (theme === "system") {
    try {
      return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch {
      return "light";
    }
  }
  return theme === "dark" || theme === "high-contrast" ? theme : "light";
}

function writeMirror(theme) {
  try {
    localStorage.setItem("tabsurvey.themeMirror", concreteTheme(theme));
  } catch {}
}

function sessionFlag(key, value) {
  try {
    if (value === undefined) return sessionStorage.getItem(key) === "1";
    sessionStorage.setItem(key, value);
  } catch {}
  return value !== undefined;
}

function boot() {
  const $ = (id) => document.getElementById(id);
  const refs = {
    count: $("tab-count"),
    search: $("search-input"),
    sortSelect: $("sort-select"),
    extractBtn: $("extract-btn"),
    groupBtn: $("group-menu-button"),
    groupMenu: $("group-menu"),
    closeDupsBtn: $("close-dups-btn"),
    saveSessionFocusBtn: $("save-session-focus"),
    exportMdBtn: $("export-md-btn"),
    importBtn: $("import-sessions-btn"),
    exportSessionsBtn: $("export-sessions-btn"),
    settingsToggle: $("settings-toggle"),
    helpBtn: $("help-btn"),
    sidebarToggle: $("sidebar-toggle"),
    sidebar: $("sidebar"),
    main: $("main"),
    bannerRegion: $("banner-region"),
    onboardingRegion: $("onboarding-region"),
    bulkRegion: $("bulk-region"),
    list: $("tab-list"),
    emptyNote: $("empty-note"),
    toastRegion: $("toast-region"),
    helpOverlay: $("help-overlay"),
    helpClose: $("help-close"),
    importJsonInput: $("import-sessions-json"),
    importTextInput: $("import-sessions-text")
  };

  const store = createStore();
  const server = initFromStorage(store);

  let themeCleanup = null;
  function setTheme(theme) {
    writeMirror(theme);
    if (typeof applyThemeSetting === "function") {
      try {
        if (typeof themeCleanup === "function") themeCleanup();
      } catch {}
      try {
        themeCleanup = applyThemeSetting(theme) || null;
      } catch {
        themeCleanup = null;
      }
    }
    try {
      document.documentElement.setAttribute("data-theme", concreteTheme(theme));
    } catch {}
  }

  function toast(text, kind, ms) {
    const node = document.createElement("div");
    node.className = kind ? `toast toast--${kind}` : "toast";
    node.setAttribute("role", kind === "error" ? "alert" : "status");
    node.dir = "auto";
    node.textContent = text;
    refs.toastRegion.appendChild(node);
    while (refs.toastRegion.children.length > 3) refs.toastRegion.firstElementChild.remove();
    setTimeout(() => node.remove(), typeof ms === "number" ? ms : 4000);
  }

  let undoNode = null;
  let undoInterval = null;
  function hideUndo() {
    if (undoInterval != null) {
      clearInterval(undoInterval);
      undoInterval = null;
    }
    if (undoNode) {
      undoNode.remove();
      undoNode = null;
    }
  }
  function showUndoToast({ batchId, count, deadlineAt }) {
    hideUndo();
    const box = document.createElement("div");
    box.className = "toast";
    const label = document.createElement("span");
    label.dir = "auto";
    label.textContent = `Closing ${count} tab${count === 1 ? "" : "s"}`;
    const countdown = document.createElement("span");
    countdown.className = "undo-countdown";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn--ghost btn--small";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", async () => {
      hideUndo();
      try {
        await message(MSG.CANCEL_CLOSE, { batchId });
      } catch {}
    });
    box.appendChild(label);
    box.appendChild(countdown);
    box.appendChild(cancel);
    refs.toastRegion.appendChild(box);
    undoNode = box;
    const tick = () => {
      const secs = Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000));
      countdown.textContent = `${secs}s`;
      if (secs <= 0) hideUndo();
    };
    tick();
    undoInterval = setInterval(tick, 1000);
  }

  const actions = createActions({ toast, showUndoToast });

  function mutateFilters(fn) {
    const current = store.get();
    store.patch({ filters: fn({ ...current.filters }) });
  }

  function selectedIds() {
    return Array.from(store.get().selection);
  }

  function syncRowCheck(id) {
    const row = refs.list.querySelector(`li[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    const check = row.querySelector("input.row__check");
    if (check) check.checked = store.get().selection.has(id);
  }

  function clearSelection() {
    const selection = store.get().selection;
    if (selection.size === 0) {
      renderBulkToolbar(refs.bulkRegion, store.get(), handlers);
      return;
    }
    selection.clear();
    for (const check of refs.list.querySelectorAll("input.row__check")) check.checked = false;
    renderBulkToolbar(refs.bulkRegion, store.get(), handlers);
    announce("Selection cleared");
  }

  async function enableHost() {
    try {
      if (typeof chrome !== "undefined" && chrome.permissions && chrome.permissions.request) {
        await chrome.permissions.request({ origins: ["http://*/*", "https://*/*"] });
      }
      await message(MSG.SET_SETTINGS, { patch: { hostPermissionAvailable: true } });
      await message(MSG.REQUEST_EXTRACT_ALL);
    } catch {}
    server.refresh();
  }

  async function removeHost() {
    try {
      if (typeof chrome !== "undefined" && chrome.permissions && chrome.permissions.remove) {
        await chrome.permissions.remove({ origins: ["http://*/*", "https://*/*"] });
      }
    } catch {}
    server.refresh();
  }

  const handlers = {
    toggleCategory(label, on) {
      mutateFilters((f) => {
        if (on) f.categories.add(label);
        else f.categories.delete(label);
        return f;
      });
    },
    toggleState(name, on) {
      mutateFilters((f) => {
        if (on) f.states.add(name);
        else f.states.delete(name);
        return f;
      });
    },
    toggleWindow(winId, on) {
      mutateFilters((f) => {
        if (on) f.windowIds.add(winId);
        else f.windowIds.delete(winId);
        return f;
      });
    },
    toggleSelected(id) {
      const state = store.get();
      if (state.selection.has(id)) state.selection.delete(id);
      else state.selection.add(id);
      syncRowCheck(id);
      renderBulkToolbar(refs.bulkRegion, state, handlers);
      announce(state.selection.has(id) ? "Selected" : "Deselected");
    },
    clearSelection,
    onFocusTab(id) {
      message(MSG.FOCUS_TAB, { tabId: id }).catch(() => {});
    },
    closeSelected() {
      actions.closeWithUndo(selectedIds());
    },
    discardSelected() {
      actions.discardSelected(selectedIds());
    },
    groupSelected(by) {
      actions.groupSelected(by, selectedIds());
    },
    saveSession(name, closeAfter) {
      const state = store.get();
      const ids =
        state.selection.size > 0
          ? Array.from(state.selection)
          : visibleRecords(state).map((r) => String(r.id));
      actions.saveSessionFlow({ name, tabIds: ids, closeAfter });
    },
    restoreSession(id) {
      actions.restoreSession(id);
    },
    deleteSession(id) {
      actions.deleteSession(id);
    },
    setTheme(value) {
      setTheme(value);
      message(MSG.SET_SETTINGS, { patch: { theme: value } }).catch(() => {});
    },
    setSummaryLength(value) {
      message(MSG.SET_SETTINGS, { patch: { summaryLength: value } }).catch(() => {});
    },
    setUndoSeconds(value) {
      message(MSG.SET_SETTINGS, { patch: { undoSeconds: value } }).catch(() => {});
    },
    addExcludedDomain(domain) {
      if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
        toast("Enter a domain like example.com", "error");
        return;
      }
      message(MSG.SET_EXCLUDED_DOMAIN, { domain, enabled: true })
        .then(() => server.refresh())
        .catch(() => {});
    },
    removeExcludedDomain(domain) {
      message(MSG.SET_EXCLUDED_DOMAIN, { domain, enabled: false })
        .then(() => server.refresh())
        .catch(() => {});
    },
    enableHost() {
      void enableHost();
    },
    removeHost() {
      void removeHost();
    },
    onboardDismiss() {
      message(MSG.SET_SETTINGS, { patch: { onboardedAt: Date.now() } }).catch(() => {});
    },
    dismissBanner(kind) {
      sessionFlag(`tabsurvey.${kind}.dismissed`, "1");
      renderAll();
    }
  };

  const listCtx = {
    getURL(path) {
      try {
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
          return chrome.runtime.getURL(path);
        }
      } catch {}
      return path;
    },
    get selection() {
      return store.get().selection;
    }
  };

  wireListKeyboard(refs.list, {
    onFocusTab: handlers.onFocusTab,
    toggleSelected: handlers.toggleSelected,
    clearSelection
  });

  let rafPending = false;
  store.subscribe(() => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      renderAll();
    });
  });

  function renderEmptyNote(records, state) {
    const note = refs.emptyNote;
    while (note.firstChild) note.removeChild(note.firstChild);
    if (records.length > 0) {
      note.hidden = true;
      return;
    }
    note.hidden = false;
    const query = String(state.filters.query || "").trim();
    const hasFilters =
      query.length > 0 ||
      state.filters.categories.size > 0 ||
      state.filters.states.size > 0 ||
      state.filters.windowIds.size > 0;
    if (query.length > 0) {
      note.textContent = `No results for “${query}”.`;
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "btn btn--ghost btn--small";
      reset.textContent = "Reset filters";
      reset.addEventListener("click", resetFilters);
      note.appendChild(document.createTextNode(" "));
      note.appendChild(reset);
    } else if (hasFilters) {
      note.textContent = "No open tabs match.";
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "btn btn--ghost btn--small";
      reset.textContent = "Reset filters";
      reset.addEventListener("click", resetFilters);
      note.appendChild(document.createTextNode(" "));
      note.appendChild(reset);
    } else {
      note.textContent = "No open tabs match. Open a few tabs and they will appear here.";
    }
  }

  function resetFilters() {
    const current = store.get();
    current.filters.categories.clear();
    current.filters.states.clear();
    current.filters.windowIds.clear();
    store.patch({
      filters: { ...current.filters, query: "", categories: current.filters.categories, states: current.filters.states, windowIds: current.filters.windowIds },
      selection: new Set()
    });
    refs.search.value = "";
  }

  function renderAll() {
    const state = store.get();
    renderHeaderBadge(refs.count, state);
    if (refs.sortSelect.value !== state.filters.sort) refs.sortSelect.value = state.filters.sort;
    renderBanners(
      refs.bannerRegion,
      state,
      (kind) => sessionFlag(`tabsurvey.${kind}.dismissed`),
      handlers
    );
    renderOnboarding(refs.onboardingRegion, state, handlers);
    renderBulkToolbar(refs.bulkRegion, state, handlers);
    renderSidebar(refs.sidebar, state, handlers);
    const records = renderList(refs.list, state, listCtxWithHost(state));
    renderEmptyNote(records, state);
  }

  function listCtxWithHost(state) {
    return {
      getURL: listCtx.getURL,
      selection: state.selection,
      hostGranted: Boolean(state.hostGranted),
      onToggleSelect: handlers.toggleSelected,
      onFocusTab: handlers.onFocusTab
    };
  }

  function closeGroupMenu() {
    refs.groupMenu.hidden = true;
    refs.groupBtn.setAttribute("aria-expanded", "false");
  }

  function openHelp() {
    refs.helpOverlay.hidden = false;
    refs.helpClose.focus();
  }
  function closeHelp() {
    refs.helpOverlay.hidden = true;
    refs.helpBtn.focus();
  }

  function importFromFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      void actions.importSessions(String(reader.result || ""));
    };
    reader.onerror = () => toast("Could not read file", "error");
    reader.readAsText(file);
  }

  refs.search.addEventListener(
    "input",
    debounce(() => {
      mutateFilters((f) => ({ ...f, query: refs.search.value }));
    }, 80)
  );

  refs.sortSelect.addEventListener("change", () => {
    mutateFilters((f) => ({ ...f, sort: refs.sortSelect.value }));
  });

  refs.extractBtn.addEventListener("click", async () => {
    store.patch({ busy: true });
    let res = null;
    try {
      res = await message(MSG.REQUEST_EXTRACT_ALL);
    } catch {}
    store.patch({ busy: false });
    const queued = res && Number.isFinite(res.queued) ? res.queued : 0;
    toast(`Queued ${queued} page${queued === 1 ? "" : "s"} for reading`);
  });

  refs.groupBtn.addEventListener("click", () => {
    refs.groupMenu.hidden = !refs.groupMenu.hidden;
    refs.groupBtn.setAttribute("aria-expanded", refs.groupMenu.hidden ? "false" : "true");
  });
  for (const item of refs.groupMenu.querySelectorAll(".js-group-by")) {
    item.addEventListener("click", () => {
      closeGroupMenu();
      actions.groupSelected(item.dataset.by, selectedIds());
    });
  }
  document.addEventListener("click", (e) => {
    if (!refs.groupMenu.hidden && !e.target.closest(".menu-wrap")) closeGroupMenu();
  });

  refs.closeDupsBtn.addEventListener("click", () => {
    const dupIds = Object.values(store.get().tabs || {})
      .filter((r) => r && r.duplicateOf != null)
      .map((r) => String(r.id));
    if (dupIds.length === 0) {
      toast("No duplicates found");
      return;
    }
    void actions.closeWithUndo(dupIds);
  });

  refs.saveSessionFocusBtn.addEventListener("click", () => {
    if (window.matchMedia("(max-width: 719px)").matches) refs.sidebar.hidden = false;
    focusSessionName(refs.sidebar);
  });

  refs.exportMdBtn.addEventListener("click", () => {
    actions.exportInventory(visibleRecords(store.get()));
  });

  refs.exportSessionsBtn.addEventListener("click", () => {
    actions.exportSessions(store.get().sessions);
  });

  refs.importBtn.addEventListener("click", () => {
    refs.importJsonInput.click();
  });
  refs.importJsonInput.addEventListener("change", () => {
    importFromFile(refs.importJsonInput.files && refs.importJsonInput.files[0]);
    refs.importJsonInput.value = "";
  });
  refs.importTextInput.addEventListener("change", () => {
    importFromFile(refs.importTextInput.files && refs.importTextInput.files[0]);
    refs.importTextInput.value = "";
  });

  refs.settingsToggle.addEventListener("click", () => {
    const opened = toggleSettingsPanel(refs.sidebar);
    refs.settingsToggle.setAttribute("aria-expanded", opened ? "true" : "false");
  });

  refs.sidebarToggle.addEventListener("click", () => {
    refs.sidebar.hidden = !refs.sidebar.hidden;
    refs.sidebarToggle.setAttribute("aria-expanded", refs.sidebar.hidden ? "false" : "true");
  });

  refs.helpBtn.addEventListener("click", openHelp);
  refs.helpClose.addEventListener("click", closeHelp);
  refs.helpOverlay.addEventListener("click", (e) => {
    if (e.target === refs.helpOverlay) refs.helpOverlay.hidden = true;
  });

  document.addEventListener("keydown", (e) => {
    const tag = e.target && e.target.tagName ? e.target.tagName.toUpperCase() : "";
    const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    if (e.key === "/" && !typing) {
      e.preventDefault();
      refs.search.focus();
      refs.search.select();
      return;
    }
    if ((e.key === "?" || (e.shiftKey && e.key === "/")) && !typing) {
      e.preventDefault();
      if (refs.helpOverlay.hidden) openHelp();
      else refs.helpOverlay.hidden = true;
      return;
    }
    if (e.key === "d" && !typing) {
      const has = store.get().filters.states.has("duplicates");
      handlers.toggleState("duplicates", !has);
      announce(has ? "Duplicates filter off" : "Duplicates filter on");
      return;
    }
    if (e.key === "Escape") {
      if (!refs.helpOverlay.hidden) {
        refs.helpOverlay.hidden = true;
        return;
      }
      if (!refs.groupMenu.hidden) {
        closeGroupMenu();
        return;
      }
      clearSelection();
    }
  });

  try {
    if (window.matchMedia("(max-width: 719px)").matches) refs.sidebar.hidden = true;
  } catch {}

  const params = new URLSearchParams(location.search);
  const prefill = params.get("q");
  if (prefill) {
    refs.search.value = prefill;
    mutateFilters((f) => ({ ...f, query: prefill }));
  }

  const initial = store.get();
  setTheme(initial.settings.theme);
  renderAll();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
}

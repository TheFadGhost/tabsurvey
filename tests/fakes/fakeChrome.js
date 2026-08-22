export class FakeEvent {
  constructor() {
    this.listeners = [];
  }
  addListener(cb) {
    if (typeof cb === "function") this.listeners.push(cb);
  }
  removeListener(cb) {
    const i = this.listeners.indexOf(cb);
    if (i >= 0) this.listeners.splice(i, 1);
  }
  hasListener(cb) {
    return this.listeners.includes(cb);
  }
  fire(...args) {
    for (const cb of [...this.listeners]) cb(...args);
  }
  clear() {
    this.listeners.length = 0;
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function makeManualTimers() {
  let virtual = 0;
  let seqCounter = 0;
  const jobs = new Map();
  return {
    get now() {
      return virtual;
    },
    setTimeout(fn, ms = 0) {
      const id = ++seqCounter;
      jobs.set(id, { fn, at: virtual + Math.max(0, Number(ms) || 0), id });
      return id;
    },
    clearTimeout(id) {
      jobs.delete(id);
    },
    pending() {
      return jobs.size;
    },
    advance(ms) {
      const target = virtual + Math.max(0, Number(ms) || 0);
      virtual = target;
      const due = [...jobs.values()].filter((j) => j.at <= target).sort((a, b) => a.at - b.at || a.id - b.id);
      for (const job of due) {
        if (!jobs.has(job.id)) continue;
        jobs.delete(job.id);
        job.fn();
      }
    }
  };
}

export function makeFakeChrome(opts = {}) {
  const state = {
    hostGranted: opts.hostGranted !== false,
    quotaFailFirst: Number(opts.quotaFailFirst) || 0,
    injectFailIds: Array.isArray(opts.injectFailIds) ? [...opts.injectFailIds] : []
  };
  const contentResponders = opts.contentResponders || {};
  if (opts.contentResponders === undefined) opts.contentResponders = contentResponders;
  const callLog =
    opts.callLog ||
    (opts.callLog = {
      tabsUpdate: [],
      tabsCreate: [],
      tabsGroup: [],
      tabsRemove: [],
      tabsDiscard: [],
      windowsUpdate: [],
      tabGroupsUpdate: [],
      executeScript: [],
      sendMessage: []
    });

  let nextTabId = 1;
  let nextGroupId = 1;
  const tabsMap = new Map();
  const groupMeta = {};
  const windowsStore = {};
  const alarmsMap = new Map();

  const evCreated = new FakeEvent();
  const evUpdated = new FakeEvent();
  const evRemoved = new FakeEvent();
  const evReplaced = new FakeEvent();
  const evActivated = new FakeEvent();
  const evAlarm = new FakeEvent();

  function makeTab(o = {}) {
    const windowId = Number.isInteger(o.windowId) ? o.windowId : 1;
    const index = Number.isInteger(o.index)
      ? o.index
      : [...tabsMap.values()].filter((t) => t.windowId === windowId).length;
    return {
      id: o.id != null ? o.id : nextTabId++,
      url: typeof o.url === "string" ? o.url : "https://example.com/",
      title: typeof o.title === "string" ? o.title : "Example",
      favIconUrl: typeof o.favIconUrl === "string" ? o.favIconUrl : "",
      windowId,
      groupId: Number.isInteger(o.groupId) ? o.groupId : -1,
      index,
      pinned: Boolean(o.pinned),
      audible: Boolean(o.audible),
      discarded: Boolean(o.discarded),
      status: o.status || "complete",
      lastAccessed: Number.isFinite(o.lastAccessed) ? o.lastAccessed : Date.now()
    };
  }

  function seed(input) {
    const isArray = Array.isArray(input);
    const list = isArray ? input : [input];
    const ids = [];
    for (const item of list) {
      const overrides = typeof item === "string" ? { url: item } : item || {};
      const tab = makeTab(overrides);
      if (overrides.id != null && overrides.id >= nextTabId) nextTabId = overrides.id + 1;
      tabsMap.set(tab.id, tab);
      evCreated.fire(tab);
      ids.push(tab.id);
    }
    return isArray ? ids : ids[0];
  }

  async function query(queryInfo) {
    let arr = [...tabsMap.values()];
    if (queryInfo && typeof queryInfo === "object") {
      for (const [k, v] of Object.entries(queryInfo)) {
        if (Array.isArray(v)) continue;
        arr = arr.filter((t) => t[k] === v);
      }
    }
    return arr.map((t) => ({ ...t }));
  }

  async function update(id, props) {
    const tab = tabsMap.get(id);
    if (!tab) throw new Error(`No tab with id: ${id}`);
    callLog.tabsUpdate.push([id, { ...props }]);
    Object.assign(tab, props);
    evUpdated.fire(id, { ...props }, { ...tab });
    return { ...tab };
  }

  async function remove(ids) {
    const arr = Array.isArray(ids) ? ids : [ids];
    callLog.tabsRemove.push([...arr]);
    const missing = [];
    for (const id of arr) {
      const tab = tabsMap.get(id);
      if (!tab) {
        missing.push(id);
        continue;
      }
      tabsMap.delete(id);
      evRemoved.fire(id, { windowId: tab.windowId, isClosing: true });
    }
    if (missing.length > 0) throw new Error(`No tab with id: ${missing.join(", ")}`);
  }

  async function create(props = {}) {
    callLog.tabsCreate.push({ ...props });
    const tab = makeTab(props);
    tabsMap.set(tab.id, tab);
    evCreated.fire(tab);
    return { ...tab };
  }

  async function discard(ids) {
    const arr = Array.isArray(ids) ? ids : [ids];
    callLog.tabsDiscard.push([...arr]);
    for (const id of arr) {
      const tab = tabsMap.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}`);
      tab.discarded = true;
      evUpdated.fire(id, { discarded: true }, { ...tab });
    }
    return null;
  }

  async function group(info = {}) {
    callLog.tabsGroup.push({ ...info });
    const gid = info.groupId != null ? info.groupId : nextGroupId++;
    for (const id of info.tabIds || []) {
      const tab = tabsMap.get(id);
      if (tab) tab.groupId = gid;
    }
    return gid;
  }

  async function sendMessage(tabId, message) {
    callLog.sendMessage.push([tabId, message && message.type]);
    const responder = contentResponders[String(tabId)];
    if (!responder) throw new Error("Could not establish connection. Receiving end does not exist.");
    return responder(message);
  }

  async function getTabById(id) {
    const tab = tabsMap.get(id);
    if (!tab) throw new Error(`No tab with id: ${id}`);
    return { ...tab };
  }

  async function replace(newTabId, oldTabId) {
    const old = tabsMap.get(oldTabId);
    if (!old) throw new Error(`No tab with id: ${oldTabId}`);
    tabsMap.delete(oldTabId);
    const moved = { ...old, id: newTabId };
    tabsMap.set(newTabId, moved);
    if (newTabId >= nextTabId) nextTabId = newTabId + 1;
    evReplaced.fire(newTabId, oldTabId);
    return moved;
  }

  const storageData = new Map();
  const onChanged = new FakeEvent();

  async function storageGet(keys) {
    if (keys == null) {
      const out = {};
      for (const [k, v] of storageData) out[k] = clone(v);
      return out;
    }
    if (typeof keys === "string") {
      const out = {};
      out[keys] = storageData.has(keys) ? clone(storageData.get(keys)) : undefined;
      return out;
    }
    if (Array.isArray(keys)) {
      const out = {};
      for (const k of keys) if (storageData.has(k)) out[k] = clone(storageData.get(k));
      return out;
    }
    const out = {};
    for (const [k, dv] of Object.entries(keys)) out[k] = storageData.has(k) ? clone(storageData.get(k)) : dv;
    return out;
  }

  async function storageSet(obj) {
    if (state.quotaFailFirst > 0) {
      state.quotaFailFirst--;
      throw new Error("QUOTA_BYTES quota exceeded");
    }
    const changes = {};
    for (const [k, v] of Object.entries(obj || {})) {
      changes[k] = {
        oldValue: storageData.has(k) ? clone(storageData.get(k)) : undefined,
        newValue: clone(v)
      };
      storageData.set(k, clone(v));
    }
    onChanged.fire(changes, "local");
  }

  async function storageRemove(keys) {
    const arr = Array.isArray(keys) ? keys : [keys];
    const changes = {};
    for (const k of arr) {
      if (storageData.has(k)) {
        changes[k] = { oldValue: clone(storageData.get(k)), newValue: undefined };
        storageData.delete(k);
      }
    }
    if (Object.keys(changes).length > 0) onChanged.fire(changes, "local");
  }

  async function alarmsCreate(name, info = {}) {
    const seconds =
      typeof info.delayInMinutes === "number"
        ? info.delayInMinutes * 60
        : Number(info.delayInSeconds) || 0;
    const scheduledAt = Date.now();
    const rec = { name, scheduledAt, fireAt: scheduledAt + seconds * 1000, delaySeconds: seconds };
    alarmsMap.set(name, rec);
    return { ...rec };
  }

  async function alarmsClear(name) {
    return alarmsMap.delete(name);
  }

  async function alarmsGetAll() {
    return [...alarmsMap.values()].map((r) => ({ ...r }));
  }

  function fireAlarm(name) {
    if (!alarmsMap.has(name)) return false;
    alarmsMap.delete(name);
    evAlarm.fire(name);
    return true;
  }

  async function executeScript(details) {
    const tabId = details && details.target && details.target.tabId;
    callLog.executeScript.push([tabId]);
    if (!tabsMap.has(tabId)) throw new Error(`No tab with id: ${tabId}`);
    if (state.injectFailIds.includes(tabId)) {
      throw new Error(`Cannot access contents of url "${tabsMap.get(tabId).url}".`);
    }
    return [];
  }

  const runtime = {
    id: "fake-ext",
    lastError: null,
    getURL(path) {
      return `chrome-extension://fake/${String(path).replace(/^\/+/, "")}`;
    },
    onMessage: new FakeEvent(),
    onInstalled: new FakeEvent(),
    onStartup: new FakeEvent(),
    sendMessage: async (msg) => {
      if (msg && typeof msg === "object" && typeof msg.tabId === "number") return sendMessage(msg.tabId, msg);
      return undefined;
    }
  };

  return {
    state,
    contentResponders,
    callLog,
    groupMeta,
    windowsStore,
    seed,
    fireAlarm,
    runtime,
    tabs: {
      tabsMap,
      onCreated: evCreated,
      onUpdated: evUpdated,
      onRemoved: evRemoved,
      onReplaced: evReplaced,
      onActivated: evActivated,
      query,
      get: getTabById,
      update,
      remove,
      create,
      discard,
      group,
      replace,
      sendMessage
    },
    tabGroups: {
      update: async (gid, props) => {
        callLog.tabGroupsUpdate.push([gid, { ...props }]);
        groupMeta[gid] = { ...(groupMeta[gid] || {}), ...props };
        return { groupId: gid, ...groupMeta[gid] };
      }
    },
    windows: {
      update: async (id, props) => {
        callLog.windowsUpdate.push([id, { ...props }]);
        windowsStore[id] = { ...(windowsStore[id] || {}), ...props };
        return { id, ...windowsStore[id] };
      }
    },
    storage: {
      local: {
        data: storageData,
        get: storageGet,
        set: storageSet,
        remove: storageRemove
      },
      onChanged
    },
    alarms: {
      map: alarmsMap,
      onAlarm: evAlarm,
      create: alarmsCreate,
      clear: alarmsClear,
      getAll: alarmsGetAll
    },
    scripting: {
      executeScript
    },
    permissions: {
      contains: async (perms) =>
        state.hostGranted && perms && Array.isArray(perms.origins) && perms.origins.length > 0,
      request: async () => {
        state.hostGranted = true;
        return true;
      }
    },
    commands: {
      onCommand: new FakeEvent()
    },
    omnibox: {
      onInputChanged: new FakeEvent(),
      onInputEntered: new FakeEvent()
    }
  };
}

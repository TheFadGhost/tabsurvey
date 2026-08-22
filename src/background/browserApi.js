function messageOf(value) {
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object" && typeof value.message === "string") return value.message;
  return String(value);
}

export function createBrowserApi(chromeImpl) {
  if (!chromeImpl) throw new Error("[tabsurvey] browserApi: missing chrome implementation");

  const lastError = () => (chromeImpl.runtime && chromeImpl.runtime.lastError) || null;

  function call(areaObj, areaName, methodName, ...args) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn) => {
        if (settled) return;
        settled = true;
        fn();
      };
      const fail = (value) => new Error(`[tabsurvey] ${areaName}.${methodName}: ${messageOf(value)}`);
      const cb = (...results) => {
        const le = lastError();
        if (le) settle(() => reject(fail(le)));
        else settle(() => resolve(results.length === 0 ? undefined : results.length === 1 ? results[0] : results));
      };
      let returned;
      try {
        returned = areaObj[methodName](...args, cb);
      } catch (e) {
        settle(() => reject(fail(e)));
        return;
      }
      if (returned && typeof returned.then === "function") {
        returned.then(
          (v) => settle(() => resolve(v)),
          (e) => settle(() => reject(fail(e)))
        );
      }
    });
  }

  function addListener(areaObj, areaName, eventName, cb) {
    try {
      const listener = (...args) => cb(...args);
      areaObj[eventName].addListener(listener);
      return () => {
        try {
          areaObj[eventName].removeListener(listener);
        } catch {
          return;
        }
      };
    } catch (e) {
      throw new Error(`[tabsurvey] ${areaName}.${eventName}: ${messageOf(e)}`);
    }
  }

  return {
    getTabs(queryInfo) {
      return call(chromeImpl.tabs, "tabs", "query", queryInfo || {});
    },

    getTab(id) {
      return call(chromeImpl.tabs, "tabs", "get", id).catch(() => null);
    },

    sendMessageToTab(tabId, message) {
      return call(chromeImpl.tabs, "tabs", "sendMessage", tabId, message);
    },

    executeScript(tabId, files) {
      return call(chromeImpl.scripting, "scripting", "executeScript", {
        target: { tabId },
        files
      });
    },

    storageGet(keys) {
      return call(chromeImpl.storage.local, "storage.local", "get", keys);
    },

    storageSet(obj) {
      return call(chromeImpl.storage.local, "storage.local", "set", obj);
    },

    storageRemove(keys) {
      return call(chromeImpl.storage.local, "storage.local", "remove", keys);
    },

    storageOnChanged(cb) {
      return addListener(chromeImpl.storage, "storage", "onChanged", cb);
    },

    alarmsCreate(name, delaySeconds) {
      return call(chromeImpl.alarms, "alarms", "create", name, { delayInMinutes: delaySeconds / 60 });
    },

    alarmsClear(name) {
      return call(chromeImpl.alarms, "alarms", "clear", name);
    },

    alarmsOnAlarm(cb) {
      return addListener(chromeImpl.alarms, "alarms", "onAlarm", (alarm) =>
        cb(alarm && typeof alarm === "object" && alarm !== null ? alarm.name : alarm)
      );
    },

    alarmsGetAll() {
      return call(chromeImpl.alarms, "alarms", "getAll");
    },

    permissionsContains(origins) {
      return call(chromeImpl.permissions, "permissions", "contains", { origins }).then(Boolean);
    },

    permissionsRequest(origins) {
      return call(chromeImpl.permissions, "permissions", "request", { origins }).then(Boolean);
    },

    tabGroup(tabIds, groupId) {
      const info = groupId != null ? { tabIds, groupId } : { tabIds };
      return call(chromeImpl.tabs, "tabs", "group", info);
    },

    updateGroup(groupId, props) {
      return call(chromeImpl.tabGroups, "tabGroups", "update", groupId, props);
    },

    windowsUpdate(windowId, props) {
      return call(chromeImpl.windows, "windows", "update", windowId, props);
    },

    tabSetActive(tabId) {
      return call(chromeImpl.tabs, "tabs", "update", tabId, { active: true });
    },

    tabsRemove(tabIds) {
      return call(chromeImpl.tabs, "tabs", "remove", tabIds);
    },

    async tabsDiscard(tabIds) {
      const errored = [];
      for (const id of tabIds) {
        try {
          await call(chromeImpl.tabs, "tabs", "discard", [id]);
        } catch {
          errored.push(id);
        }
      }
      return errored;
    },

    tabsCreate(props) {
      return call(chromeImpl.tabs, "tabs", "create", props || {});
    },

    runtimeGetURL(path) {
      try {
        return chromeImpl.runtime.getURL(path);
      } catch (e) {
        throw new Error(`[tabsurvey] runtime.getURL: ${messageOf(e)}`);
      }
    },

    runtimeOnMessage(cb) {
      try {
        const listener = (message, sender, sendResponse) => {
          let result;
          try {
            result = cb(message, sender);
          } catch (e) {
            try {
              sendResponse({ ok: false, error: messageOf(e) });
            } catch {
              return;
            }
            return;
          }
          if (result && typeof result.then === "function") {
            result.then(
              (v) => {
                try {
                  sendResponse(v);
                } catch {
                  return;
                }
              },
              (e) => {
                try {
                  sendResponse({ ok: false, error: messageOf(e) });
                } catch {
                  return;
                }
              }
            );
            return true;
          }
          if (result !== undefined) {
            try {
              sendResponse(result);
            } catch {
              return;
            }
          }
        };
        chromeImpl.runtime.onMessage.addListener(listener);
        return () => {
          try {
            chromeImpl.runtime.onMessage.removeListener(listener);
          } catch {
            return;
          }
        };
      } catch (e) {
        throw new Error(`[tabsurvey] runtime.onMessage: ${messageOf(e)}`);
      }
    },

    runtimeSendMessage(msg) {
      return call(chromeImpl.runtime, "runtime", "sendMessage", msg);
    },

    runtimeOnInstalled(cb) {
      return addListener(chromeImpl.runtime, "runtime", "onInstalled", () => cb());
    },

    runtimeOnStartup(cb) {
      return addListener(chromeImpl.runtime, "runtime", "onStartup", () => cb());
    },

    commandsOnCommand(cb) {
      return addListener(chromeImpl.commands, "commands", "onCommand", cb);
    },

    omniboxOnInputChanged(cb) {
      return addListener(chromeImpl.omnibox, "omnibox", "onInputChanged", cb);
    },

    omniboxOnInputEntered(cb) {
      return addListener(chromeImpl.omnibox, "omnibox", "onInputEntered", cb);
    },

    tabEvents: {
      created: {
        add(cb) {
          return addListener(chromeImpl.tabs, "tabs", "onCreated", cb);
        }
      },
      updated: {
        add(cb) {
          return addListener(chromeImpl.tabs, "tabs", "onUpdated", cb);
        }
      },
      removed: {
        add(cb) {
          return addListener(chromeImpl.tabs, "tabs", "onRemoved", cb);
        }
      },
      replaced: {
        add(cb) {
          return addListener(chromeImpl.tabs, "tabs", "onReplaced", cb);
        }
      },
      activated: {
        add(cb) {
          return addListener(chromeImpl.tabs, "tabs", "onActivated", cb);
        }
      }
    }
  };
}

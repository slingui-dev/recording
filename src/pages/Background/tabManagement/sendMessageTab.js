const isTransientMessagingError = (error) => {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("receiving end does not exist") ||
    message.includes("message port closed") ||
    message.includes("could not establish connection") ||
    message.includes("no tab with id") ||
    message.includes("invalid tab url")
  );
};

export const sendMessageTab = async (
  tabId,
  message,
  responseCallback = null,
  noTab = null
) => {
  if (tabId === null || message === null)
    return Promise.reject("Tab ID or message is null");

  try {
    let tab;
    const extOrigin = chrome.runtime.getURL("").replace(/\/$/, "");
    const urlBackoffMs = [0, 100, 300, 700];
    for (let attempt = 0; attempt < urlBackoffMs.length; attempt += 1) {
      if (urlBackoffMs[attempt] > 0) {
        await new Promise((resolve) => setTimeout(resolve, urlBackoffMs[attempt]));
      }
      tab = await new Promise((resolve, reject) => {
        chrome.tabs.get(tabId, (currentTab) => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError.message);
          } else {
            resolve(currentTab);
          }
        });
      });

      const url = tab?.url || "";
      const isTemporaryUrl = !tab || url === "" || url === "about:blank";
      const isProtectedUrl =
        url.startsWith("chrome://") ||
        url.startsWith("chromewebstore.google.com") ||
        url.startsWith("chrome.google.com/webstore");
      const isPendingExtUrl =
        tab?.pendingUrl && tab.pendingUrl.startsWith(extOrigin);
      if (!isTemporaryUrl || isProtectedUrl || isPendingExtUrl) break;
    }

    const isExtUrl = tab?.url && tab.url.startsWith(extOrigin);
    const isPendingExtUrl =
      tab?.pendingUrl && tab.pendingUrl.startsWith(extOrigin);

    if (isExtUrl || isPendingExtUrl) {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { ...message, _targetTabId: tab.id },
          (response) => {
            if (chrome.runtime.lastError) {
              const msg = chrome.runtime.lastError.message || "";
              if (isTransientMessagingError(msg)) {
                console.debug("[Slingui][Messaging] receiver unavailable", {
                  tabId: tab.id,
                  type: message?.type || null,
                  error: msg,
                });
                responseCallback ? responseCallback(undefined) : resolve();
                return;
              }
              reject(msg);
              return;
            }
            responseCallback ? responseCallback(response) : resolve(response);
          }
        );
      });
    }

    if (
      !tab ||
      !tab.url ||
      tab.url.startsWith("chrome://") ||
      tab.url.startsWith("chromewebstore.google.com") ||
      tab.url.startsWith("chrome.google.com/webstore") ||
      tab.url === "" ||
      tab.url === "about:blank"
    ) {
      return Promise.reject("Invalid tab URL");
    }

    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id, message, (response) => {
        if (chrome.runtime.lastError) {
          const error = chrome.runtime.lastError.message;
          if (isTransientMessagingError(error)) {
            console.debug("[Slingui][Messaging] receiver unavailable", {
              tabId: tab.id,
              type: message?.type || null,
              error,
            });
            responseCallback ? responseCallback(undefined) : resolve();
            return;
          }
          reject(error);
        } else {
          responseCallback ? responseCallback(response) : resolve(response);
        }
      });
    });
  } catch (error) {
    if (isTransientMessagingError(error)) {
      console.debug("[Slingui][Messaging] tab unavailable", {
        tabId,
        type: message?.type || null,
        error: String(error?.message || error),
      });
      if (noTab && typeof noTab === "function") noTab();
      return undefined;
    }
    console.error("Error sending message to tab:", error);
    if (noTab && typeof noTab === "function") {
      noTab();
    }
    return Promise.reject(error);
  }
};

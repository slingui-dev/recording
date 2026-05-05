import { initializeListeners } from "./listeners";
import { setupHandlers } from "./messaging/handlers";
import {
  messageRouter,
  messageDispatcher,
} from "../../messaging/messageRouter";
import { stopRecording } from "./recording/stopRecording";
import { getCurrentTab, sendMessageTab, removeTab } from "./tabManagement";
import { hydrateDiagnosticLog, diagEvent } from "../utils/diagnosticLog";

// Clear any storage flags that act as in-progress locks and could have been
// left in a "true" state if the service worker was killed mid-operation.
// Must run before any message handler or alarm handler has a chance to bail
// out on a stale lock.  Storage reads/writes are fast enough that they
// complete well before any queued event is dispatched to the worker.
const clearStaleLocks = async () => {
  try {
    const {
      sendingChunks,
      postStopEditorOpening,
      postStopEditorOpened,
      recording,
      multiMode,
      region,
    } = await chrome.storage.local.get([
      "sendingChunks",
      "postStopEditorOpening",
      "postStopEditorOpened",
      "recording",
      "multiMode",
      "region",
    ]);

    const stale = {};
    if (sendingChunks) {
      stale.sendingChunks = false;
      console.warn("[Screenity][BG] Stale lock found on startup: sendingChunks — clearing");
    }
    if (postStopEditorOpening) {
      stale.postStopEditorOpening = false;
      console.warn("[Screenity][BG] Stale lock found on startup: postStopEditorOpening — clearing");
    }
    if (postStopEditorOpened) {
      stale.postStopEditorOpened = false;
      console.warn("[Screenity][BG] Stale lock found on startup: postStopEditorOpened — clearing");
    }

    if (multiMode && !recording) {
      stale.multiMode = false;
      stale.multiSceneCount = 0;
      stale.multiProjectId = null;
      stale.multiLastSceneId = null;
      console.warn("[Screenity][BG] Stale multi-mode state found on startup — clearing");
    }

    if (region && !recording) {
      stale.region = false;
      console.warn("[Screenity][BG] Stale region state found on startup — clearing");
    }

    if (Object.keys(stale).length > 0) {
      await chrome.storage.local.set(stale);
      console.info(
        "[Screenity][BG] Startup stale locks cleared:",
        Object.keys(stale).join(", "),
      );
    }
  } catch (err) {
    console.error("[Screenity][BG] Failed to clear stale startup locks:", err);
  }
};

// Event listeners must be registered synchronously at module evaluation time
// so Chrome counts them for service worker keep-alive.
messageRouter();
initializeListeners();
setupHandlers();

// Fire-and-forget: clears stale locks from a previous crashed session.
// Runs after listener registration (required synchronous) but before Chrome
// can dispatch any queued events to this worker.
clearStaleLocks();

// One-time migration for users upgrading from 4.3.7. The finalize-hang bug on
// abrupt stream end caused sticky-disable to fire for many WebCodecs users;
// the underlying cause is fixed in this release (fragmented MP4 + streaming),
// so the sticky flags are no longer warranted and should be cleared once so
// affected users get WebCodecs again on their next recording. The user's
// explicit opt-out (useWebCodecsRecorder === false) is preserved.
const CURRENT_MIGRATION_VERSION = "4.3.8";
const runUpgradeMigrations = async () => {
  try {
    const { screenityMigratedForVersion } = await chrome.storage.local.get([
      "screenityMigratedForVersion",
    ]);
    if (screenityMigratedForVersion === CURRENT_MIGRATION_VERSION) return;

    await chrome.storage.local.remove([
      "fastRecorderDisabledForDevice",
      "fastRecorderDisabledReason",
      "fastRecorderDisabledAt",
      "fastRecorderDisabledDetails",
      "fastRecorderValidationFailed",
      "fastRecorderValidation",
      "lastWebCodecsFailureAt",
      "lastWebCodecsFailureCode",
      "lastFailedValidation",
    ]);
    await chrome.storage.local.set({
      screenityMigratedForVersion: CURRENT_MIGRATION_VERSION,
    });
    console.info(
      "[Screenity][BG] Cleared stale 4.3.7 sticky-disable flags on upgrade",
    );
  } catch (err) {
    console.error("[Screenity][BG] Upgrade migration failed:", err);
  }
};
runUpgradeMigrations();

// Hydrate the diagnostic log from storage and record that the SW (re)started.
hydrateDiagnosticLog().then(() => {
  diagEvent("sw-init", { ts: Date.now() });
});

// Check when action button is clicked
chrome.action.onClicked.addListener(async (tab) => {
  // Check if recording
  const { recording } = await chrome.storage.local.get(["recording"]);
  if (recording) {
    stopRecording();
    sendMessageRecord({ type: "stop-recording-tab" });
    const { activeTab } = await chrome.storage.local.get(["activeTab"]);

    // Check if actual tab
    chrome.tabs.get(activeTab, (t) => {
      if (t) {
        sendMessageTab(activeTab, { type: "stop-recording-tab" });
      } else {
        sendMessageTab(tab.id, { type: "stop-recording-tab" });
        chrome.storage.local.set({ activeTab: tab.id });
      }
    });
  } else {
    // Check if it's possible to inject into content (not a chrome:// page, new tab, etc)
    if (
      !(
        (navigator.onLine === false &&
          !tab.url.includes("/playground.html") &&
          !tab.url.includes("/setup.html")) ||
        tab.url.startsWith("chrome://") ||
        (tab.url.startsWith("chrome-extension://") &&
          !tab.url.includes("/playground.html") &&
          !tab.url.includes("/setup.html"))
      ) &&
      !tab.url.includes("stackoverflow.com/") &&
      !tab.url.includes("chrome.google.com/webstore") &&
      !tab.url.includes("chromewebstore.google.com")
    ) {
      sendMessageTab(tab.id, { type: "toggle-popup" });
      chrome.storage.local.set({ activeTab: tab.id });
    } else {
      chrome.tabs
        .create({
          url: "playground.html",
          active: true,
        })
        .then((tab) => {
          chrome.storage.local.set({ activeTab: tab.id });
        });
    }
  }

  const { firstTime } = await chrome.storage.local.get(["firstTime"]);

  if (firstTime && tab.url.includes(chrome.runtime.getURL("setup.html"))) {
    chrome.storage.local.set({ firstTime: false });
    // Send message to active tab
    const activeTab = await getCurrentTab();
    sendMessageTab(activeTab.id, { type: "setup-complete" });
  }
});

const restartActiveTab = async () => {
  const activeTab = await getCurrentTab();
  sendMessageTab(activeTab.id, { type: "ready-to-record" });
};

const getStreamingData = async () => {
  const {
    micActive,
    defaultAudioInput,
    defaultAudioOutput,
    defaultVideoInput,
    systemAudio,
    recordingType,
  } = await chrome.storage.local.get([
    "micActive",
    "defaultAudioInput",
    "defaultAudioOutput",
    "defaultVideoInput",
    "systemAudio",
    "recordingType",
  ]);

  return {
    micActive,
    defaultAudioInput,
    defaultAudioOutput,
    defaultVideoInput,
    systemAudio,
    recordingType,
  };
};

const handleDismiss = async () => {
  chrome.storage.local.set({ restarting: true });
  const { region } = await chrome.storage.local.get(["region"]);
  // Check if wasRegion is set
  const { wasRegion } = await chrome.storage.local.get(["wasRegion"]);
  if (wasRegion) {
    chrome.storage.local.set({ wasRegion: false, region: true });
  }
  chrome.action.setIcon({ path: "assets/icon-34.png" });
};

const handleRestart = async () => {
  chrome.storage.local.set({ restarting: true });
  let editor_url = "editor.html";

  // Check if Chrome version is 109 or below
  if (navigator.userAgent.includes("Chrome/")) {
    const version = parseInt(navigator.userAgent.match(/Chrome\/([0-9]+)/)[1]);
    if (version <= 109) {
      editor_url = "editorfallback.html";
    }
  }

  resetActiveTabRestart();
};

const sendMessageRecord = async (message) => {
  // Send a message to the recording tab or offscreen recording document, depending on which was created
  chrome.storage.local.get(["recordingTab", "offscreen"], (result) => {
    if (result.offscreen) {
      chrome.runtime.sendMessage(message);
    } else {
      // Get the recording tab first before sending the message
      sendMessageTab(result.recordingTab, message);
    }
  });
};

const initBackup = async (request, id) => {
  const { backupTab } = await chrome.storage.local.get(["backupTab"]);
  const backupURL = chrome.runtime.getURL("backup.html");

  if (backupTab) {
    chrome.tabs.get(backupTab, (tab) => {
      if (tab) {
        sendMessageTab(tab.id, {
          type: "init-backup",
          request: request,
          tabId: id,
        });
      } else {
        chrome.tabs.create(
          {
            url: backupURL,
            active: true,
            pinned: true,
            index: 0,
          },
          (tab) => {
            chrome.storage.local.set({ backupTab: tab.id });
            chrome.tabs.onUpdated.addListener(function _(
              tabId,
              changeInfo,
              updatedTab
            ) {
              // Check if recorder tab has finished loading
              if (tabId === tab.id && changeInfo.status === "complete") {
                sendMessageTab(tab.id, {
                  type: "init-backup",
                  request: request,
                  tabId: id,
                });
                chrome.tabs.onUpdated.removeListener(_);
              }
            });
          }
        );
      }
    });
  } else {
    chrome.tabs.create(
      {
        url: backupURL,
        active: true,
        pinned: true,
        index: 0,
      },
      (tab) => {
        chrome.storage.local.set({ backupTab: tab.id });
        chrome.tabs.onUpdated.addListener(function _(
          tabId,
          changeInfo,
          updatedTab
        ) {
          // Check if recorder tab has finished loading
          if (tabId === tab.id && changeInfo.status === "complete") {
            sendMessageTab(tab.id, {
              type: "init-backup",
              request: request,
              tabId: id,
            });
            chrome.tabs.onUpdated.removeListener(_);
          }
        });
      }
    );
  }
};

const offscreenDocument = async (request, tabId = null) => {
  const { backup } = await chrome.storage.local.get(["backup"]);
  let activeTab = await getCurrentTab();
  if (tabId !== null) {
    activeTab = await chrome.tabs.get(tabId);
  }
  chrome.storage.local.set({
    activeTab: activeTab.id,
    tabRecordedID: null,
    memoryError: false,
  });

  // Check activeTab URL
  if (activeTab.url.includes(chrome.runtime.getURL("playground.html"))) {
    chrome.storage.local.set({ tabPreferred: true });
  } else {
    chrome.storage.local.set({ tabPreferred: false });
  }

  // Close all offscreen documents (if chrome.offscreen is available)
  try {
    const existingContexts = await chrome.runtime.getContexts({});
    const offscreenDocument = existingContexts.find(
      (c) => c.contextType === "OFFSCREEN_DOCUMENT"
    );
    if (offscreenDocument) {
      await chrome.offscreen.closeDocument();
    }
  } catch (error) {}

  if (request.region) {
    if (tabId !== null) {
      // Navigate to the tab
      chrome.tabs.update(tabId, { active: true });
    }
    chrome.storage.local.set({
      recordingTab: activeTab.id,
      offscreen: false,
      region: true,
    });

    if (request.customRegion) {
      sendMessageRecord({
        type: "loaded",
        request: request,
        backup: backup,
        region: true,
      });
    } else {
      try {
        // This is following the steps from this page, but it still doesn't work :( https://developer.chrome.com/docs/extensions/mv3/screen_capture/#audio-and-video-offscreen-doc
        throw new Error("Exit offscreen recording");
        const existingContexts = await chrome.runtime.getContexts({});

        const offDocument = existingContexts.find(
          (c) => c.contextType === "OFFSCREEN_DOCUMENT"
        );

        if (offDocument) {
          // If an offscreen document is already open, close it.
          await chrome.offscreen.closeDocument();
        }

        // Create an offscreen document.
        await chrome.offscreen.createDocument({
          url: "recorderoffscreen.html",
          reasons: ["USER_MEDIA", "AUDIO_PLAYBACK", "DISPLAY_MEDIA"],
          justification:
            "Recording from getDisplayMedia API and tabCapture API",
        });

        const streamId = await chrome.tabCapture.getMediaStreamId({
          targetTabId: activeTab.id,
        });

        chrome.storage.local.set({
          recordingTab: null,
          offscreen: true,
          region: false,
          wasRegion: true,
        });
        sendMessageRecord({
          type: "loaded",
          request: request,
          isTab: true,
          tabID: streamId,
        });
      } catch (error) {
        // Open the recorder.html page as a normal tab.
        chrome.tabs
          .create({
            url: "recorder.html",
            pinned: true,
            index: 0,
            active: activeTab.url.includes(
              chrome.runtime.getURL("playground.html")
            )
              ? true
              : false,
          })
          .then((tab) => {
            chrome.storage.local.set({
              recordingTab: tab.id,
              offscreen: false,
              region: false,
              wasRegion: true,
              tabRecordedID: activeTab.id,
            });
            chrome.tabs.onUpdated.addListener(function _(
              tabId,
              changeInfo,
              updatedTab
            ) {
              // Check if recorder tab has finished loading
              if (tabId === tab.id && changeInfo.status === "complete") {
                chrome.tabs.onUpdated.removeListener(_);
                sendMessageRecord({
                  type: "loaded",
                  request: request,
                  tabID: activeTab.id,
                  backup: backup,
                  isTab: true,
                });
              }
            });
          });
      }
    }
  } else {
    try {
      if (!request.offscreenRecording || request.camera) {
        throw new Error("Exit offscreen recording");
      }

      if (tabId !== null) {
        // Navigate to the tab
        chrome.tabs.update(tabId, { active: true });
      }

      const { qualityValue } = await chrome.storage.local.get(["qualityValue"]);
      const { fpsValue } = await chrome.storage.local.get(["fpsValue"]);

      // also add && !request.camera above if works
      const existingContexts = await chrome.runtime.getContexts({});

      const offDocument = existingContexts.find(
        (c) => c.contextType === "OFFSCREEN_DOCUMENT"
      );

      if (offDocument) {
        // If an offscreen document is already open, close it.
        await chrome.offscreen.closeDocument();
      }
      // Create an offscreen document.
      await chrome.offscreen.createDocument({
        url: "recorderoffscreen.html",
        reasons: ["USER_MEDIA", "AUDIO_PLAYBACK", "DISPLAY_MEDIA"],
        justification: "Recording from getDisplayMedia API",
      });

      chrome.storage.local.set({
        recordingTab: null,
        offscreen: true,
        region: false,
        wasRegion: false,
      });
      sendMessageRecord({
        type: "loaded",
        request: request,
        isTab: false,
        quality: qualityValue,
        fps: fpsValue,
        backup: backup,
      });
    } catch (error) {
      // Open the recorder.html page as a normal tab.
      let switchTab = true;
      if (request.camera) {
        switchTab = false;
      }
      chrome.tabs
        .create({
          url: "recorder.html",
          pinned: true,
          index: 0,
          active: switchTab,
        })
        .then((tab) => {
          chrome.storage.local.set({
            recordingTab: tab.id,
            offscreen: false,
            region: false,
            wasRegion: false,
          });
          chrome.tabs.onUpdated.addListener(function _(
            tabId,
            changeInfo,
            updatedTab
          ) {
            // Check if recorder tab has finished loading
            if (tabId === tab.id && changeInfo.status === "complete") {
              chrome.tabs.onUpdated.removeListener(_);
              sendMessageRecord({
                type: "loaded",
                request: request,
                backup: backup,
              });
            }
          });
        });
    }
  }
};

const savedToDrive = async () => {
  const { sandboxTab } = await chrome.storage.local.get(["sandboxTab"]);
  sendMessageTab(sandboxTab, { type: "saved-to-drive" });
};

const discardOffscreenDocuments = async () => {
  // Try doing (maybe offscreen isn't available)
  try {
    const existingContexts = await chrome.runtime.getContexts({});
    const offscreenDocument = existingContexts.find(
      (c) => c.contextType === "OFFSCREEN_DOCUMENT"
    );
    if (offscreenDocument) {
      await chrome.offscreen.closeDocument();
    }
  } catch (error) {}
};

const executeScripts = async () => {
  const contentScripts = chrome.runtime.getManifest().content_scripts;
  const tabQueries = contentScripts.map((cs) =>
    chrome.tabs.query({ url: cs.matches })
  );
  const tabResults = await Promise.all(tabQueries);

  const executeScriptPromises = [];
  for (let i = 0; i < tabResults.length; i++) {
    const tabs = tabResults[i];
    const cs = contentScripts[i];

    for (const tab of tabs) {
      const executeScriptPromise = chrome.scripting.executeScript(
        {
          target: { tabId: tab.id },
          files: cs.js,
        },
        () => chrome.runtime.lastError
      );
      executeScriptPromises.push(executeScriptPromise);
    }
  }

  await Promise.all(executeScriptPromises);
};

// On first install open setup.html
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    // Clear storage
    chrome.storage.local.clear();

    const locale = chrome.i18n.getMessage("@@ui_locale");
    if (locale.includes("en")) {
      chrome.runtime.setUninstallURL(
        "https://tally.so/r/w8Zro5?version=" +
          chrome.runtime.getManifest().version
      );
    } else {
      chrome.runtime.setUninstallURL(
        "http://translate.google.com/translate?js=n&sl=auto&tl=" +
          locale +
          "&u=https://tally.so/r/w8Zro5?version=" +
          chrome.runtime.getManifest().version
      );
    }
    chrome.storage.local.set({ firstTime: true });
    chrome.tabs.create({
      url: "setup.html",
    });
  } else if (details.reason === "update") {
    if (details.previousVersion === "2.8.6") {
      // Clear storage
      chrome.storage.local.clear();
      chrome.storage.local.set({ updatingFromOld: true });
    } else {
      chrome.storage.local.set({ updatingFromOld: false });
    }
    const locale = chrome.i18n.getMessage("@@ui_locale");
    if (locale.includes("en")) {
      chrome.runtime.setUninstallURL(
        "https://tally.so/r/3Ex6kX?version=" +
          chrome.runtime.getManifest().version
      );
    } else {
      chrome.runtime.setUninstallURL(
        "http://translate.google.com/translate?js=n&sl=auto&tl=" +
          locale +
          "&u=https://tally.so/r/3Ex6kX?version=" +
          chrome.runtime.getManifest().version
      );
    }
  }
  // Check chrome version, if 109 or below, disable backups
  if (navigator.userAgent.includes("Chrome/")) {
    const version = parseInt(navigator.userAgent.match(/Chrome\/([0-9]+)/)[1]);
    if (version <= 109) {
      chrome.storage.local.set({ backup: false });
    }
  }

  chrome.storage.local.set({ systemAudio: true });

  // Check if the backup tab is open, if so close it
  const { backupTab } = await chrome.storage.local.get(["backupTab"]);
  if (backupTab) {
    removeTab(backupTab);
  }

  executeScripts();
});

// Detect if recordingTab is closed
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  // Check if region recording
  const { region } = await chrome.storage.local.get(["region"]);

  if (region) return;
  const { recordingTab } = await chrome.storage.local.get(["recordingTab"]);
  const { recording } = await chrome.storage.local.get(["recording"]);
  const { restarting } = await chrome.storage.local.get(["restarting"]);

  if (tabId === recordingTab && !restarting) {
    chrome.storage.local.set({ recordingTab: null });
    // Send a message to active tab
    const { activeTab } = await chrome.storage.local.get(["activeTab"]);

    try {
      if (recording) {
        focusTab(activeTab);
      }
      sendMessageTab(activeTab, { type: "stop-recording-tab" }, null, () => {
        // Tab doesn't exist, so just set activeTab to null
        sendMessageTab(tabId, { type: "stop-recording-tab" });
        chrome.storage.local.set({ activeTab: tabId });
      });
    } catch (error) {
      sendMessageTab(tabId, { type: "stop-recording-tab" });
      chrome.storage.local.set({ activeTab: tabId });
    }

    // Update icon
    chrome.action.setIcon({ path: "assets/icon-34.png" });
  }
});

const discardRecording = async () => {
  sendMessageRecord({ type: "dismiss-recording" });
  chrome.action.setIcon({ path: "assets/icon-34.png" });
  discardOffscreenDocuments();
  chrome.storage.local.set({
    recordingTab: null,
    sandboxTab: null,
    recording: false,
  });
  chrome.runtime.sendMessage({ type: "discard-backup" });
};

// Check if still (actually) recording by looking at recordingTab or offscreen document
const checkRecording = async () => {
  const { recordingTab } = await chrome.storage.local.get(["recordingTab"]);
  const { offscreen } = await chrome.storage.local.get(["offscreen"]);
  if (recordingTab && !offscreen) {
    try {
      chrome.tabs.get(recordingTab, (tab) => {
        if (!tab) {
          discardRecording();
        }
      });
    } catch (error) {
      discardRecording();
    }
  } else if (offscreen) {
    const existingContexts = await chrome.runtime.getContexts({});
    const offDocument = existingContexts.find(
      (c) => c.contextType === "OFFSCREEN_DOCUMENT"
    );
    if (!offDocument) {
      discardRecording();
    }
  }
};

const newSandboxPageRestart = async () => {
  resetActiveTabRestart();
};

const isPinned = (sendResponse) => {
  chrome.action.getUserSettings().then((userSettings) => {
    sendResponse({ pinned: userSettings.isOnToolbar });
  });
};

const requestDownload = async (base64, title) => {
  // Open a new tab to get URL
  chrome.tabs.create(
    {
      url: "download.html",
      active: false,
    },
    (tab) => {
      chrome.tabs.onUpdated.addListener(function _(
        tabId,
        changeInfo,
        updatedTab
      ) {
        if (tabId === tab.id && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(_);
          sendMessageTab(tab.id, {
            type: "download-video",
            base64: base64,
            title: title,
          });
        }
      });
    }
  );
};

const downloadIndexedDB = async () => {
  // Open a new tab to get URL
  chrome.tabs.create(
    {
      url: "download.html",
      active: false,
    },
    (tab) => {
      chrome.tabs.onUpdated.addListener(function _(
        tabId,
        changeInfo,
        updatedTab
      ) {
        if (tabId === tab.id && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(_);
          sendMessageTab(tab.id, {
            type: "download-indexed-db",
          });
        }
      });
    }
  );
};

const getPlatformInfo = (sendResponse) => {
  chrome.runtime.getPlatformInfo((info) => {
    sendResponse(info);
  });
};

const restoreRecording = async () => {
  let editor_url = "editorfallback.html";

  // Check if Chrome version is 109 or below
  if (navigator.userAgent.includes("Chrome/")) {
    const version = parseInt(navigator.userAgent.match(/Chrome\/([0-9]+)/)[1]);
    if (version <= 109) {
      editor_url = "editorfallback.html";
    }
  }

  let chunks = [];
  await chunksStore.iterate((value, key) => {
    chunks.push(value);
  });

  if (chunks.length === 0) {
    return;
  }

  chrome.tabs.create(
    {
      url: editor_url,
      active: true,
    },
    async (tab) => {
      // Set URL as sandbox tab
      chrome.storage.local.set({ sandboxTab: tab.id });
      // Wait for the tab to be loaded
      await new Promise((resolve) => {
        chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
          if (info.status === "complete" && tabId === tab.id) {
            sendMessageTab(tab.id, {
              type: "restore-recording",
            });

            sendChunks();
          }
        });
      });
    }
  );
};

const checkRestore = async (sendResponse) => {
  const chunks = [];
  await chunksStore.iterate((value, key) => {
    chunks.push(value);
  });

  if (chunks.length === 0) {
    sendResponse({ restore: false, chunks: [] });
    return;
  }
  sendResponse({ restore: true });
};

const base64ToUint8Array = (base64) => {
  const dataUrlRegex = /^data:(.*?);base64,/;
  const matches = base64.match(dataUrlRegex);
  if (matches !== null) {
    // Base64 is a data URL
    const mimeType = matches[1];
    const binaryString = atob(base64.slice(matches[0].length));
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
  } else {
    // Base64 is a regular string
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return new Blob([bytes], { type: "video/webm" });
  }
};

const handleSaveToDrive = async (sendResponse, request, fallback = false) => {
  if (!fallback) {
    const blob = base64ToUint8Array(request.base64);

    // Specify the desired file name
    const fileName = request.title + ".mp4";

    // Call the saveToDrive function
    saveToDrive(blob, fileName, sendResponse).then(() => {
      savedToDrive();
    });
  } else {
    const chunks = [];
    await chunksStore.iterate((value, key) => {
      chunks.push(value);
    });

    // Build the video from chunks
    let array = [];
    let lastTimestamp = 0;
    for (const chunk of chunks) {
      // Check if chunk timestamp is smaller than last timestamp, if so, skip
      if (chunk.timestamp < lastTimestamp) {
        continue;
      }
      lastTimestamp = chunk.timestamp;
      array.push(chunk.chunk);
    }
    const blob = new Blob(array, { type: "video/webm" });

    const filename = request.title + ".webm";

    saveToDrive(blob, filename, sendResponse).then(() => {
      savedToDrive();
    });
  }
};

const desktopCapture = async (request) => {
  const { backup } = await chrome.storage.local.get(["backup"]);
  const { backupSetup } = await chrome.storage.local.get(["backupSetup"]);
  chrome.storage.local.set({ sendingChunks: false });
  if (backup) {
    if (!backupSetup) {
      localDirectoryStore.clear();
    }

    let activeTab = await getCurrentTab();
    initBackup(request, activeTab.id);
  } else {
    offscreenDocument(request);
  }
};

const writeFile = async (request) => {
  // Need to add safety check here to make sure the tab is still open
  const { backupTab } = await chrome.storage.local.get(["backupTab"]);

  if (backupTab) {
    sendMessageTab(
      backupTab,
      {
        type: "write-file",
        index: request.index,
      },
      null,
      () => {
        sendMessageRecord({ type: "stop-recording-tab" });
      }
    );
  } else {
    sendMessageRecord({ type: "stop-recording-tab" });
  }
};

const videoReady = async () => {
  const { backupTab } = await chrome.storage.local.get(["backupTab"]);
  if (backupTab) {
    sendMessageTab(backupTab, { type: "close-writable" });
  }
  stopRecording();
};

const newChunk = async (request) => {
  const { sandboxTab } = await chrome.storage.local.get(["sandboxTab"]);
  sendMessageTab(sandboxTab, {
    type: "new-chunk-tab",
    chunk: request.chunk,
    index: request.index,
  });

  sendResponse({ status: "ok" });
};

const handleGetStreamingData = async () => {
  const data = await getStreamingData();
  sendMessageRecord({ type: "streaming-data", data: JSON.stringify(data) });
};

const cancelRecording = async () => {
  chrome.action.setIcon({ path: "assets/icon-34.png" });
  const { activeTab } = await chrome.storage.local.get(["activeTab"]);
  sendMessageTab(activeTab, { type: "stop-pending" });
  focusTab(activeTab);
  discardOffscreenDocuments();
};

const handleStopRecordingTab = async (request) => {
  if (request.memoryError) {
    chrome.storage.local.set({
      recording: false,
      restarting: false,
      tabRecordedID: null,
      memoryError: true,
    });
  }
  // sendMessageRecord({
  //   type: "loaded",
  //   request: request,
  //   backup: backup,
  //   region: true,
  // });
  sendMessageRecord({ type: "stop-recording-tab" });
};

const handleRestartRecordingTab = async () => {
  //removeSandbox();
};

const handleDismissRecordingTab = async () => {
  chrome.runtime.sendMessage({ type: "discard-backup" });
  discardRecording();
};

const setMicActiveTab = async (request) => {
  chrome.storage.local.get(["region"], (result) => {
    if (result.region) {
      sendMessageRecord({
        type: "set-mic-active-tab",
        active: request.active,
        defaultAudioInput: request.defaultAudioInput,
      });
    }
  });
};

const handleRecordingError = async (request) => {
  // get actual active tab
  const { activeTab } = await chrome.storage.local.get(["activeTab"]);

  sendMessageRecord({ type: "recording-error" }).then(() => {
    sendMessageTab(activeTab, { type: "stop-pending" });
    focusTab(activeTab);
    if (request.error === "stream-error") {
      sendMessageTab(activeTab, { type: "stream-error" });
    } else if (request.error === "backup-error") {
      sendMessageTab(activeTab, { type: "backup-error" });
    }
  });

  // Close recording tab
  const { recordingTab } = await chrome.storage.local.get(["recordingTab"]);
  const { region } = await chrome.storage.local.get(["region"]);
  // Check if tab exists (with tab api)
  if (recordingTab && !region) {
    removeTab(recordingTab);
  }
  chrome.storage.local.set({ recordingTab: null });
  discardOffscreenDocuments();
};

const handleOnGetPermissions = async (request) => {
  // Send a message to (actual) active tab
  const activeTab = await getCurrentTab();
  if (activeTab) {
    sendMessageTab(activeTab.id, {
      type: "on-get-permissions",
      data: request,
    });
  }
};

const handleRecordingComplete = async () => {
  // Close the recording tab
  const { recordingTab } = await chrome.storage.local.get(["recordingTab"]);

  // Check if tab exists (with tab api)
  if (recordingTab) {
    chrome.tabs.get(recordingTab, (tab) => {
      if (tab) {
        // Check if tab url contains chrome-extension and recorder.html
        if (
          tab.url.includes("chrome-extension") &&
          tab.url.includes("recorder.html")
        ) {
          removeTab(recordingTab);
        }
      }
    });
  }
};

const setSurface = async (request) => {
  chrome.storage.local.set({
    surface: request.surface,
  });

  const { activeTab } = await chrome.storage.local.get(["activeTab"]);
  sendMessageTab(activeTab, {
    type: "set-surface",
    surface: request.surface,
  });
};

const handlePip = async (started = false) => {
  const { activeTab } = await chrome.storage.local.get(["activeTab"]);
  if (started) {
    sendMessageTab(activeTab, { type: "pip-started" });
  } else {
    sendMessageTab(activeTab, { type: "pip-ended" });
  }
};

const handleSignOutDrive = async () => {
  // Get token
  const { token } = await chrome.storage.local.get(["token"]);
  var url = "https://accounts.google.com/o/oauth2/revoke?token=" + token;
  fetch(url);

  chrome.identity.removeCachedAuthToken({ token: token });
  chrome.storage.local.set({ token: false });
};

const handleStopRecordingTabBackup = async (request) => {
  chrome.storage.local.set({
    recording: false,
    restarting: false,
    tabRecordedID: null,
    memoryError: true,
  });
  sendMessageRecord({ type: "stop-recording-tab" });

  // Get active tab
  const { activeTab } = await chrome.storage.local.get(["activeTab"]);
  // Check if actual tab
  sendMessageTab(activeTab, { type: "stop-pending" });
  focusTab(activeTab);
};

const clearAllRecordings = async () => {
  chunksStore.clear();
};

const resizeWindow = async (width, height) => {
  if (width === 0 || height === 0) {
    return;
  }

  chrome.windows.getCurrent((window) => {
    chrome.windows.update(window.id, {
      width: width,
      height: height,
    });
  });
};

const checkAvailableMemory = (sendResponse) => {
  navigator.storage.estimate().then((data) => {
    sendResponse({ data: data });
  });
};

// Listen for messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "desktop-capture") {
    desktopCapture(request);
  } else if (request.type === "ping-screenity") {
    sendMessageTab(sender.tab.id, { type: "screenity-pong" });
  } else if (request.type === "backup-created") {
    offscreenDocument(request.request, request.tabId);
  } else if (request.type === "write-file") {
    writeFile(request);
  } else if (request.type === "handle-restart") {
    handleRestart();
  } else if (request.type === "handle-dismiss") {
    handleDismiss();
  } else if (request.type === "reset-active-tab") {
    resetActiveTab();
  } else if (request.type === "reset-active-tab-restart") {
    resetActiveTabRestart();
  } else if (request.type === "start-rec") {
    startRecording();
  } else if (request.type === "video-ready") {
    videoReady();
  } else if (request.type === "start-recording") {
    startRecording();
  } else if (request.type === "restarted") {
    restartActiveTab();
  } else if (request.type === "new-chunk") {
    newChunk(request);
    return true;
  } else if (request.type === "get-streaming-data") {
    handleGetStreamingData();
  } else if (request.type === "cancel-recording") {
    cancelRecording();
  } else if (request.type === "stop-recording-tab") {
    handleStopRecordingTab(request);
  } else if (request.type === "restart-recording-tab") {
    handleRestartRecordingTab();
  } else if (request.type === "dismiss-recording-tab") {
    handleDismissRecordingTab();
  } else if (request.type === "pause-recording-tab") {
    sendMessageRecord({ type: "pause-recording-tab" });
  } else if (request.type === "resume-recording-tab") {
    sendMessageRecord({ type: "resume-recording-tab" });
  } else if (request.type === "set-mic-active-tab") {
    setMicActiveTab(request);
  } else if (request.type === "recording-error") {
    handleRecordingError(request);
  } else if (request.type === "on-get-permissions") {
    handleOnGetPermissions(request);
  } else if (request.type === "recording-complete") {
    handleRecordingComplete();
  } else if (request.type === "check-recording") {
    checkRecording();
  } else if (request.type === "review-screenity") {
    createTab(
      "https://chrome.google.com/webstore/detail/screenity-screen-recorder/kbbdabhdfibnancpjfhlkhafgdilcnji/reviews",
      false,
      true
    );
  } else if (request.type === "follow-twitter") {
    createTab("https://alyssax.substack.com/", false, true);
  } else if (request.type === "open-processing-info") {
    createTab(
      "https://docs.slingui.com/recording-help/editing-and-exporting/dJRFpGq56JFKC7k8zEvsqb/why-is-there-a-5-minute-limit-for-editing/ddy4e4TpbnrFJ8VoRT37tQ",
      true,
      true
    );
  } else if (request.type === "upgrade-info") {
    createTab(
      "https://docs.slingui.com/recording-help/getting-started/77KizPC8MHVGfpKpqdux9D/what-are-the-technical-requirements-for-using-screenity/6kdB6qru6naVD8ZLFvX3m9",
      true,
      true
    );
  } else if (request.type === "trim-info") {
    createTab(
      "https://docs.slingui.com/recording-help/editing-and-exporting/dJRFpGq56JFKC7k8zEvsqb/how-to-cut-trim-or-mute-parts-of-your-video/svNbM7YHYY717MuSWXrKXH",
      true,
      true
    );
  } else if (request.type === "join-waitlist") {
    createTab("https://tally.so/r/npojNV", true, true);
  } else if (request.type === "chrome-update-info") {
    createTab(
      "https://docs.slingui.com/recording-help/getting-started/77KizPC8MHVGfpKpqdux9D/what-are-the-technical-requirements-for-using-screenity/6kdB6qru6naVD8ZLFvX3m9",
      true,
      true
    );
  } else if (request.type === "set-surface") {
    setSurface(request);
  } else if (request.type === "pip-ended") {
    handlePip(false);
  } else if (request.type === "pip-started") {
    handlePip(true);
  } else if (request.type === "new-sandbox-page-restart") {
    newSandboxPageRestart();
  } else if (request.type === "sign-out-drive") {
    handleSignOutDrive();
  } else if (request.type === "open-help") {
    createTab("https://docs.slingui.com/recording-help/", true, true);
  } else if (request.type === "memory-limit-help") {
    createTab(
      "https://docs.slingui.com/recording-help/troubleshooting/9Jy5RGjNrBB42hqUdREQ7W/what-does-%E2%80%9Cmemory-limit-reached%E2%80%9D-mean-when-recording/8WkwHbt3puuXunYqQnyPcb",
      true,
      true
    );
  } else if (request.type === "open-home") {
    createTab("https://slingui.com/", false, true);
  } else if (request.type === "report-bug") {
    createTab(
      "https://tally.so/r/3ElpXq?version=" +
        chrome.runtime.getManifest().version,
      false,
      true
    );
  } else if (request.type === "clear-recordings") {
    clearAllRecordings();
  } else if (request.type === "force-processing") {
    forceProcessing();
  } else if (request.type === "focus-this-tab") {
    focusTab(sender.tab.id);
  } else if (request.type === "stop-recording-tab-backup") {
    handleStopRecordingTabBackup(request);
  } else if (request.type === "indexed-db-download") {
    downloadIndexedDB();
  } else if (request.type === "get-platform-info") {
    getPlatformInfo(sendResponse);
    return true;
  } else if (request.type === "restore-recording") {
    restoreRecording();
  } else if (request.type === "check-restore") {
    checkRestore(sendResponse);
    return true;
  } else if (request.type === "check-capture-permissions") {
    chrome.permissions.contains(
      {
        permissions: ["desktopCapture", "alarms", "offscreen"],
      },
      (result) => {
        if (!result) {
          chrome.permissions.request(
            {
              permissions: ["desktopCapture", "alarms", "offscreen"],
            },
            (granted) => {
              if (!granted) {
                sendResponse({ status: "error" });
              } else {
                addAlarmListener();
                sendResponse({ status: "ok" });
              }
            }
          );
        } else {
          sendResponse({ status: "ok" });
        }
      }
    );
    return true;
  } else if (request.type === "is-pinned") {
    isPinned(sendResponse);
    return true;
  } else if (request.type === "save-to-drive") {
    handleSaveToDrive(sendResponse, request, false);
    return true;
  } else if (request.type === "save-to-drive-fallback") {
    handleSaveToDrive(sendResponse, request, true);
    return true;
  } else if (request.type === "request-download") {
    requestDownload(request.base64, request.title);
  } else if (request.type === "resize-window") {
    resizeWindow(request.width, request.height);
  } else if (request.type === "available-memory") {
    checkAvailableMemory(sendResponse);
    return true;
  } else if (request.type === "extension-media-permissions") {
    createTab(
      "chrome://settings/content/siteDetails?site=chrome-extension://" +
        chrome.runtime.id,
      false,
      true
    );
  } else if (request.type === "add-alarm-listener") {
    addAlarmListener();
  }
});

// self.addEventListener("message", (event) => {
//   handleMessage(event.data);
// });

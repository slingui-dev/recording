import React, { useContext, useEffect, useState, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import Plyr from "plyr-react";
import "../../styles/plyr.css";
import { ContentStateContext } from "../../context/ContentState";

import Title from "./Title";

const getExtensionAssetUrl = (path = "") => {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
      return chrome.runtime.getURL(`assets/${path}`);
    }
  } catch {
    // Sandbox pages may not expose chrome.runtime after a hard reload.
  }

  try {
    return new URL(`assets/${path}`, window.location.href).href;
  } catch {
    return `/assets/${path}`;
  }
};

const VideoPlayer = (props) => {
  const [contentState, setContentState] = useContext(ContentStateContext);

  const playerRef = useRef(null);
  const [url, setUrl] = useState(null);
  const [source, setSource] = useState(null);
  const [overlayHost, setOverlayHost] = useState(null);
  const contentStateRef = useRef(contentState);
  const bannerRef = useRef(null);

  useEffect(() => {
    contentStateRef.current = contentState;
  }, [contentState]);

  const getProcessingBannerText = () => {
    const isApplyingMeetingAudio =
      contentStateRef.current.applyingMeetingAudioChunks;
    const base = isApplyingMeetingAudio
      ? "Including meeting audio in the recording..."
      : chrome.i18n.getMessage("processingBannerEditor");
    const pct = Math.round(contentStateRef.current.processingProgress || 0);
    if (pct > 0 && pct < 100) {
      return `${base} (${pct}%)`;
    }
    return base;
  };

  const setProcessingBannerContent = () => {
    if (!bannerRef.current) return;
    bannerRef.current.innerHTML =
      "<img src='" +
      chrome.runtime.getURL("assets/editor/icons/alert-white.svg") +
      "'/> <span>" +
      getProcessingBannerText() +
      "</span>";
  };

  const removeProcessingBanner = () => {
    if (!bannerRef.current) return;
    bannerRef.current.style.display = "none";
    bannerRef.current.remove();
    bannerRef.current = null;
  };

  const ensureProcessingBanner = () => {
    const playerElement = document.querySelector(".plyr--video");
    if (!playerElement || bannerRef.current) return;

    bannerRef.current = document.createElement("div");
    bannerRef.current.classList.add("videoBanner");
    setProcessingBannerContent();
    playerElement.appendChild(bannerRef.current);
  };

  useEffect(() => {
    if (
      playerRef.current &&
      playerRef.current.plyr &&
      contentState.updatePlayerTime
    ) {
      playerRef.current.plyr.currentTime = contentState.time;
    }
  }, [contentState.time]);

  const options = useMemo(
    () => ({
      controls: [
        "play",
        "rewind",
        "fast-forward",
        "progress",
        "current-time",
        "duration",
        "mute",
        "captions",
        "settings",
        "pip",
        "fullscreen",
      ],
      urls: null,
      ratio: "16:9",
      blankVideo: getExtensionAssetUrl("blank.mp4"),
      keyboard: {
        global: true,
      },
    }),
    []
  );

  useEffect(() => {
    if (contentState.webm || contentState.blob) {
      let vid;
      if (contentState.blob) {
        if (!contentState.applyingMeetingAudioChunks) removeProcessingBanner();
        vid = contentState.blob;
      } else if (contentState.webm) {
        vid = contentState.webm;
      }
      const objectURL = URL.createObjectURL(vid);
      // Long recordings can take seconds to parse metadata.
      setContentState((prev) => ({ ...prev, playerLoading: true }));
      setSource({
        type: "video",
        sources: [
          {
            src: objectURL,
            type: contentState.blob ? "video/mp4" : "video/webm",
          },
        ],
      });
      setUrl(objectURL);

      return () => {
        URL.revokeObjectURL(objectURL);
      };
    }
  }, [
    contentState.webm,
    contentState.blob,
    contentState.hasBeenEdited,
    contentState.applyingMeetingAudioChunks,
    playerRef,
  ]);

  // plyr-react ref shape varies; bind directly to <video>. 15s safety
  // timeout in case events never fire.
  useEffect(() => {
    if (!source) return;
    let cleared = false;
    const clear = () => {
      if (cleared) return;
      cleared = true;
      setContentState((prev) =>
        prev.playerLoading ? { ...prev, playerLoading: false } : prev,
      );
    };
    let videoEl = null;
    let safetyId = null;
    let retryId = null;
    let errorSurfaced = false;
    // Corrupt/zero-byte/header-only OPFS file (recorder died before chunks
    // landed, or quota hit past moov) fires MediaError. Without this,
    // playerLoading only clears via the 15s safety timeout, leaving a black
    // <video>. Surface a toast and clear loading immediately.
    const onVideoError = () => {
      if (errorSurfaced) return;
      errorSurfaced = true;
      try {
        chrome.runtime.sendMessage({
          type: "show-toast",
          message: chrome.i18n.getMessage("recordingCorruptToast"),
          timeout: 8000,
        });
      } catch {}
      try {
        chrome.runtime.sendMessage({
          type: "diag-forward",
          event: "editor-video-decode-error",
          data: {
            mediaError: videoEl?.error?.code ?? null,
            mediaErrorMessage:
              String(videoEl?.error?.message || "").slice(0, 120) || null,
            blobSize: contentStateRef.current?.blob?.size ?? null,
          },
        });
      } catch {}
      clear();
    };
    const tryAttach = () => {
      videoEl =
        document.querySelector("#plyr-player") ||
        document.querySelector(".plyr video");
      const plyrEl = document.querySelector(".plyr");
      if (plyrEl) setOverlayHost(plyrEl);
      if (!videoEl) return false;
      videoEl.addEventListener("loadedmetadata", clear);
      videoEl.addEventListener("canplay", clear);
      videoEl.addEventListener("error", onVideoError);
      if (videoEl.readyState >= 1) clear();
      // Error may have already fired pre-attach.
      if (videoEl.error) onVideoError();
      return true;
    };
    if (!tryAttach()) {
      retryId = setTimeout(tryAttach, 50);
    }
    safetyId = setTimeout(clear, 15000);
    return () => {
      if (retryId) clearTimeout(retryId);
      if (safetyId) clearTimeout(safetyId);
      if (videoEl) {
        videoEl.removeEventListener("loadedmetadata", clear);
        videoEl.removeEventListener("canplay", clear);
        videoEl.removeEventListener("error", onVideoError);
      }
      setOverlayHost(null);
    };
  }, [source]);

  useEffect(() => {
    if (
      (contentStateRef.current.mp4ready || contentStateRef.current.blob) &&
      !contentStateRef.current.applyingMeetingAudioChunks
    )
      return;
    const config = { attributes: true, childList: true, subtree: true };

    const callback = function (mutationsList, observer) {
      for (let mutation of mutationsList) {
        const shouldShowInitialProcessing =
          !contentStateRef.current.mp4ready && !contentStateRef.current.blob;
        const shouldShowMeetingAudioProcessing =
          contentStateRef.current.applyingMeetingAudioChunks;

        if (
          document.querySelector(".plyr--video") &&
          (shouldShowInitialProcessing || shouldShowMeetingAudioProcessing) &&
          !bannerRef.current &&
          !contentStateRef.current.noffmpeg &&
          !(
            contentStateRef.current.duration >
              contentStateRef.current.editLimit &&
            !contentStateRef.current.override
          )
        ) {
          ensureProcessingBanner();
        }
      }
    };

    const observer = new MutationObserver(callback);
    observer.observe(document.body, config);

    return () => {
      observer.disconnect();
      removeProcessingBanner();
    };
  }, []);

  useEffect(() => {
    if (contentState.applyingMeetingAudioChunks) {
      ensureProcessingBanner();
      setProcessingBannerContent();
    } else if (contentState.mp4ready || contentState.blob) {
      removeProcessingBanner();
    } else {
      setProcessingBannerContent();
    }
  }, [contentState.processingProgress, contentState.applyingMeetingAudioChunks]);

  return (
    <div className="videoPlayer">
      <div className="playerWrap">
        {url && (
          <Plyr
            ref={playerRef}
            id="plyr-player"
            source={source}
            options={options}
          />
        )}
        {(contentState.playerLoading || contentState.finalizingRecording) &&
          overlayHost &&
          createPortal(
            <div
              className="screenity-player-loading"
              style={{
                position: "absolute",
                inset: 0,
                background: "rgba(0,0,0,0.55)",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 5,
                pointerEvents: "none",
              }}
            >
              <div
                style={{
                  width: "32px",
                  height: "32px",
                  border: "3px solid rgba(255,255,255,0.2)",
                  borderTopColor: "#fff",
                  borderRadius: "50%",
                  animation: "screenity-spin 0.9s linear infinite",
                }}
              />
              {contentState.finalizingRecording && (
                <div
                  style={{
                    color: "#fff",
                    fontSize: "13px",
                    fontWeight: 500,
                    opacity: 0.9,
                  }}
                >
                  {chrome.i18n.getMessage("sandboxFinalizingRecording")}
                </div>
              )}
            </div>,
            overlayHost
          )}
        {contentState.mode === "player" && <Title />}
      </div>
      <style>
        {`
					@media (max-width: 900px) {
						.videoPlayer {
							position: relative!important;
						}
					}
					@keyframes screenity-spin {
						to { transform: rotate(360deg); }
					}
					`}
      </style>
    </div>
  );
};

export default VideoPlayer;

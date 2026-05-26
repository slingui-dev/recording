import React, { useContext, useEffect, useState, useRef, useMemo } from "react";
import Plyr from "plyr-react";
import "../../styles/plyr.css";
import { ContentStateContext } from "../../context/ContentState"; // Import the ContentState context

// Components
import Title from "./Title";

const VideoPlayer = (props) => {
  const [contentState, setContentState] = useContext(ContentStateContext); // Access the ContentState context

  const playerRef = useRef(null);
  const [url, setUrl] = useState(null);
  const [source, setSource] = useState(null);
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
      blankVideo:
        "chrome-extension://" +
        chrome.i18n.getMessage("@@extension_id") +
        "/assets/blank.mp4",
      keyboard: {
        global: true,
      },
    }),
    []
  );

  /*
  useEffect(() => {
    if (contentState.blob) {
      const objectURL = URL.createObjectURL(contentState.blob);
      setSource({
        type: "video",
        sources: [
          {
            src: objectURL,
            type: "video/mp4",
          },
        ],
      });
      setUrl(objectURL);

      return () => {
        URL.revokeObjectURL(objectURL);
      };
    }
  }, [contentState.blob, playerRef]);
	*/

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

  // Use a mutation observer to check if .plyr--video is added to the DOM
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
        {contentState.mode === "player" && <Title />}
      </div>
      <style>
        {`
					@media (max-width: 900px) {
						.videoPlayer {
							position: relative!important;
						}
					}
					`}
      </style>
    </div>
  );
};

export default VideoPlayer;

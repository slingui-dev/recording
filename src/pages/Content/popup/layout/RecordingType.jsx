import React, { useEffect, useContext, useState, useRef } from "react";

import Dropdown from "../components/Dropdown";
import Switch from "../components/Switch";
import Settings from "./Settings";
import { contentStateContext } from "../../context/ContentState";
import { MicOffBlue } from "../../images/popup/images";
import TooltipWrap from "../components/TooltipWrap";

import { AlertIcon, TimeIcon } from "../../toolbar/components/SVG";

const CLOUD_FEATURES_ENABLED =
  process.env.SCREENITY_ENABLE_CLOUD_FEATURES === "true";

const RecordingType = (props) => {
  const [contentState, setContentState] = useContext(contentStateContext);
  const [time, setTime] = useState(0);
  const [URL, setURL] = useState(
    "https://help.screenity.io/getting-started/77KizPC8MHVGfpKpqdux9D/what-are-the-technical-requirements-for-using-screenity/6kdB6qru6naVD8ZLFvX3m9"
  );
  const [URL2, setURL2] = useState(
    "https://help.screenity.io/troubleshooting/9Jy5RGjNrBB42hqUdREQ7W/how-to-grant-screenity-permission-to-record-your-camera-and-microphone/x6U69TnrbMjy5CQ96Er2E9"
  );

  const buttonRef = useRef(null);

  const selectedAudioInput = Array.isArray(contentState.audioInput)
    ? contentState.audioInput.find(
        (device) => device.deviceId === contentState.defaultAudioInput
      )
    : null;
  const hasConfiguredMicrophone = Boolean(
    contentState.microphonePermission &&
      contentState.micActive &&
      contentState.defaultAudioInput !== "none" &&
      selectedAudioInput
  );
  const tabRecordingUnavailableLabel =
    chrome.i18n.getMessage("tabRecordingDisabledToast") ||
    "Tab recording is unavailable on this page.";

  // Opens the right permissions modal based on why access is blocked.
  // When the hosting page's Permissions-Policy header disallows camera or
  // microphone, the usual "click the camera icon in the address bar" advice
  // is wrong (the site is the blocker, not the browser). Route to a
  // site-specific modal in that case.
  const openPermissionsModal = () => {
    if (typeof contentState.openModal !== "function") return;
    if (contentState.sitePermissionsBlocked) {
      contentState.openModal(
        chrome.i18n.getMessage("sitePermissionsBlockedTitle"),
        chrome.i18n.getMessage("sitePermissionsBlockedDescription"),
        null,
        chrome.i18n.getMessage("permissionsModalDismiss"),
        () => {},
        () => {},
        null,
        chrome.i18n.getMessage("learnMoreDot"),
        "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Permissions-Policy",
        true,
        false
      );
      return;
    }
    contentState.openModal(
      chrome.i18n.getMessage("permissionsModalTitle"),
      chrome.i18n.getMessage("permissionsModalDescription"),
      chrome.i18n.getMessage("permissionsModalReview"),
      chrome.i18n.getMessage("permissionsModalDismiss"),
      () => {
        chrome.runtime.sendMessage({
          type: "extension-media-permissions",
        });
      },
      () => {},
      chrome.runtime.getURL("assets/helper/permissions.webp"),
      chrome.i18n.getMessage("learnMoreDot"),
      URL2,
      true,
      false
    );
  };

  useEffect(() => {
    const locale = chrome.i18n.getMessage("@@ui_locale");
    if (!locale.includes("en")) {
      setURL(
        `https://translate.google.com/translate?sl=en&tl=${locale}&u=https://help.screenity.io/getting-started/77KizPC8MHVGfpKpqdux9D/what-are-the-technical-requirements-for-using-screenity/6kdB6qru6naVD8ZLFvX3m9`
      );
      setURL2(
        `https://translate.google.com/translate?sl=en&tl=${locale}&u=https://help.screenity.io/troubleshooting/9Jy5RGjNrBB42hqUdREQ7W/how-to-grant-screenity-permission-to-record-your-camera-and-microphone/x6U69TnrbMjy5CQ96Er2E9`
      );
    }
  }, []);

  useEffect(() => {
    // Convert seconds to mm:ss
    let minutes = Math.floor(contentState.alarmTime / 60);
    let seconds = contentState.alarmTime - minutes * 60;
    if (seconds < 10) {
      seconds = "0" + seconds;
    }
    setTime(minutes + ":" + seconds);
  }, []);

  useEffect(() => {
    // Convert seconds to mm:ss
    let minutes = Math.floor(contentState.alarmTime / 60);
    let seconds = contentState.alarmTime - minutes * 60;
    if (seconds < 10) {
      seconds = "0" + seconds;
    }
    setTime(minutes + ":" + seconds);
  }, [contentState.alarmTime]);

  // Start recording
  const startStreaming = () => {
    if (props.tabRecordingDisabled) {
      contentState.openToast?.(tabRecordingUnavailableLabel, 4000);
      return;
    }

    if (!hasConfiguredMicrophone) {
      contentState.openToast?.(
        chrome.i18n.getMessage("micMutedModalDescription") ||
          chrome.i18n.getMessage("noMicrophoneDropdownLabel") ||
          "Recording will start without microphone audio.",
        4000
      );
    }

    setContentState((prevContentState) => ({
      ...prevContentState,
      recordingType: "region",
      cameraActive: false,
      customRegion: false,
      pushToTalk: false,
    }));
    chrome.storage.local.set({
      recordingType: "region",
      cameraActive: false,
      customRegion: false,
      pushToTalk: false,
    });

    contentState.startStreaming();
  };

  useEffect(() => {
    if (contentState.recording) {
      setContentState((prevContentState) => ({
        ...prevContentState,
        pendingRecording: false,
      }));
    }
  }, [contentState.recording]);

  return (
    <div>
      {contentState.updateChrome && (
        <div className="popup-warning">
          <div className="popup-warning-left">
            <AlertIcon />
          </div>
          <div className="popup-warning-middle">
            <div className="popup-warning-title">
              {chrome.i18n.getMessage("customAreaRecordingDisabledTitle")}
            </div>
            <div className="popup-warning-description">
              {chrome.i18n.getMessage("customAreaRecordingDisabledDescription")}
            </div>
          </div>
          <div className="popup-warning-right">
            <a href={URL} target="_blank">
              {chrome.i18n.getMessage("customAreaRecordingDisabledAction")}
            </a>
          </div>
        </div>
      )}
      {/*contentState.offline && (
        <div className="popup-warning">
          <div className="popup-warning-left">
            <NoInternet />
          </div>
          <div className="popup-warning-middle">
            <div className="popup-warning-title">You are currently offline</div>
            <div className="popup-warning-description">
              Some features are unavailable
            </div>
          </div>
          <div className="popup-warning-right">
            <a href="#">Try again</a>
          </div>
        </div>
			)*/}
      {props.tabRecordingDisabled && !contentState.offline && (
        <div className="popup-warning">
          <div className="popup-warning-left">
            <AlertIcon />
          </div>
          <div className="popup-warning-middle">
            <div className="popup-warning-title">
              {chrome.i18n.getMessage("tabRecordingDisabledTooltip") ||
                tabRecordingUnavailableLabel}
            </div>
            <div className="popup-warning-description">
              {chrome.i18n.getMessage("tabRecordingDisabledToast") ||
                "Tab area recording cannot be started from this page."}
            </div>
          </div>
        </div>
      )}

      {!contentState.microphonePermission && (
        <button
          className="permission-button"
          onClick={openPermissionsModal}
        >
          <img src={MicOffBlue} />
          <span>{chrome.i18n.getMessage("allowMicrophoneAccessButton")}</span>
        </button>
      )}
      {contentState.microphonePermission && (
        <Dropdown type="mic" shadowRef={props.shadowRef} />
      )}
      {contentState.microphonePermission &&
        contentState.defaultAudioInput != "none" &&
        contentState.micActive && (
        <div>
          <iframe
            className="screenity-iframe"
            style={{
              width: "100%",
              height: "30px",
              zIndex: 999999,
              position: "relative",
            }}
            allow="camera; microphone"
            src={chrome.runtime.getURL("waveform.html")}
          ></iframe>
        </div>
      )}
      {contentState.isLoggedIn &&
        !contentState.recordingToScene &&
        // Instant mode bakes the whole recording into one non-editable
        // video, incompatible with multi-scene composition. Hide the
        // toggle while multi is on.
        !contentState.multiMode &&
        CLOUD_FEATURES_ENABLED && (
          <>
            <div className="popup-content-divider"></div>
            <TooltipWrap
              id="pro-onboarding-instant-mode-field"
              content={
                chrome.i18n.getMessage("instantRecordingModeTooltip") ||
                "Instant download, but camera and layout won’t be editable later."
              }
              side="bottom"
              sideOffset={2}
            >
              <div style={{ pointerEvents: "auto" }}>
                <Switch
                  label={
                    chrome.i18n.getMessage("instantRecordingModeLabel") ||
                    "Instant recording mode"
                  }
                  name="instantMode"
                  value="instantMode"
                  anchorId="pro-onboarding-instant-mode-toggle"
                  rowAnchorId="pro-onboarding-instant-mode-toggle-row"
                  onChange={async (checked) => {
                    if (checked) {
                      contentState.openModal(
                        chrome.i18n.getMessage("instantRecordingModeTitle") ||
                          "Instant recording mode",
                        chrome.i18n.getMessage(
                          "instantRecordingModeDescription"
                        ) ||
                          "This records everything into one video for instant download and sharing. You won’t be able to change the camera layout afterward, but other edits are still possible.",
                        chrome.i18n.getMessage("instantRecordingModeAction") ||
                          "Got it",
                        chrome.i18n.getMessage("permissionsModalDismiss") ||
                          "Dismiss",
                        () => {},
                        () => {},
                        null,
                        "",
                        "",
                        true,
                        false
                      );
                    } else {
                      // Turn off background effects in chrome.storage
                      chrome.storage.local.set({
                        backgroundEffectsActive: false,
                      });

                      // Update in memory
                      setContentState((prev) => ({
                        ...prev,
                        backgroundEffectsActive: false,
                      }));
                    }
                  }}
                />
              </div>
            </TooltipWrap>
          </>
        )}
      <button
        role="button"
        className="main-button recording-button"
        ref={buttonRef}
        tabIndex="0"
        onClick={startStreaming}
        disabled={
          contentState.pendingRecording ||
          props.tabRecordingDisabled
        }
      >
        {contentState.alarm && contentState.alarmTime > 0 && (
          <div className="alarm-time-button">
            <TimeIcon />
            {time}
          </div>
        )}
        <span className="main-button-label">
          {contentState.pendingRecording
            ? chrome.i18n.getMessage("recordButtonInProgressLabel")
            : props.tabRecordingDisabled
            ? chrome.i18n.getMessage("tabRecordingDisabledTooltip") ||
              tabRecordingUnavailableLabel
            : contentState.multiMode && contentState.multiSceneCount > 0
            ? chrome.i18n.getMessage("recordButtonMultiLabel")
            : chrome.i18n.getMessage("recordButtonLabel")}
        </span>
        <span className="main-button-shortcut">
          {contentState.recordingShortcut}
        </span>
      </button>
      <Settings />
    </div>
  );
};

export default RecordingType;

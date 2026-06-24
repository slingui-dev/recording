import React, { useEffect, useState, useContext } from "react";
import * as Tabs from "@radix-ui/react-tabs";

import RecordingType from "./RecordingType";
import {
  RegionTabOn,
  RegionTabOff,
  CheckWhiteIcon,
  CloseWhiteIcon,
} from "../../images/popup/images";

import TooltipWrap from "../components/TooltipWrap";

// Context
import { contentStateContext } from "../../context/ContentState";

const RecordingTab = (props) => {
  const ACCOUNTS_URL = "https://accounts.slingui.com";
  const openAccounts = (event) => {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    window.open(ACCOUNTS_URL, "_blank", "noopener,noreferrer");
  };
  const [contentState, setContentState] = useContext(contentStateContext);

  const [tabRecordingDisabled, setTabRecordingDisabled] = useState(false);
  const [showModalSoon, setShowModalSoon] = useState(false); // 👈 NEW

  useEffect(() => {
    setContentState((prev) => ({
      ...prev,
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
    chrome.runtime.sendMessage({ type: "screen-update" });
  }, []);

  useEffect(() => {
    const currentUrl = window.location.href;
    const isBlocked = currentUrl.includes(process.env.SCREENITY_APP_BASE);

    setTabRecordingDisabled(isBlocked);
  }, []);

  const onValueChange = (tab) => {
    if (tab !== "region") return;

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

    chrome.runtime.sendMessage({ type: "screen-update" });
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") setShowModalSoon(false);
    };
    if (showModalSoon) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showModalSoon]);

  return (
    <div className="recording-ui">
      <Tabs.Root
        className="TabsRoot"
        defaultValue="region"
        onValueChange={onValueChange}
        value="region"
      >
        {contentState.recordingToScene && (
          <div className="projectActiveBanner">
            <div className="projectActiveBannerLeft">
              {chrome.i18n.getMessage("addingToLabel") || "Adding to: "}
              {contentState.recordingProjectTitle}
            </div>
            <div className="projectActiveBannerRight">
              <div className="projectActiveBannerDivider"></div>
              <div
                className="projectActiveBannerClose"
                onClick={() => {
                  setContentState((prev) => ({
                    ...prev,
                    projectTitle: "",
                    projectId: null,
                    activeSceneId: null,
                    recordingToScene: false,
                    multiMode: false,
                    multiSceneCount: 0,
                    multiProjectId: null,
                  }));

                  chrome.storage.local.set({
                    recordingProjectTitle: "",
                    projectId: null,
                    activeSceneId: null,
                    recordingToScene: false,
                    multiMode: false,
                    multiSceneCount: 0,
                    multiProjectId: null,
                    multiLastSceneId: null,
                  });

                  contentState.openToast(
                    chrome.i18n.getMessage("projectRecordingCancelledToast"),
                    3000
                  );
                }}
              >
                <img src={CloseWhiteIcon} alt="Close" />
              </div>
            </div>
          </div>
        )}
        <Tabs.List
          className={"TabsList"}
          aria-label="Manage your account"
          tabIndex={0}
        >
          <TooltipWrap
            content={
              tabRecordingDisabled
                ? chrome.i18n.getMessage("tabRecordingDisabledTooltip") ||
                  "Tab recording is disabled on this page."
                : ""
            }
            side={"bottom"}
          >
            <Tabs.Trigger
              className="TabsTrigger"
              value="region"
              tabIndex={0}
              disabled={tabRecordingDisabled}
              onClick={(e) => {
                if (tabRecordingDisabled) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }}
              style={
                tabRecordingDisabled
                  ? { cursor: "not-allowed", opacity: 0.5 }
                  : {}
              }
            >
              <div className="TabsTriggerLabel">
                <div className="TabsTriggerIcon">
                  <img src={RegionTabOn || RegionTabOff} />
                </div>
                <span>{chrome.i18n.getMessage("tabType")}</span>
              </div>
            </Tabs.Trigger>
          </TooltipWrap>
          <div className="TabsTriggerSpacer"></div>
          <div className="TabsTrigger">
            <TooltipWrap
              content={
                !contentState.isLoggedIn
                  ? "Record multiple scenes with Screenity Pro"
                  : "Record scenes one after another"
              }
              side={"bottom"}
            >
              <div
                className="TabsTriggerLabel"
                style={{
                  opacity: 1,
                  cursor: "pointer",
                }}
                onClick={openAccounts}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    openAccounts(event);
                  }
                }}
              >
                <div
                  className="TabsTriggerIcon"
                  style={{
                    width: "33px",
                    position: "relative", // For the badge positioning
                    pointerEvents: "auto",
                  }}
                >
                  {contentState.multiMode &&
                  contentState.multiSceneCount > 0 ? (
                    <div
                      className="FinishButton"
                      onClick={() => {
                        // Send finish message to background to finalize multi project
                        chrome.runtime.sendMessage({
                          type: "finish-multi-recording",
                        });
                        setContentState((prev) => ({
                          ...prev,
                          showExtension: false,
                          hasOpenedBefore: true,
                          showPopup: false,
                        }));
                      }}
                      style={{
                        cursor: "pointer",
                        width: "28px",
                        height: "28px",
                        background: "#0a3b6e",
                        borderRadius: "50%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <img
                        src={CheckWhiteIcon}
                        alt="Finish"
                        style={{ width: "13px", height: "13px" }}
                      />
                      <div
                        style={{
                          position: "absolute",
                          top: "-7px",
                          left: "-7px",
                          background: "#78C072",
                          color: "white",
                          fontSize: "12px",
                          fontWeight: "bold",
                          borderRadius: "50%",
                          width: "18px",
                          height: "18px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {contentState.multiSceneCount}
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      aria-label="Go to Slingui accounts"
                      onClick={openAccounts}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      style={{
                        width: "28px",
                        height: "28px",
                        borderRadius: "999px",
                        border: "1px solid #D7DCE5",
                        background: "#FFFFFF",
                        color: "#0a3b6e",
                        fontSize: "14px",
                        fontWeight: 700,
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: 0,
                      }}
                    >
                      ↗
                    </button>
                  )}
                </div>
                <span>
                  {contentState.multiMode && contentState.multiSceneCount > 0
                    ? chrome.i18n.getMessage("finishLabelMulti") || "Finish"
                    : "Slingui"}
                </span>
              </div>
            </TooltipWrap>
          </div>
          {/* <Tabs.Trigger
            className="TabsTrigger"
            value="mockup"
            tabIndex={0}
            disabled
            style={{ pointerEvents: "none", opacity: 0.5 }}
          >
            <div className="TabsTriggerLabel">
              <div className="TabsTriggerIcon">
                <img
                  src={
                    contentState.recordingType === "mockup"
                      ? MockupTabOn
                      : MockupTabOff
                  }
                />
              </div>
              <span>{chrome.i18n.getMessage("MockupType")}</span>
            </div>
          </Tabs.Trigger> */}
        </Tabs.List>

        {showModalSoon && (
          <div
            className="ModalSoon strong"
            style={{
              zIndex: 999999999999,
            }}
          >
            <button
              aria-label="Close"
              onClick={() => setShowModalSoon(false)}
              style={{
                position: "absolute",
                top: -10,
                right: -10,
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: "rgb(252 252 252)",
                border: "1px solid #E2E8F0",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
                cursor: "pointer",
              }}
            >
              <img
                src={CloseWhiteIcon}
                alt=""
                style={{ width: 14, height: 14, filter: "invert(0.4)" }}
              />
            </button>
            {/* 👇 Embed the video here */}
            <video
              src={chrome.runtime.getURL("assets/videos/pro.mp4")}
              autoPlay
              loop
              muted
              playsInline
              style={{
                width: "100%",
                borderRadius: "6px",
                marginBottom: "20px",
              }}
            />
            <div className="ModalSoonTitle">
              {chrome.i18n.getMessage("shareModalSandboxTitle")}
            </div>

            <div className="ModalSoonDescription">
              {chrome.i18n.getMessage("shareModalSandboxDescription")}
            </div>

            <div
              className="ModalSoonButton"
              onClick={() => {
                chrome.runtime.sendMessage({ type: "pricing" });
              }}
            >
              {chrome.i18n.getMessage("shareModalSandboxButton")}
            </div>

            <button
              onClick={() => {
                chrome.runtime.sendMessage({ type: "handle-login" });
              }}
              className="ModalSoonSecondary"
              style={{
                marginTop: 16,
                width: "100%",
                background: "transparent",
                border: "none",
                color: "#6B7280",
                fontSize: 13,
                textAlign: "center",
                cursor: "pointer",
              }}
            >
              {chrome.i18n.getMessage("shareModalSandboxLogin")}
            </button>
          </div>
        )}
        <Tabs.Content className="TabsContent" value="region">
          <RecordingType
            shadowRef={props.shadowRef}
            tabRecordingDisabled={tabRecordingDisabled}
          />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
};

export default RecordingTab;

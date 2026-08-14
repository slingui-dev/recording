import React from "react";
// import EditorPreview from "../../../../assets/editor-preview.png"; // replace with actual screenshot file

const Welcome = (props) => {
  const isUpdated = props.isBack;
  const clearBack = props.clearBack;

  const handleUse = () => {
    if (isUpdated) clearBack();
    props.setOnboarding(false);
    props.setContentState((prev) => ({
      ...prev,
      onboarding: false,
    }));
    chrome.storage.local.set({ onboarding: false });
  };

  return (
    <div
      className="announcement"
      style={{
        marginTop: "50px",
        paddingBottom: "0px",
      }}
    >
      <div className="announcement-wrap">
        <div className="announcement-details">
          <div className="welcome-title">
            {!isUpdated
              ? chrome.i18n.getMessage("welcomePopupTitle")
              : chrome.i18n.getMessage("welcomeBackPopupTitle")}
          </div>
          <div className="welcome-description">
            {chrome.i18n.getMessage("welcomePopupDescriptionTop")}
            <br />
            {chrome.i18n.getMessage("welcomePopupDescriptionBottom")}
          </div>
          <div className="welcome-actions">
            <button type="button" className="welcome-cta" onClick={handleUse}>
              👋 {chrome.i18n.getMessage("welcomePopupCTA")}
            </button>
            <a
              href={process.env.SCREENITY_APP_BASE || "https://slingui.com"}
              target="_blank"
              rel="noopener noreferrer"
              className="main-button dashboard-button"
            >
              <span className="main-button-label">
                {chrome.i18n.getMessage("goToDashboardButtonLabel") ||
                  "Go to Slingui"}
              </span>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Welcome;

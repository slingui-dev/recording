import "./styles/edit/_VideoPlayer.scss";
import "./styles/global/_app.scss";

import React, {
  useEffect,
  useRef,
  useContext,
  useState,
  Suspense,
  lazy,
} from "react";
// Editor (trim/cut/timeline UI) only mounts when user enters edit mode.
// Initial open is "player" mode; defer Editor + its TrimUI dependencies.
const Editor = lazy(() => import("./layout/editor/Editor"));
import Player from "./layout/player/Player";
import Modal from "./components/global/Modal";
import Toast from "./components/global/Toast";

import HelpButton from "./components/player/HelpButton";
import RecordingInfo from "./components/player/RecordingInfo";
import ReviewBanner from "./components/global/ReviewBanner";
import DevHUD from "./DevHUD";
import AuthRequiredDialog from "./components/global/AuthRequiredDialog";

import { ContentStateContext } from "./context/ContentState";
import { diagForward } from "../utils/diagForward";
import { triggerSupportDownload } from "../utils/triggerSupportDownload";
import GradientBackground from "../Components/GradientBackground";

const EditorApp = () => {
  const [contentState, setContentState] = useContext(ContentStateContext);
  const parentRef = useRef(null);
  const progress = useRef("");
  const [syncEscapeAvailable, setSyncEscapeAvailable] = useState(false);
  const [syncOverlayDismissed, setSyncOverlayDismissed] = useState(false);

  // `ready` means that a playable video exists, not that the recording is
  // fully recovered. Keep the editor covered while auth, chunk download, or
  // the meeting-audio mix is still in progress.
  const meetingAudioStatus = contentState.meetingAudioChunksStatus;

  const meetingAudioSyncPending =
    window.top === window.self &&
    !contentState.meetingAudioSyncSkipped &&
    !["empty", "failed", "missing-context", "ready"].includes(
      meetingAudioStatus,
    );
  const editorLoading =
    !contentState.ready ||
    (meetingAudioSyncPending && !syncOverlayDismissed);

  useEffect(() => {
    if (
      !meetingAudioSyncPending ||
      !contentState.ready
    ) {
      setSyncEscapeAvailable(false);
      setSyncOverlayDismissed(false);
      return undefined;
    }

    setSyncEscapeAvailable(false);
    setSyncOverlayDismissed(false);
    const timer = setTimeout(() => setSyncEscapeAvailable(true), 50_000);
    return () => clearTimeout(timer);
  }, [meetingAudioSyncPending, contentState.ready]);

  const getChromeVersion = () => {
    var raw = navigator.userAgent.match(/Chrom(e|ium)\/([0-9]+)\./);

    return raw ? parseInt(raw[2], 10) : false;
  };

  useEffect(() => {
    const MIN_CHROME_VERSION = 110;
    const chromeVersion = getChromeVersion();

    if (chromeVersion && chromeVersion > MIN_CHROME_VERSION) {
      contentState.loadFFmpeg();
    } else {
      setContentState((prevState) => ({
        ...prevState,
        updateChrome: true,
        ffmpeg: true,
      }));
    }
  }, []);

  useEffect(() => {
    if (!contentState.blob || !contentState.ffmpeg) return;
    if (contentState.frame) return;
    contentState.getFrame();
  }, [contentState.blob, contentState.ffmpeg]);

  useEffect(() => {
    if (!parentRef) return;
    if (!parentRef.current) return;

    const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    if (isMac) return;

    const parentDiv = parentRef.current;

    const elements = parentDiv.querySelectorAll("*");
    elements.forEach((element) => {
      element.classList.add("screenity-scrollbar");
    });

    const observer = new MutationObserver((mutationsList) => {
      for (const mutation of mutationsList) {
        if (mutation.type === "childList") {
          const addedNodes = Array.from(mutation.addedNodes);
          const removedNodes = Array.from(mutation.removedNodes);

          addedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              node.classList.add("screenity-scrollbar");
            }
          });

          removedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              node.classList.remove("screenity-scrollbar");
            }
          });
        }
      }
    });

    observer.observe(parentDiv, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
    };
  }, [parentRef.current]);

  useEffect(() => {
    if (contentState.chunkCount > 0) {
      progress.current = `(${Math.min(
        100,
        Math.round((contentState.chunkIndex / contentState.chunkCount) * 100),
      )}%)`;
    }
  }, [contentState.chunkIndex, contentState.chunkCount]);

  // Review prompt and Pro banner share the slot and are mutually exclusive, so
  // only check Pro-banner support when the review prompt won't show (avoids a
  // flash). `?reviewPreview=1` (or =review / =feedback) forces it open for design.
  useEffect(() => {
    const reviewPreview = new URLSearchParams(window.location.search).get(
      "reviewPreview",
    );
    if (reviewPreview !== null) {
      setContentState((prev) => ({ ...prev, reviewPrompt: true }));
      return;
    }
    const checkBannerSupport = () => {
      chrome.runtime.sendMessage({ type: "check-banner-support" }, (response) => {
        if (response && response.bannerSupport) {
          setContentState((prev) => ({ ...prev, bannerSupport: true }));
        }
      });
    };
    chrome.runtime.sendMessage({ type: "check-review-prompt" }, (response) => {
      if (response && response.showReview) {
        // Eligible, but wait for the interaction gate below before showing.
        setContentState((prev) => ({ ...prev, reviewEligible: true }));
      } else {
        checkBannerSupport();
      }
    });
  }, []);

  // Show the review banner once the editor is ready: a ~3s settle so it never
  // appears over a loading or broken result, or instantly on any interaction.
  // The failed/degraded/salvaged suppression keeps it safe.
  useEffect(() => {
    if (!contentState.reviewEligible) return;
    if (!contentState.ready) return;
    if (contentState.reviewPrompt) return;
    // `ready` only means a playable video is showing. Don't appear over a
    // failed recording or while a transcode/processing is still running.
    if (contentState.recordingFailed) return;
    if (contentState.isFfmpegRunning) return;
    if (contentState.processingProgress > 0) return;

    let revealed = false;
    const reveal = () => {
      if (revealed) return;
      revealed = true;
      cleanup();
      setContentState((prev) => ({ ...prev, reviewPrompt: true }));
    };
    const onInteract = () => reveal();

    // Arm interaction listeners almost immediately so a download/save click
    // shows it right away; the tiny delay just skips a stray load-time click.
    const armTimer = setTimeout(() => {
      document.addEventListener("pointerdown", onInteract);
      document.addEventListener("keydown", onInteract);
    }, 800);
    // Passive backstop: settle a few seconds after the result is ready.
    const revealTimer = setTimeout(reveal, 3000);

    function cleanup() {
      clearTimeout(armTimer);
      clearTimeout(revealTimer);
      document.removeEventListener("pointerdown", onInteract);
      document.removeEventListener("keydown", onInteract);
    }
    return cleanup;
  }, [
    contentState.reviewEligible,
    contentState.ready,
    contentState.reviewPrompt,
    contentState.recordingFailed,
    contentState.isFfmpegRunning,
    contentState.processingProgress,
  ]);

  useEffect(() => {
    if (
      contentState.mode === "crop" &&
      contentState.getFrame &&
      contentState.blob &&
      contentState.ffmpeg
    ) {
      // Let state updates propagate first.
      setTimeout(() => {
        contentState.getFrame();
      }, 50);
    }
  }, [contentState.mode]);

  return (
    <div ref={parentRef}>
      <RecordingInfo contentState={contentState} />
      <DevHUD
        setContentState={setContentState}
        contentStateRef={{ current: contentState }}
        lastDownloadInfo={contentState.lastDownloadInfo}
        lastRecordingBackend={contentState.lastRecordingBackend}
        contentState={contentState}
      />
      <Modal />
      <Toast />
      <AuthRequiredDialog
        contentState={contentState}
        onSkipSync={() =>
          setContentState((prev) => ({
            ...prev,
            meetingAudioSyncSkipped: true,
          }))
        }
      />
      <video></video>
      {contentState.ffmpeg &&
        contentState.ready &&
        contentState.mode === "edit" && (
          <Suspense fallback={null}>
            <Editor />
          </Suspense>
        )}
      {contentState.mode != "edit" && contentState.ready && <Player />}
      {!contentState.ready &&
        new URLSearchParams(window.location.search).get("reviewPreview") !==
          null && <ReviewBanner />}
      {editorLoading && (
        <div
          className="wrap"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2147483000,
            pointerEvents: "none",
          }}
        >
          <img className="logo" src="/assets/logo-text.svg" />
          <div className="middle-area">
            <img src="/assets/record-tab-active.svg" />
            <div className="title">
              {contentState.ready && meetingAudioSyncPending
                ? "Sincronizando sua gravação…"
                : chrome.i18n.getMessage("sandboxProgressTitle") +
                  " " +
                  (contentState.processingProgress > 0
                    ? `(${Math.round(contentState.processingProgress)}%)`
                    : progress.current)}
            </div>
            <div className="subtitle">
              {contentState.ready && meetingAudioSyncPending
                ? "Aguarde enquanto carregamos os dados da aula e o áudio da reunião. O editor será liberado quando tudo estiver pronto."
                : chrome.i18n.getMessage("sandboxProgressDescription")}
            </div>
            {contentState.ready &&
              meetingAudioSyncPending &&
              syncEscapeAvailable && (
                <div className="sync-escape" role="status" aria-live="polite">
                  <div className="sync-escape-message">
                    <p>A sincronização está demorando mais do que o esperado.</p>
                    <p>
                      Isso acontece quando é necessário processar o áudio do
                      compartilhamento de tela no modo &quot;Janela&quot; ou &quot;Tela
                      inteira&quot;.
                    </p>
                    <p>O que você pode fazer:</p>
                    <ul>
                      <li>
                        <strong>Deixar essa aba aberta e aguardar o processamento:</strong>{" "}
                        Assim, você garante que todos os áudios serão reproduzidos
                        corretamente na sua gravação.
                      </li>
                      <li>
                        <strong>Iniciar o carregamento novamente em outro momento:</strong>{" "}
                        Você pode usar a opção de &quot;Recuperar a última gravação&quot;
                        no menu da extensão, para iniciar esse mesmo carregamento
                        em outro momento. Atenção: caso seja feita uma nova
                        gravação, essa será perdida.
                      </li>
                      <li><strong>Reportar ao suporte.</strong></li>
                    </ul>
                  </div>
                  <div className="sync-escape-actions">
                    <button
                      type="button"
                      className="sync-escape-primary"
                      onClick={() => {
                        diagForward("meeting-audio-sync-overlay-dismissed", {
                          action: "ok",
                          status: meetingAudioStatus || null,
                        });
                        setSyncOverlayDismissed(true);
                      }}
                    >
                      OK
                    </button>
                  </div>
                </div>
              )}
            {typeof contentState.openModal === "function" && (
              <div
                className="button-stop"
                style={{ pointerEvents: "auto" }}
                onClick={() => {
                  diagForward("sandbox-user-clicked-help", {
                    chunkCount: contentState?.chunkCount ?? 0,
                    chunkIndex: contentState?.chunkIndex ?? 0,
                    hasRawBlob: Boolean(contentState?.rawBlob),
                    hasBlob: Boolean(contentState?.blob),
                    ready: Boolean(contentState?.ready),
                  });
                  contentState.openModal(
                    chrome.i18n.getMessage("havingIssuesModalTitle"),
                    chrome.i18n.getMessage("havingIssuesModalDescription"),
                    chrome.i18n.getMessage("restoreRecording"),
                    chrome.i18n.getMessage("havingIssuesModalButton2"),
                    () => {
                      chrome.runtime.sendMessage({ type: "restore-recording" });
                    },
                    () => {
                      triggerSupportDownload({ source: "sandbox-report-bug" });
                      chrome.runtime.sendMessage({ type: "report-bug", zipBundled: true });
                    },
                    null,
                    null,
                    null,
                    false,
                    chrome.i18n.getMessage("getHelpButton"),
                    () => {
                      triggerSupportDownload({ source: "processing-stuck" });
                      chrome.runtime.sendMessage({
                        type: "report-error",
                        source: "processing-stuck",
                        zipBundled: true,
                      });
                    },
                  );
                }}
              >
                {chrome.i18n.getMessage("havingIssuesButton")}
              </div>
            )}
          </div>
          <HelpButton />
          <GradientBackground />
        </div>
      )}
      <style>
        {`
				
          .recording-info {
            position: fixed;
            top: 14px;
            right: 14px;
            z-index: 2147483000;
            font-family: Satoshi-Medium, sans-serif;
          }
          .recording-info-button, .recording-info-copy {
            border: 1px solid #dce4df;
            border-radius: 10px;
            background: #fff;
            color: #205d3a;
            padding: 8px 12px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            box-shadow: 0 3px 12px rgba(25, 65, 42, .12);
          }
          .recording-info-button:hover, .recording-info-copy:hover {
            background: #edf8f0;
          }
          .recording-info-syncing {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
            padding: 9px 11px;
            border: 1px solid #b9e4c5;
            border-radius: 10px;
            background: #f0fdf4;
            color: #166534;
            font-size: 12px;
            font-weight: 600;
            box-shadow: 0 3px 12px rgba(25, 65, 42, .12);
          }
          .recording-info-spinner {
            width: 12px;
            height: 12px;
            flex: 0 0 12px;
            border: 2px solid #b9e4c5;
            border-top-color: #23834b;
            border-radius: 50%;
            animation: recording-info-spin .8s linear infinite;
          }
          @keyframes recording-info-spin { to { transform: rotate(360deg); } }
          .recording-info-panel {
            width: 290px;
            margin-top: 8px;
            padding: 14px;
            border: 1px solid #dce4df;
            border-radius: 14px;
            background: #fff;
            color: #243128;
            box-shadow: 0 12px 30px rgba(24, 54, 35, .2);
            font-size: 12px;
          }
          .recording-info-title {
            color: #23834b;
            font-size: 14px;
            font-weight: 700;
            margin-bottom: 10px;
          }
          .recording-info-grid {
            display: grid;
            grid-template-columns: 92px 1fr;
            gap: 7px 9px;
            overflow-wrap: anywhere;
          }
          .recording-info-grid span { color: #718077; }
          .recording-info-grid strong { font-weight: 600; }
          .recording-info-error { color: #b42318; }
          .recording-info-copy { margin-top: 12px; width: 100%; }
          .wrap {
					overflow: hidden;
				}
          .sync-escape {
            width: min(440px, calc(100% - 40px));
            margin: -8px auto 16px;
            padding: 14px;
            border: 1px solid #dce4df;
            border-radius: 12px;
            background: #fff;
            box-shadow: 0 8px 24px rgba(25, 65, 42, .12);
            color: #526074;
            font-size: 13px;
            line-height: 1.45;
            text-align: center;
            pointer-events: auto;
          }
          .sync-escape-actions {
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            gap: 8px;
            margin-top: 12px;
          }
          .sync-escape-actions button {
            border-radius: 9px;
            padding: 9px 12px;
            font: inherit;
            font-weight: 600;
            cursor: pointer;
          }
          .sync-escape-primary {
            border: 1px solid #16834b;
            background: #16834b;
            color: #fff;
          }
          .sync-escape-secondary {
            border: 1px solid #d4dbe5;
            background: #fff;
            color: #526074;
          }
				.button-stop {
					padding: 10px 20px;
					background: #FFF;
					border-radius: 30px;
					color: #29292F;
					font-size: 14px;
					font-weight: 500;
					cursor: pointer;
					margin-top: 0px;
					border: 1px solid #E8E8E8;
					margin-left: auto;
					margin-right: auto;
					z-index: 999999;
				}

				.logo {
					position: absolute;
					bottom: 30px;
					left: 0px;
					right: 0px;
					margin: auto;
					width: 120px;
				}
				.wrap {
					position: absolute;
					top: 0;
					left: 0;
					width: 100%;
					height: 100%;
					background-color: #F6F7FB;
					isolation: isolate;
				}
					.middle-area {
						display: flex;
						flex-direction: column;
						align-items: center;
						justify-content: center;
						height: 100%;
						font-family: Satoshi Medium, sans-serif;
					}
					.middle-area img {
						width: 40px;
						margin-bottom: 20px;
					}
					.title {
						font-size: 24px;
						font-weight: 700;
						color: #1A1A1A;
						margin-bottom: 14px;
						font-family: Satoshi-Medium, sans-serif;
						text-align: center;
					}
					.subtitle {
						font-size: 14px;
						font-weight: 400;
						color: #6E7684;
						margin-bottom: 24px;
						font-family: Satoshi-Medium, sans-serif;
						text-align: center;
					}


.screenity-scrollbar *::-webkit-scrollbar, .screenity-scrollbar::-webkit-scrollbar {
  background-color: rgba(0,0,0,0);
  width: 16px;
  height: 16px;
  z-index: 999999;
}
.screenity-scrollbar *::-webkit-scrollbar-track, .screenity-scrollbar::-webkit-scrollbar-track {
  background-color: rgba(0,0,0,0);
}
.screenity-scrollbar *::-webkit-scrollbar-thumb, .screenity-scrollbar::-webkit-scrollbar-thumb {
  background-color: rgba(0,0,0,0);
  border-radius:16px;
  border:0px solid #fff;
}
.screenity-scrollbar *::-webkit-scrollbar-button, .screenity-scrollbar::-webkit-scrollbar-button {
  display:none;
}
.screenity-scrollbar *:hover::-webkit-scrollbar-thumb, .screenity-scrollbar:hover::-webkit-scrollbar-thumb {
  background-color: #a0a0a5;
  border:4px solid #fff;
}
::-webkit-scrollbar-thumb *:hover, ::-webkit-scrollbar-thumb:hover {
    background-color:#a0a0a5;
    border:4px solid #f4f4f4
}
.videoBanner {
	height: 40px!important;
	width: 100%!important;
	position: absolute!important;
	top: 0px!important;
	left: 0px!important;
	background-color: #0a3b6e!important;
	color: #FFF!important;
	font-family: "Satoshi-Medium"!important;
	z-index: 99999999999!important;
	text-align: center!important;
	display: flex!important;
	align-items: center!important;
	justify-content: center!important;
	flex-direction: row!important;
	gap: 6px!important;
}
					
					`}
      </style>
    </div>
  );
};

export default EditorApp;

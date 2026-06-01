import React, { useContext, useEffect, useState, useRef } from "react";
import styles from "../../styles/player/_RightPanel.module.scss";

import { buildDiagnosticZip } from "../../../utils/buildDiagnosticZip";

import { ReactSVG } from "react-svg";

import { login, logout, getUser } from "../../../../utils/slingui-auth";

const EXT_URL =
  "chrome-extension://" + chrome.i18n.getMessage("@@extension_id") + "/assets/";

import CropUI from "../editor/CropUI";
import AudioUI from "../editor/AudioUI";

import { ContentStateContext } from "../../context/ContentState";

const RightPanel = () => {
  const [contentState, setContentState] = useContext(ContentStateContext);
  const [slingUser, setSlingUser] = useState(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const contentStateRef = useRef(contentState);
  const consoleErrorRef = useRef([]);
  const authAttemptedRef = useRef(false);

  useEffect(() => {
    console.error = (error) => {
      consoleErrorRef.current.push(error);
    };

    const authenticateOnLoad = async () => {
      if (authAttemptedRef.current) return;
      authAttemptedRef.current = true;
      setIsAuthLoading(true);

      try {
        const storedUser = await getUser();
        if (storedUser && !storedUser.expired) {
          setSlingUser(storedUser);
          return;
        }

        setSlingUser(null);
      } catch (error) {
        console.error("Failed to read Slingui authentication on load:", error);
        setSlingUser(null);
      } finally {
        setIsAuthLoading(false);
      }
    };
    authenticateOnLoad();

    const handleSlingUserChange = async (changes, areaName) => {
      if (areaName !== "local" || !changes.user) return;

      const storedUser = await getUser();
      setSlingUser(storedUser && !storedUser.expired ? storedUser : null);
    };

    chrome.storage.onChanged.addListener(handleSlingUserChange);

    return () => {
      chrome.storage.onChanged.removeListener(handleSlingUserChange);
    };

  }, []);

  useEffect(() => {
    contentStateRef.current = contentState;
  }, [contentState]);

  const getNotAvailableLabel = () => {
    if (contentState.fallback && contentState.noffmpeg && contentState.editLimit === 0) {
      return chrome.i18n.getMessage("notAvailableLongRecording");
    }
    if (contentState.fallback && contentState.noffmpeg) {
      return chrome.i18n.getMessage("notAvailableRecoveryMode");
    }
    return chrome.i18n.getMessage("notAvailableLabel");
  };

  const getPreparingLabel = () => {
    const base = chrome.i18n.getMessage("preparingLabel");
    const pct = Math.round(contentState.processingProgress || 0);
    if (!contentState.mp4ready && pct > 0) {
      return `${base} (${pct}%)`;
    }
    return base;
  };

  const getSlingUserDisplayName = (user) => {
    const profile = user?.profile || {};
    return (
      profile.name ||
      [profile.given_name, profile.family_name].filter(Boolean).join(" ") ||
      profile.preferred_username ||
      profile.email ||
      user?.email ||
      user?.preferred_username ||
      null
    );
  };

  const slingUserDisplayName = getSlingUserDisplayName(slingUser);
  const slingUserAccountLabel = slingUserDisplayName || "sua conta Slingui";

  const firstNonEmptyValue = (values) => {
    const value = values.find(
      (candidate) =>
        (typeof candidate === "string" && candidate.trim()) ||
        typeof candidate === "number",
    );

    return value == null ? null : String(value).trim();
  };

  const resolveMeetingIdFromContext = (meetingContext, fallbackMeetingId = null) => {
    if (!meetingContext || typeof meetingContext !== "object") {
      return fallbackMeetingId ? String(fallbackMeetingId).trim() : null;
    }

    return firstNonEmptyValue([
      fallbackMeetingId,
      meetingContext.meetingId,
      meetingContext.meetingID,
      meetingContext.meeting?.id,
      meetingContext.meeting?.meetingId,
      meetingContext.meeting?.meetingID,
      meetingContext.callId,
      meetingContext.callID,
      meetingContext.roomId,
      meetingContext.roomID,
      meetingContext.classroom?.meetingId,
      meetingContext.classroom?.meetingID,
      meetingContext.classroom?.roomId,
      meetingContext.classroom?.roomID,
      meetingContext.classroom?.id,
      meetingContext.classroomId,
      meetingContext.classroomID,
      meetingContext.id,
    ]);
  };

  const getParticipantAccessId = (participant) => {
    if (!participant) return null;
    if (typeof participant === "string" || typeof participant === "number") {
      return String(participant).trim() || null;
    }
    if (typeof participant !== "object") return null;

    return firstNonEmptyValue([
      participant._id,
      participant.userId,
      participant.externalUserId,
      participant.id,
      participant.sub,
      participant.customerId,
      participant.attendeeId,
      participant.email,
      participant.mail,
      participant.userEmail,
    ]);
  };

  const extractParticipantsFromValue = (participants) => {
    if (!participants) return [];

    const rawParticipants = [];

    if (Array.isArray(participants)) {
      rawParticipants.push(...participants);
    } else if (typeof participants === "object") {
      if (Array.isArray(participants.ids)) rawParticipants.push(...participants.ids);
      if (Array.isArray(participants.items)) rawParticipants.push(...participants.items);
      if (Array.isArray(participants.attendees)) rawParticipants.push(...participants.attendees);
      if (Array.isArray(participants.users)) rawParticipants.push(...participants.users);
      if (Array.isArray(participants.list)) rawParticipants.push(...participants.list);
      if (Array.isArray(participants.values)) rawParticipants.push(...participants.values);
      if (Array.isArray(participants.userIds)) rawParticipants.push(...participants.userIds);
      if (Array.isArray(participants.emails)) rawParticipants.push(...participants.emails);

      Object.entries(participants).forEach(([key, value]) => {
        if (
          [
            "ids",
            "items",
            "attendees",
            "users",
            "list",
            "values",
            "userIds",
            "emails",
            "total",
          ].includes(key)
        ) {
          return;
        }
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          (value && typeof value === "object" && !Array.isArray(value))
        ) {
          rawParticipants.push(value);
        }
      });
    }

    return rawParticipants;
  };

  const extractParticipantsFromContext = (meetingContext) => {
    if (!meetingContext || typeof meetingContext !== "object") return [];

    return [
      ...extractParticipantsFromValue(meetingContext.participants),
      ...extractParticipantsFromValue(meetingContext.usersCanAccess),
      ...extractParticipantsFromValue(meetingContext.users),
      ...extractParticipantsFromValue(meetingContext.attendees),
      ...extractParticipantsFromValue(meetingContext.meeting?.participants),
      ...extractParticipantsFromValue(meetingContext.meeting?.usersCanAccess),
      ...extractParticipantsFromValue(meetingContext.meeting?.users),
      ...extractParticipantsFromValue(meetingContext.meeting?.attendees),
      ...extractParticipantsFromValue(meetingContext.classroom?.participants),
      ...extractParticipantsFromValue(meetingContext.classroom?.usersCanAccess),
      ...extractParticipantsFromValue(meetingContext.classroom?.users),
      ...extractParticipantsFromValue(meetingContext.classroom?.attendees),
      ...extractParticipantsFromContext(meetingContext.meetingContext),
      ...extractParticipantsFromContext(meetingContext.lastMeetingState),
    ];
  };

  const buildUsersCanAccess = (...meetingContexts) => {
    const seen = new Set();
    const usersCanAccess = [];
    const localAccessIds = new Set();

    meetingContexts.forEach((meetingContext) => {
      const localUser = meetingContext?.localUser;
      [
        localUser?._id,
        localUser?.userId,
        localUser?.externalUserId,
        localUser?.id,
        localUser?.sub,
        localUser?.email,
      ]
        .map((value) => (value == null ? null : String(value).trim()))
        .filter(Boolean)
        .forEach((value) => localAccessIds.add(value));
    });

    meetingContexts
      .flatMap(extractParticipantsFromContext)
      .forEach((participant) => {
        const accessId = getParticipantAccessId(participant);
        if (!accessId || localAccessIds.has(accessId) || seen.has(accessId)) return;
        seen.add(accessId);
        usersCanAccess.push(accessId);
      });

    return usersCanAccess;
  };

  const buildDocumentMeetingState = ({
    meetingContext,
    screenityMeetingState,
    meetingId,
    participants,
  }) => {
    const baseState =
      meetingContext && typeof meetingContext === "object"
        ? meetingContext
        : screenityMeetingState || null;

    const participantIds = Array.isArray(participants) ? participants : [];
    const currentParticipants =
      baseState?.participants && typeof baseState.participants === "object"
        ? baseState.participants
        : {};

    if (!baseState || typeof baseState !== "object") {
      return meetingId
        ? {
            meetingId,
            meeting: { meetingId },
            classroom: screenityMeetingState?.classroom || null,
            participants: {
              ids: participantIds,
              total: participantIds.length,
            },
          }
        : null;
    }

    return {
      ...baseState,
      meetingId: meetingId || baseState.meetingId || null,
      meeting: {
        ...(baseState.meeting || {}),
        meetingId: meetingId || baseState.meeting?.meetingId || null,
      },
      classroom: baseState.classroom || screenityMeetingState?.classroom || null,
      participants: {
        ...currentParticipants,
        ids:
          participantIds.length > 0
            ? participantIds
            : Array.isArray(currentParticipants.ids)
              ? currentParticipants.ids
              : [],
        total:
          participantIds.length > 0
            ? participantIds.length
            : currentParticipants.total ||
              (Array.isArray(currentParticipants.ids) ? currentParticipants.ids.length : 0),
      },
    };
  };

  const saveToDrive = () => {
    setContentState((prevContentState) => ({
      ...prevContentState,
      saveDrive: true,
    }));

    const handleDriveResponse = (response) => {
      if (!response || response.status === "ew" || response.error) {
        console.error("[Drive] drive_save_failed:", response?.error || "unknown error");
        setContentState((prevContentState) => ({
          ...prevContentState,
          saveDrive: false,
        }));
      }
      // On success, saveDrive is reset by the "saved-to-drive" message from background.
    };

    const handleDriveError = (err) => {
      console.error("[Drive] drive_save_error:", err);
      setContentState((prevContentState) => ({
        ...prevContentState,
        saveDrive: false,
      }));
    };

    if (contentState.noffmpeg || !contentState.mp4ready || !contentState.blob) {
      // Prefer duration-fixed webm over rebuilding from raw chunks.
      const fixedWebm = contentState.webm;
      if (fixedWebm && fixedWebm instanceof Blob && fixedWebm.size > 0) {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          const base64 = dataUrl.split(",")[1];
          chrome.runtime
            .sendMessage({
              type: "save-to-drive",
              base64: base64,
              title: contentState.title,
              isWebm: true,
            })
            .then(handleDriveResponse)
            .catch(handleDriveError);
        };
        reader.onerror = () => {
          chrome.runtime
            .sendMessage({
              type: "save-to-drive-fallback",
              title: contentState.title,
            })
            .then(handleDriveResponse)
            .catch(handleDriveError);
        };
        reader.readAsDataURL(fixedWebm);
      } else {
        chrome.runtime
          .sendMessage({
            type: "save-to-drive-fallback",
            title: contentState.title,
          })
          .then(handleDriveResponse)
          .catch(handleDriveError);
      }
    } else {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const base64 = dataUrl.split(",")[1];

        chrome.runtime
          .sendMessage({
            type: "save-to-drive",
            base64: base64,
            title: contentState.title,
          })
          .then(handleDriveResponse)
          .catch(handleDriveError);
      };
      reader.onerror = () => {
        console.error("[Drive] FileReader failed to read blob for Drive upload");
        setContentState((prevContentState) => ({
          ...prevContentState,
          saveDrive: false,
        }));
      };
      if (
        !contentState.noffmpeg &&
        contentState.mp4ready &&
        contentState.blob
      ) {
        reader.readAsDataURL(contentState.blob);
      } else {
        reader.readAsDataURL(contentState.webm);
      }
    }
  };

  const signOutDrive = () => {
    chrome.runtime.sendMessage({ type: "sign-out-drive" });
    setContentState((prevContentState) => ({
      ...prevContentState,
      driveEnabled: false,
    }));
  };

  const handleEdit = () => {
    if (
      contentState.duration > contentState.editLimit &&
      !contentState.override
    )
      return;
    if (!contentState.mp4ready) return;

    contentState.createBackup();

    setContentState((prevContentState) => ({
      ...prevContentState,
      mode: "edit",
      dragInteracted: false,
    }));
  };

  const handleCrop = () => {
    if (
      contentState.duration > contentState.editLimit &&
      !contentState.override
    )
      return;

    if (!contentState.mp4ready) return;

    contentState.createBackup();

    // If the frame isn't cached yet, request it and defer the mode switch
    // until "new-frame" arrives, otherwise the cropper mounts over a blank
    // stage and there's a black flash for the round-trip duration.
    if (!contentState.frame) {
      setContentState((prevContentState) => ({
        ...prevContentState,
        pendingCropEntry: true,
      }));
      if (!contentState.isFfmpegRunning) contentState.getFrame();
      return;
    }

    setContentState((prevContentState) => ({
      ...prevContentState,
      mode: "crop",
    }));
  };

  const handleAddAudio = async () => {
    if (
      contentState.duration > contentState.editLimit &&
      !contentState.override
    )
      return;
    if (!contentState.mp4ready) return;

    contentState.createBackup();

    setContentState((prevContentState) => ({
      ...prevContentState,
      mode: "audio",
    }));
  };

  // Best available blob: edited MP4 → fixed WebM → raw WebM.
  const handleDownloadOriginal = () => {
    const s = contentStateRef.current;
    const source = s.blob || s.webm || s.rawBlob;
    if (!source) return;
    const blob =
      source instanceof Blob
        ? source
        : new Blob([source], { type: "video/webm" });
    const ext = blob.type.includes("mp4") ? "mp4" : "webm";
    const rawTitle = s.title || "screenity-recording";
    const safe = rawTitle
      .replace(/[\\:*?"<>|]/g, " ")
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "screenity-recording";
    const url = window.URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: `${safe}.${ext}` }, () => {
      window.URL.revokeObjectURL(url);
    });
  };

  const handleRawRecording = () => {
    if (typeof contentStateRef.current.openModal === "function") {
      contentStateRef.current.openModal(
        chrome.i18n.getMessage("rawRecordingModalTitle"),
        chrome.i18n.getMessage("rawRecordingModalDescription"),
        chrome.i18n.getMessage("rawRecordingModalButton"),
        chrome.i18n.getMessage("sandboxEditorCancelButton"),
        async () => {
          const s = contentStateRef.current;
          const blob = s.rawBlob || s.blob;
          if (!blob) {
            console.error("[Screenity] raw download: no rawBlob available");
            chrome.runtime.sendMessage({
              type: "show-toast",
              message: chrome.i18n.getMessage("rawRecordingModalTitle") + ": no data",
            });
            return;
          }

          const ext = blob.type.includes("mp4") ? "mp4" : "webm";
          const filename = `raw-recording.${ext}`;

          // base64-via-BG fallback: works in Brave and when blob-URL downloads
          // are restricted, doesn't depend on chrome.downloads from here.
          const fallbackViaBackground = async () => {
            const base64 = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(blob);
            });
            chrome.runtime.sendMessage({
              type: "request-download",
              base64,
              title: filename,
            });
          };

          try {
            const url = window.URL.createObjectURL(blob);
            const downloadId = await new Promise((resolve, reject) => {
              try {
                chrome.downloads.download({ url, filename }, (id) => {
                  if (chrome.runtime.lastError || !id) {
                    reject(
                      chrome.runtime.lastError ||
                      new Error("download returned no id"),
                    );
                  } else {
                    resolve(id);
                  }
                });
              } catch (err) {
                reject(err);
              }
            });
            // Detect interrupted (non-user-cancel) downloads; matches the
            // main download flow in ContentState.jsx.
            const interruptHandler = async (delta) => {
              if (delta.id !== downloadId || !delta.state) return;
              if (
                delta.state.current === "interrupted" &&
                delta.error?.current !== "USER_CANCELED"
              ) {
                chrome.downloads.onChanged.removeListener(interruptHandler);
                try {
                  await fallbackViaBackground();
                } catch (err) {
                  console.error("[Screenity] raw download fallback failed:", err);
                }
              } else if (
                delta.state.current === "complete" ||
                delta.state.current === "interrupted"
              ) {
                chrome.downloads.onChanged.removeListener(interruptHandler);
                window.URL.revokeObjectURL(url);
              }
            };
            chrome.downloads.onChanged.addListener(interruptHandler);
          } catch (err) {
            console.warn(
              "[Screenity] raw download direct path failed, using fallback:",
              err,
            );
            try {
              await fallbackViaBackground();
            } catch (fallbackErr) {
              console.error(
                "[Screenity] raw download fallback failed:",
                fallbackErr,
              );
              chrome.runtime.sendMessage({
                type: "show-toast",
                message: chrome.i18n.getMessage("rawRecordingModalTitle") + ": failed",
              });
            }
          }
        },
        () => { }
      );
    }
  };

  const handleTroubleshooting = () => {
    if (typeof contentStateRef.current.openModal === "function") {
      contentStateRef.current.openModal(
        chrome.i18n.getMessage("troubleshootModalTitle"),
        chrome.i18n.getMessage("troubleshootModalDescription"),
        chrome.i18n.getMessage("troubleshootModalButton"),
        chrome.i18n.getMessage("sandboxEditorCancelButton"),
        async () => {
          try {
            const cs = contentStateRef.current;
            const { blob, filename } = await buildDiagnosticZip({
              source: "sandbox-editor",
              extraConfig: {
                editorMode: cs.mode || null,
                duration: cs.duration || null,
                width: cs.width || null,
                height: cs.height || null,
                hasBlobReady: Boolean(cs.blob || cs.rawBlob),
                mp4ready: Boolean(cs.mp4ready),
                ffmpegLoaded: Boolean(cs.ffmpegLoaded),
                fallback: Boolean(cs.fallback),
                offline: Boolean(cs.offline),
                noffmpeg: Boolean(cs.noffmpeg),
                updateChrome: Boolean(cs.updateChrome),
                hasBeenEdited: Boolean(cs.hasBeenEdited),
                editLimit: cs.editLimit || null,
              },
            });
            const url = window.URL.createObjectURL(blob);
            chrome.downloads.download(
              { url, filename },
              () => {
                window.URL.revokeObjectURL(url);
              },
            );
          } catch (err) {
            console.error("[Screenity] Troubleshooting export failed:", err);
          }
        },
        () => { },
      );
    }
  };

  const handleDebugMeetingState = async () => {
    try {
      const {
        recordingMeta = null,
        screenityMeetingState = null,
        latestMeetingDocumentContext = null,
        latestMeetingAudioChunks = null,
        screenityToken = null,
      } = await chrome.storage.local.get([
        "recordingMeta",
        "screenityMeetingState",
        "latestMeetingDocumentContext",
        "latestMeetingAudioChunks",
        "screenityToken",
      ]);
      const storedUser = await getUser().catch(() => null);
      const cs = contentStateRef.current || {};
      const meetingAudioChunks = cs.meetingAudioChunks || latestMeetingAudioChunks || null;
      const contentRecordingMeta = cs.recordingMeta || null;
      const persistedRecordingMeta = latestMeetingDocumentContext?.recordingMeta || null;
      const persistedScreenityMeetingState =
        latestMeetingDocumentContext?.screenityMeetingState || null;
      const contentMeetingContext = contentRecordingMeta?.meetingContext || null;
      const persistedMeetingContext =
        latestMeetingDocumentContext?.meetingContext || persistedRecordingMeta?.meetingContext || null;
      const storedMeetingContext = recordingMeta?.meetingContext || null;
      const currentScreenityMeetingState = screenityMeetingState || null;
      const meetingContextCandidates = [
        contentMeetingContext ||
          persistedMeetingContext ||
          storedMeetingContext ||
          persistedScreenityMeetingState ||
          null,
        meetingAudioChunks?.lastMeetingState || null,
        meetingAudioChunks?.meetingContext || null,
        currentScreenityMeetingState,
      ].filter(Boolean);
      const meetingContext =
        meetingContextCandidates.find((candidate) =>
          Boolean(resolveMeetingIdFromContext(candidate)),
        ) ||
        meetingContextCandidates[0] ||
        null;
      const meetingId = resolveMeetingIdFromContext(
        meetingContext,
        meetingAudioChunks?.meetingId || latestMeetingDocumentContext?.meetingId || null,
      );
      const debugPayload = {
        meetingId,
        token: {
          hasStoredSlingUser: Boolean(storedUser),
          storedUserExpired: Boolean(storedUser?.expired),
          hasStoredAccessToken: Boolean(storedUser?.access_token),
          hasFallbackScreenityToken: Boolean(screenityToken),
        },
        sources: {
          contentMeetingContextId: resolveMeetingIdFromContext(contentMeetingContext),
          persistedMeetingContextId: resolveMeetingIdFromContext(persistedMeetingContext),
          storedMeetingContextId: resolveMeetingIdFromContext(storedMeetingContext),
          screenityMeetingStateId: resolveMeetingIdFromContext(currentScreenityMeetingState),
          persistedDocumentMeetingId: latestMeetingDocumentContext?.meetingId || null,
          meetingAudioChunksMeetingId: meetingAudioChunks?.meetingId || null,
        },
        state: {
          ready: Boolean(cs.ready),
          mp4ready: Boolean(cs.mp4ready),
          hasBlob: Boolean(cs.blob),
          hasWebm: Boolean(cs.webm),
          hasRecordingMeta: Boolean(contentRecordingMeta),
          hasMeetingAudioChunks: Boolean(meetingAudioChunks),
          meetingAudioChunksApplied: Boolean(cs.meetingAudioChunksApplied),
          meetingAudioChunksError: cs.meetingAudioChunksError || null,
        },
        storage: {
          hasRecordingMeta: Boolean(recordingMeta),
          hasScreenityMeetingState: Boolean(screenityMeetingState),
          hasLatestMeetingDocumentContext: Boolean(latestMeetingDocumentContext),
          hasLatestMeetingAudioChunks: Boolean(latestMeetingAudioChunks),
        },
        chunks: {
          total: meetingAudioChunks?.chunks?.length || 0,
          downloaded:
            meetingAudioChunks?.chunks?.filter((chunk) => chunk.audioBlob instanceof Blob)
              .length || 0,
        },
        raw: {
          contentRecordingMeta,
          recordingMeta,
          screenityMeetingState,
          latestMeetingDocumentContext,
          meetingAudioChunks,
          meetingContext,
        },
      };

      console.info("[Slingui Debug] Sandbox meeting state", debugPayload);
      window.alert(
        [
          "Debug Slingui / Meeting",
          `meetingId: ${meetingId || "não encontrado"}`,
          `chunks: ${debugPayload.chunks.downloaded}/${debugPayload.chunks.total}`,
          `stored user: ${debugPayload.token.hasStoredSlingUser ? "sim" : "não"}`,
          `access token: ${debugPayload.token.hasStoredAccessToken ? "sim" : "não"}`,
          "Detalhes completos no console: [Slingui Debug] Sandbox meeting state",
        ].join("\n"),
      );
    } catch (error) {
      console.error("[Slingui Debug] Failed to inspect meeting state", error);
      window.alert("Falha ao inspecionar estado Slingui/meeting. Veja o console.");
    }
  };

  const handleSlinguiUpload = async (user) => {
    let currentUser = user;
    if (currentUser?.expired) {
      try {
        currentUser = await login();
        setSlingUser(currentUser);
      } catch (error) {
        console.error("Re-authentication failed", error);
        return;
      }
    }

    const contentSnapshot = contentStateRef.current || {};
    const blobToUpload =
      contentSnapshot.mp4ready && contentSnapshot.blob
        ? contentSnapshot.blob
        : contentSnapshot.webm;

    if (!blobToUpload) {
      console.error("No blob available to upload");
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);

    try {
      // Step 1: Get the signed URL
      const response = await fetch("https://api.slingui.com/storage/upload", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + currentUser.access_token,
        },
        body: JSON.stringify({
          contentType: blobToUpload.type.split("/")[1].split(";")[0],
          strategy: "recording",
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || "Failed to get upload URL");
      }

      // Step 2: Upload the file using XMLHttpRequest
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", data.uploadURL, true);
        xhr.setRequestHeader("Content-Type", blobToUpload.type);
        xhr.upload.onprogress = (event) => {
          if (!event.lengthComputable) return;
          const progress = Math.round((event.loaded / event.total) * 100);
          setUploadProgress(progress);
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            setUploadProgress(100);
            resolve(xhr.response);
          } else {
            reject(new Error("File upload failed with status: " + xhr.status));
          }
        };
        xhr.onerror = () => reject(new Error("File upload failed due to a network error."));
        xhr.send(blobToUpload);
      });

      const {
        recordingMeta = null,
        screenityMeetingState = null,
        latestMeetingDocumentContext = null,
        latestMeetingAudioChunks = null,
      } = await chrome.storage.local.get([
        "recordingMeta",
        "screenityMeetingState",
        "latestMeetingDocumentContext",
        "latestMeetingAudioChunks",
      ]);

      const latestContentSnapshot = contentStateRef.current || contentSnapshot;
      const persistedDocumentContext = latestMeetingDocumentContext || null;
      const meetingAudioChunks =
        latestContentSnapshot.meetingAudioChunks || latestMeetingAudioChunks || null;
      const contentRecordingMeta = latestContentSnapshot.recordingMeta || null;
      const persistedRecordingMeta = persistedDocumentContext?.recordingMeta || null;
      const persistedScreenityMeetingState =
        persistedDocumentContext?.screenityMeetingState || null;
      const currentScreenityMeetingState = screenityMeetingState || null;
      const documentScreenityMeetingState =
        persistedScreenityMeetingState || currentScreenityMeetingState || null;
      const contentMeetingContext = contentRecordingMeta?.meetingContext || null;
      const persistedMeetingContext =
        persistedDocumentContext?.meetingContext || persistedRecordingMeta?.meetingContext || null;
      const storedMeetingContext = recordingMeta?.meetingContext || null;
      const meetingContextCandidates = [
        contentMeetingContext ||
          persistedMeetingContext ||
          storedMeetingContext ||
          persistedScreenityMeetingState ||
          null,
        meetingAudioChunks?.lastMeetingState || null,
        meetingAudioChunks?.meetingContext || null,
        currentScreenityMeetingState,
      ].filter(Boolean);
      const meetingContext =
        meetingContextCandidates.find((candidate) =>
          Boolean(resolveMeetingIdFromContext(candidate)),
        ) ||
        meetingContextCandidates[0] ||
        null;
      const meetingId = resolveMeetingIdFromContext(
        meetingContext,
        meetingAudioChunks?.meetingId || persistedDocumentContext?.meetingId || null,
      );
      const usersCanAccess = buildUsersCanAccess(
        contentMeetingContext,
        persistedMeetingContext,
        storedMeetingContext,
        persistedRecordingMeta,
        persistedScreenityMeetingState,
        meetingAudioChunks?.lastMeetingState,
        meetingAudioChunks?.meetingContext,
        currentScreenityMeetingState,
        meetingAudioChunks,
      );
      const lastMeetingState = buildDocumentMeetingState({
        meetingContext,
        screenityMeetingState: documentScreenityMeetingState,
        meetingId,
        participants: usersCanAccess,
      });

      const documentPayload = {
        name: latestContentSnapshot.title || "Untitled Recording",
        path: "recording",
        type: "recording",
        meetingId,
        lastMeetingState,
        usersCanAccess,
        storageUrl: data.urlFile,
      };

      console.info("[Slingui Upload] Document payload resolved", {
        meetingId,
        usersCanAccess,
        contextSources: {
          hasContentMeetingContext: Boolean(contentMeetingContext),
          hasPersistedMeetingContext: Boolean(persistedMeetingContext),
          hasStoredMeetingContext: Boolean(storedMeetingContext),
          hasDocumentScreenityMeetingState: Boolean(documentScreenityMeetingState),
          hasMeetingAudioChunks: Boolean(meetingAudioChunks),
        },
        documentPayload,
      });

      // Step 3: Create the document entry
      const documentResponse = await fetch("https://api.slingui.com/classroom/documents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + currentUser.access_token,
        },
        body: JSON.stringify(documentPayload),
      });

      if (!documentResponse.ok) {
        const errorData = await documentResponse.json();
        throw new Error(errorData.message || "Failed to create document entry");
      }

      await documentResponse.json();

      // Step 4: Redirect
      chrome.tabs.create({ url: "https://meeting.slingui.com/recordings" });
    } catch (error) {
      console.error("Upload failed", error);
      alert("Falha ao salvar na Slingui: " + error.message);
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  return (
    <div className={styles.panel}>
      {contentState.mode === "audio" && <AudioUI />}
      {contentState.mode === "crop" && <CropUI />}
      {contentState.mode === "player" && (
        <div>
          {!contentState.fallback && contentState.offline && (
            <div className={styles.alert}>
              <div className={styles.buttonLeft}>
                <ReactSVG src={EXT_URL + "editor/icons/no-internet.svg"} />
              </div>
              <div className={styles.buttonMiddle}>
                <div className={styles.buttonTitle}>
                  {chrome.i18n.getMessage("offlineLabelTitle")}
                </div>
                <div className={styles.buttonDescription}>
                  {chrome.i18n.getMessage("offlineLabelDescription")}
                </div>
              </div>
              <div className={styles.buttonRight}>
                {chrome.i18n.getMessage("offlineLabelTryAgain")}
              </div>
            </div>
          )}
          {contentState.fallback && contentState.noffmpeg && contentState.editLimit === 0 && (
            <div className={styles.alert}>
              <div className={styles.buttonLeft}>
                <ReactSVG src={EXT_URL + "editor/icons/alert.svg"} />
              </div>
              <div className={styles.buttonMiddle}>
                <div className={styles.buttonTitle}>
                  {chrome.i18n.getMessage("longRecordingTitle")}
                </div>
                <div className={styles.buttonDescription}>
                  {chrome.i18n.getMessage("longRecordingDescription")}
                </div>
              </div>
              <div
                className={styles.buttonRight}
                onClick={handleDownloadOriginal}
              >
                {chrome.i18n.getMessage("rawRecordingModalButton")}
              </div>
            </div>
          )}
          {contentState.fallback && contentState.noffmpeg && contentState.editLimit !== 0 && (
            <div className={styles.alert}>
              <div className={styles.buttonLeft}>
                <ReactSVG src={EXT_URL + "editor/icons/alert.svg"} />
              </div>
              <div className={styles.buttonMiddle}>
                <div className={styles.buttonTitle}>
                  {chrome.i18n.getMessage("recoveryModeTitle")}
                </div>
                <div className={styles.buttonDescription}>
                  {chrome.i18n.getMessage("recoveryModeDescription")}
                </div>
              </div>
              <div
                className={styles.buttonRight}
                onClick={handleDownloadOriginal}
              >
                {chrome.i18n.getMessage("rawRecordingModalButton")}
              </div>
            </div>
          )}
          {!contentState.fallback &&
            contentState.updateChrome &&
            !contentState.offline &&
            contentState.duration <= contentState.editLimit && (
              <div className={styles.alert}>
                <div className={styles.buttonLeft}>
                  <ReactSVG src={EXT_URL + "editor/icons/alert.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    {chrome.i18n.getMessage("updateChromeLabelTitle")}
                  </div>
                  <div className={styles.buttonDescription}>
                    {chrome.i18n.getMessage("updateChromeLabelDescription")}
                  </div>
                </div>
                <div
                  className={styles.buttonRight}
                  onClick={() => {
                    chrome.runtime.sendMessage({ type: "chrome-update-info" });
                  }}
                >
                  {chrome.i18n.getMessage("learnMoreLabel")}
                </div>
              </div>
            )}
          {!contentState.fallback &&
            contentState.duration > contentState.editLimit &&
            !contentState.override &&
            !contentState.offline &&
            !contentState.updateChrome && (
              <div className={styles.alert}>
                <div className={styles.buttonLeft}>
                  <ReactSVG src={EXT_URL + "editor/icons/alert.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    {chrome.i18n.getMessage("overLimitLabelTitle")}
                  </div>
                  <div className={styles.buttonDescription}>
                    {contentState.blob?.type === "video/mp4"
                      ? chrome.i18n.getMessage(
                        "overLimitLabelDescriptionFastPath"
                      )
                      : chrome.i18n.getMessage("overLimitLabelDescription")}
                  </div>
                </div>
                <div
                  className={styles.buttonRight}
                  onClick={() => {
                    if (typeof contentState.openModal === "function") {
                      contentState.openModal(
                        chrome.i18n.getMessage("overLimitModalTitle"),
                        chrome.i18n.getMessage(
                          contentState.blob?.type === "video/mp4"
                            ? "overLimitModalDescriptionFastPath"
                            : "overLimitModalDescription"
                        ),
                        chrome.i18n.getMessage("overLimitModalButton"),
                        chrome.i18n.getMessage("sandboxEditorCancelButton"),
                        () => {
                          setContentState((prevContentState) => ({
                            ...prevContentState,
                            saved: true,
                          }));
                          chrome.runtime.sendMessage({
                            type: "force-processing",
                          });
                        },
                        () => { },
                        null,
                        chrome.i18n.getMessage("overLimitModalLearnMore"),
                        () => {
                          chrome.runtime.sendMessage({ type: "upgrade-info" });
                        }
                      );
                    }
                  }}
                >
                  {chrome.i18n.getMessage("learnMoreLabel")}
                </div>
              </div>
            )}
          {(!contentState.mp4ready || contentState.isFfmpegRunning) &&
            (contentState.duration <= contentState.editLimit ||
              contentState.override) &&
            !contentState.offline &&
            !contentState.updateChrome &&
            !contentState.noffmpeg && (
              <div className={styles.alert}>
                <div className={styles.buttonLeft}>
                  <ReactSVG src={EXT_URL + "editor/icons/alert.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    {chrome.i18n.getMessage("videoProcessingLabelTitle")}
                  </div>
                  <div className={styles.buttonDescription}>
                    {contentState.isFfmpegRunning
                      ? chrome.i18n.getMessage("editProcessingSafeDescription")
                      : chrome.i18n.getMessage("videoProcessingLabelDescription")}
                  </div>
                </div>
                {!contentState.isFfmpegRunning && (
                  <div
                    className={styles.buttonRight}
                    onClick={() => {
                      chrome.runtime.sendMessage({
                        type: "pricing",
                      });
                    }}
                  >
                    {chrome.i18n.getMessage("learnMoreLabel")}
                  </div>
                )}
              </div>
            )}

          {!contentState.fallback &&
            contentState.editErrorType === "too-long" &&
            !(
              contentState.duration > contentState.editLimit &&
              !contentState.override
            ) && (
              <div className={styles.alert}>
                <div className={styles.buttonLeft}>
                  <ReactSVG src={EXT_URL + "editor/icons/alert.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    {chrome.i18n.getMessage("editTooLongTitle")}
                  </div>
                  <div className={styles.buttonDescription}>
                    {chrome.i18n.getMessage("editTooLongDescription")}
                  </div>
                </div>
                <div
                  className={styles.buttonRight}
                  onClick={() =>
                    setContentState((prev) => ({ ...prev, editErrorType: null }))
                  }
                >
                  {chrome.i18n.getMessage("permissionsModalDismiss")}
                </div>
              </div>
            )}
          {!contentState.fallback && contentState.editErrorType === "timeout" && (
            <div className={styles.alert}>
              <div className={styles.buttonLeft}>
                <ReactSVG src={EXT_URL + "editor/icons/alert.svg"} />
              </div>
              <div className={styles.buttonMiddle}>
                <div className={styles.buttonTitle}>
                  {chrome.i18n.getMessage("editTimeoutTitle")}
                </div>
                <div className={styles.buttonDescription}>
                  {chrome.i18n.getMessage("editTimeoutDescription")}
                </div>
              </div>
              <div
                className={styles.buttonRight}
                onClick={() =>
                  setContentState((prev) => ({ ...prev, editErrorType: null }))
                }
              >
                {chrome.i18n.getMessage("permissionsModalDismiss")}
              </div>
            </div>
          )}
          {!contentState.fallback && contentState.editErrorType === "failed" && (
            <div className={styles.alert}>
              <div className={styles.buttonLeft}>
                <ReactSVG src={EXT_URL + "editor/icons/alert.svg"} />
              </div>
              <div className={styles.buttonMiddle}>
                <div className={styles.buttonTitle}>
                  {chrome.i18n.getMessage("editFailedTitle")}
                </div>
                <div className={styles.buttonDescription}>
                  {chrome.i18n.getMessage("editFailedDescription")}
                </div>
              </div>
              <div
                className={styles.buttonRight}
                onClick={() =>
                  setContentState((prev) => ({ ...prev, editErrorType: null }))
                }
              >
                {chrome.i18n.getMessage("permissionsModalDismiss")}
              </div>
            </div>
          )}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>
              {chrome.i18n.getMessage("sandboxEditTitle")}
            </div>
            <div className={styles.buttonWrap}>
              <div
                role="button"
                className={styles.button}
                onClick={handleEdit}
                disabled={
                  (contentState.duration > contentState.editLimit &&
                    !contentState.override) ||
                  !contentState.mp4ready ||
                  contentState.noffmpeg
                }
              >
                <div className={styles.buttonLeft}>
                  <ReactSVG src={EXT_URL + "editor/icons/trim.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    {chrome.i18n.getMessage("editButtonTitle")}
                  </div>
                  <div className={styles.buttonDescription}>
                    {contentState.offline && !contentState.ffmpegLoaded
                      ? chrome.i18n.getMessage("noConnectionLabel")
                      : contentState.updateChrome ||
                        contentState.noffmpeg ||
                        (contentState.duration > contentState.editLimit &&
                          !contentState.override)
                        ? getNotAvailableLabel()
                        : contentState.mp4ready
                          ? chrome.i18n.getMessage("editButtonDescription")
                          : getPreparingLabel()}
                  </div>
                </div>
                <div className={styles.buttonRight}>
                  <ReactSVG src={EXT_URL + "editor/icons/right-arrow.svg"} />
                </div>
              </div>
              <div
                role="button"
                className={styles.button}
                onClick={handleCrop}
                disabled={
                  (contentState.duration > contentState.editLimit &&
                    !contentState.override) ||
                  !contentState.mp4ready ||
                  contentState.noffmpeg
                }
              >
                <div className={styles.buttonLeft}>
                  <ReactSVG src={EXT_URL + "editor/icons/crop.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    {chrome.i18n.getMessage("cropButtonTitle")}
                  </div>
                  <div className={styles.buttonDescription}>
                    {contentState.offline && !contentState.ffmpegLoaded
                      ? chrome.i18n.getMessage("noConnectionLabel")
                      : contentState.updateChrome ||
                        contentState.noffmpeg ||
                        (contentState.duration > contentState.editLimit &&
                          !contentState.override)
                        ? getNotAvailableLabel()
                        : contentState.mp4ready
                          ? chrome.i18n.getMessage("cropButtonDescription")
                          : getPreparingLabel()}
                  </div>
                </div>
                <div className={styles.buttonRight}>
                  <ReactSVG src={EXT_URL + "editor/icons/right-arrow.svg"} />
                </div>
              </div>
              <div
                role="button"
                className={styles.button}
                onClick={handleAddAudio}
                disabled={
                  (contentState.duration > contentState.editLimit &&
                    !contentState.override) ||
                  !contentState.mp4ready ||
                  contentState.noffmpeg
                }
              >
                <div className={styles.buttonLeft}>
                  <ReactSVG src={EXT_URL + "editor/icons/audio.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    {chrome.i18n.getMessage("addAudioButtonTitle")}
                  </div>
                  <div className={styles.buttonDescription}>
                    {contentState.offline && !contentState.ffmpegLoaded
                      ? chrome.i18n.getMessage("noConnectionLabel")
                      : contentState.updateChrome ||
                        contentState.noffmpeg ||
                        (contentState.duration > contentState.editLimit &&
                          !contentState.override)
                        ? getNotAvailableLabel()
                        : contentState.mp4ready
                          ? chrome.i18n.getMessage("addAudioButtonDescription")
                          : getPreparingLabel()}
                  </div>
                </div>
                <div className={styles.buttonRight}>
                  <ReactSVG src={EXT_URL + "editor/icons/right-arrow.svg"} />
                </div>
              </div>
            </div>
          </div>
          <div className={styles.section}>
            <div className={styles.sectionTitle}>
              {chrome.i18n.getMessage("sandboxSaveTitle")}
            </div>
            {slingUser ? (
              <div className={styles.slingUserName}>
                Logado como {slingUserAccountLabel}
              </div>
            ) : null}
            {slingUser ? (
              <div
                className={styles.buttonLogout}
                onClick={async () => {
                  await logout();
                  setSlingUser(null);
                }}
              >
                Sair da Slingui
              </div>
            ) : null}
            {contentState.driveEnabled && (
              <div
                className={styles.buttonLogout}
                onClick={() => {
                  signOutDrive();
                }}
              >
                {chrome.i18n.getMessage("signOutDriveLabel")}
              </div>
            )}
            <div className={styles.buttonWrap}>
              {isAuthLoading ? (
                <div
                  role="status"
                  aria-live="polite"
                  className={`${styles.button} ${styles.authLoadingButton}`}
                  disabled
                >
                  <div className={styles.buttonMiddle} style={{ paddingLeft: '24px' }}>
                    <div className={styles.buttonTitle}>Autenticando na Slingui...</div>
                    <div className={styles.buttonDescription}>
                      Aguarde enquanto verificamos sua sessão
                    </div>
                  </div>
                </div>
              ) : slingUser ? (
                <div
                  role="button"
                  className={styles.button}
                  onClick={() => handleSlinguiUpload(slingUser)}
                  disabled={isUploading || (!contentState.blob && !contentState.webm)}
                >
                  <div className={styles.buttonMiddle} style={{ paddingLeft: '24px' }}>
                    <div className={styles.buttonTitle}>
                      {isUploading
                        ? `Salvando... ${uploadProgress}%`
                        : "Salvar na Slingui"}
                    </div>
                    <div className={styles.buttonDescription}>
                      {contentState.mp4ready
                        ? `Salvar o vídeo MP4 na ${slingUserAccountLabel}`
                        : `Salvar o vídeo WEBM na ${slingUserAccountLabel}`}
                    </div>
                  </div>
                  <div className={styles.buttonRight}>
                    <ReactSVG src={EXT_URL + "editor/icons/right-arrow.svg"} />
                  </div>
                </div>
              ) : (
                <div
                  role="button"
                  className={styles.button}
                  onClick={async () => {
                    try {
                      const user = await login();
                      setSlingUser(user);
                      await handleSlinguiUpload(user);
                    } catch (error) {
                      console.error("Login failed:", error);
                    }
                  }}
                >
                  <div className={styles.buttonMiddle} style={{ paddingLeft: '24px' }}>
                    <div className={styles.buttonTitle}>Save to your account</div>
                    <div className={styles.buttonDescription}>
                      Save, then share it with students
                    </div>
                  </div>
                  <div className={styles.buttonRight}>
                    <ReactSVG src={EXT_URL + "editor/icons/right-arrow.svg"} />
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className={styles.section}>
            <div className={styles.sectionTitle}>
              {chrome.i18n.getMessage("sandboxExportTitle")}
            </div>
            <div className={styles.buttonWrap}>
              {contentState.fallback && (
                <div
                  role="button"
                  className={styles.button}
                  onClick={() => contentState.downloadWEBM()}
                  disabled={contentState.isFfmpegRunning}
                >
                  <div className={styles.buttonLeft}>
                    <ReactSVG src={EXT_URL + "editor/icons/download.svg"} />
                  </div>
                  <div className={styles.buttonMiddle}>
                    <div className={styles.buttonTitle}>
                      {contentState.downloadingWEBM
                        ? chrome.i18n.getMessage("downloadingLabel")
                        : chrome.i18n.getMessage("downloadWEBMButtonTitle")}
                    </div>
                    <div className={styles.buttonDescription}>
                      {chrome.i18n.getMessage("downloadWEBMButtonDescription")}
                    </div>
                  </div>
                  <div className={styles.buttonRight}>
                    <ReactSVG src={EXT_URL + "editor/icons/right-arrow.svg"} />
                  </div>
                </div>
              )}
              {(() => {
                // WebCodecs path produces a native MP4 blob; download is a
                // blob-URL anchor click, no ffmpeg/re-encode, so editLimit
                // and noffmpeg gates don't apply.
                const isNativeMp4 =
                  contentState.blob?.type === "video/mp4";
                const mp4Disabled = isNativeMp4
                  ? contentState.isFfmpegRunning || !contentState.mp4ready
                  : contentState.isFfmpegRunning ||
                  contentState.noffmpeg ||
                  !contentState.mp4ready;
                const mp4ShowNotAvailable = isNativeMp4
                  ? false
                  : contentState.updateChrome ||
                  contentState.noffmpeg ||
                  (contentState.duration > contentState.editLimit &&
                    !contentState.override);
                return (
                  <div
                    role="button"
                    className={styles.button}
                    onClick={() => {
                      if (!contentState.mp4ready) return;
                      contentState.download();
                    }}
                    disabled={mp4Disabled}
                  >
                    <div className={styles.buttonLeft}>
                      <ReactSVG src={EXT_URL + "editor/icons/download.svg"} />
                    </div>
                    <div className={styles.buttonMiddle}>
                      <div className={styles.buttonTitle}>
                        {contentState.downloading
                          ? chrome.i18n.getMessage("downloadingLabel")
                          : chrome.i18n.getMessage("downloadMP4ButtonTitle")}
                      </div>
                      <div className={styles.buttonDescription}>
                        {contentState.offline &&
                          !contentState.ffmpegLoaded &&
                          !isNativeMp4
                          ? chrome.i18n.getMessage("noConnectionLabel")
                          : mp4ShowNotAvailable
                            ? getNotAvailableLabel()
                            : contentState.mp4ready && !contentState.isFfmpegRunning
                              ? chrome.i18n.getMessage("downloadMP4ButtonDescription")
                              : getPreparingLabel()}
                      </div>
                    </div>
                    <div className={styles.buttonRight}>
                      <ReactSVG src={EXT_URL + "editor/icons/right-arrow.svg"} />
                    </div>
                  </div>
                );
              })()}
              {!contentState.fallback && (
                <div
                  role="button"
                  className={styles.button}
                  onClick={() => contentState.downloadWEBM()}
                  disabled={contentState.isFfmpegRunning}
                >
                  <div className={styles.buttonLeft}>
                    <ReactSVG src={EXT_URL + "editor/icons/download.svg"} />
                  </div>
                  <div className={styles.buttonMiddle}>
                    <div className={styles.buttonTitle}>
                      {contentState.downloadingWEBM
                        ? chrome.i18n.getMessage("downloadingLabel")
                        : chrome.i18n.getMessage("downloadWEBMButtonTitle")}
                    </div>
                    <div className={styles.buttonDescription}>
                      {!contentState.isFfmpegRunning
                        ? chrome.i18n.getMessage(
                          "downloadWEBMButtonDescription"
                        )
                        : getPreparingLabel()}
                    </div>
                  </div>
                  <div className={styles.buttonRight}>
                    <ReactSVG src={EXT_URL + "editor/icons/right-arrow.svg"} />
                  </div>
                </div>
              )}
              <div
                role="button"
                className={styles.button}
                onClick={() => {
                  // disabled on a div is meaningless; gate click manually.
                  // Not gated on isFfmpegRunning: it leaks from background
                  // poll handlers and would intermittently swallow the
                  // click. downloadGIF self-locks via downloadingGIF.
                  if (
                    contentState.downloadingGIF ||
                    contentState.duration > 30 ||
                    !contentState.mp4ready ||
                    contentState.noffmpeg
                  ) {
                    return;
                  }
                  contentState.downloadGIF();
                }}
                disabled={
                  contentState.downloadingGIF ||
                  contentState.duration > 30 ||
                  !contentState.mp4ready ||
                  contentState.noffmpeg
                }
              >
                <div className={styles.buttonLeft}>
                  <ReactSVG src={EXT_URL + "editor/icons/gif.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    {contentState.downloadingGIF
                      ? chrome.i18n.getMessage("downloadingLabel")
                      : chrome.i18n.getMessage("downloadGIFButtonTitle")}
                  </div>
                  <div className={styles.buttonDescription}>
                    {contentState.offline && !contentState.ffmpegLoaded
                      ? chrome.i18n.getMessage("noConnectionLabel")
                      : contentState.updateChrome ||
                        contentState.noffmpeg ||
                        (contentState.duration > contentState.editLimit &&
                          !contentState.override)
                        ? getNotAvailableLabel()
                        : contentState.mp4ready
                          ? chrome.i18n.getMessage("downloadGIFButtonDescription")
                          : getPreparingLabel()}
                  </div>
                </div>
                <div className={styles.buttonRight}>
                  <ReactSVG src={EXT_URL + "editor/icons/right-arrow.svg"} />
                </div>
              </div>
            </div>
          </div>
          <div className={styles.section}>
            <div className={styles.sectionTitle}>
              {chrome.i18n.getMessage("sandboxAdvancedTitle")}
            </div>
            <div className={styles.buttonWrap}>
              <div
                role="button"
                className={styles.button}
                onClick={() => {
                  handleRawRecording();
                }}
              >
                <div className={styles.buttonLeft}>
                  <ReactSVG src={EXT_URL + "editor/icons/download.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    {chrome.i18n.getMessage("rawRecordingButtonTitle")}
                  </div>
                  <div className={styles.buttonDescription}>
                    {chrome.i18n.getMessage("rawRecordingButtonDescription")}
                  </div>
                </div>
                <div className={styles.buttonRight}>
                  <ReactSVG src={EXT_URL + "editor/icons/right-arrow.svg"} />
                </div>
              </div>
              <div
                role="button"
                className={styles.button}
                onClick={() => {
                  handleTroubleshooting();
                }}
              >
                <div className={styles.buttonLeft}>
                  <ReactSVG src={EXT_URL + "editor/icons/flag.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    {chrome.i18n.getMessage("troubleshootButtonTitle")}
                  </div>
                  <div className={styles.buttonDescription}>
                    {chrome.i18n.getMessage("troubleshootButtonDescription")}
                  </div>
                </div>
                <div className={styles.buttonRight}>
                  <ReactSVG src={EXT_URL + "editor/icons/right-arrow.svg"} />
                </div>
              </div>
              <div
                role="button"
                className={styles.button}
                onClick={handleDebugMeetingState}
              >
                <div className={styles.buttonLeft}>
                  <ReactSVG src={EXT_URL + "editor/icons/flag.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>Debug Slingui / Meeting</div>
                  <div className={styles.buttonDescription}>
                    Ver meetingId, tokens, chunks e fontes salvas no console
                  </div>
                </div>
                <div className={styles.buttonRight}>
                  <ReactSVG src={EXT_URL + "editor/icons/right-arrow.svg"} />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default RightPanel;

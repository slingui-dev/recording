import React, { useMemo, useState } from "react";
import { resolveMeetingIdFromContext } from "../../../../utils/meetingAudioChunks";

const formatValue = (value) => (value == null || value === "" ? "—" : String(value));

const RecordingInfo = ({ contentState }) => {
  const [open, setOpen] = useState(false);
  const meetingContext =
    contentState?.recordingMeta?.meetingContext ||
    contentState?.meetingAudioChunks?.meetingContext ||
    null;
  const meetingId = resolveMeetingIdFromContext(
    meetingContext,
    new URLSearchParams(window.location.search).get("recordingId"),
  );
  const chunks = Array.isArray(contentState?.meetingAudioChunks?.chunks)
    ? contentState.meetingAudioChunks.chunks
    : [];
  const downloaded = chunks.filter((chunk) => chunk?.audioBlob).length;
  const diagnostics = useMemo(
    () => ({
      recordingId: new URLSearchParams(window.location.search).get("recordingId"),
      meetingId,
      videoType: contentState?.blob?.type || contentState?.rawBlob?.type,
      editorReady: Boolean(contentState?.ready),
      chunkStatus: contentState?.meetingAudioChunksStatus,
      chunksFound: chunks.length,
      chunksDownloaded: downloaded,
      audioMix: contentState?.meetingAudioChunksApplied
        ? "applied"
        : contentState?.applyingMeetingAudioChunks
          ? "applying"
          : "not-applied",
      error: contentState?.meetingAudioChunksError,
    }),
    [contentState, meetingId, chunks.length, downloaded],
  );

  const pendingChunkStatuses = new Set([
    "loading",
    "waiting-auth",
    "auth-timeout",
    "auth-required",
    "requesting",
    "downloading",
    "mixing",
  ]);
  const chunksArePending = pendingChunkStatuses.has(diagnostics.chunkStatus);
  const chunkStatusLabel = {
    loading: "Preparing audio sync…",
    "waiting-auth": "Waiting for sign-in…",
    "auth-timeout": "Sign-in required to sync audio",
    "auth-required": "Sign-in required to sync audio",
    requesting: "Finding meeting audio…",
    downloading: "Syncing meeting audio…",
    mixing: "Adding meeting audio…",
  }[diagnostics.chunkStatus];

  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
    } catch {}
  };

  return (
    <div className="recording-info">
      {chunksArePending && (
        <div className="recording-info-syncing" role="status" aria-live="polite">
          <span className="recording-info-spinner" aria-hidden="true" />
          <span>{chunkStatusLabel || "Syncing meeting audio…"}</span>
        </div>
      )}
      <button type="button" className="recording-info-button" onClick={() => setOpen((value) => !value)}>
        {open ? "Close info" : chunksArePending ? "Recording info · syncing" : "Recording info"}
      </button>
      {open && (
        <div className="recording-info-panel" role="dialog" aria-label="Recording information">
          <div className="recording-info-title">Recording information</div>
          <div className="recording-info-grid">
            <span>Meeting ID</span><strong>{formatValue(diagnostics.meetingId)}</strong>
            <span>Recording ID</span><strong>{formatValue(diagnostics.recordingId)}</strong>
            <span>Video</span><strong>{formatValue(diagnostics.videoType)}</strong>
            <span>Editor</span><strong>{diagnostics.editorReady ? "ready" : "preparing"}</strong>
            <span>Audio chunks</span><strong>{diagnostics.chunksDownloaded}/{diagnostics.chunksFound} downloaded</strong>
            <span>Chunk status</span><strong>{formatValue(diagnostics.chunkStatus)}</strong>
            <span>Audio mix</span><strong>{diagnostics.audioMix}</strong>
            {diagnostics.error && <><span>Error</span><strong className="recording-info-error">{diagnostics.error}</strong></>}
          </div>
          <button type="button" className="recording-info-copy" onClick={copyDiagnostics}>Copy diagnostics</button>
        </div>
      )}
    </div>
  );
};

export default RecordingInfo;

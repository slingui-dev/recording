import React, { useEffect, useRef, useState } from "react";

import { getUser, login } from "../../utils/slingui-auth";

// Lazy-load each video op so editorwebcodecs.html mounts without
// pulling the ~630KB mediabunny chunk until the user invokes one.
const lazyUtil = (importFn) =>
  (...args) =>
    importFn().then((m) => m.default(...args));
const addAudioToVideo = lazyUtil(() => import("./utils/addAudioToVideo"));
const addMeetingAudioChunksToVideo = lazyUtil(() =>
  import("./utils/addMeetingAudioChunksToVideo"),
);
const convertWebmToMp4 = lazyUtil(() => import("./utils/convertWebmToMp4"));
const cropVideo = lazyUtil(() => import("./utils/cropVideo"));
const cutVideo = lazyUtil(() => import("./utils/cutVideo"));
const muteVideo = lazyUtil(() => import("./utils/muteVideo"));
const reencodeVideo = lazyUtil(() => import("./utils/reencodeVideo"));
const toGIF = lazyUtil(() => import("./utils/toGIF"));
const getFrame = lazyUtil(() => import("./utils/getFrame"));
const hasAudio = lazyUtil(() => import("./utils/hasAudio"));
const convertMp4ToWebm = lazyUtil(() => import("./utils/convertMp4ToWebm"));
const blobToArrayBuffer = lazyUtil(() => import("./utils/blobToArrayBuffer"));

const API_BASE = process.env.SCREENITY_API_BASE_URL || "https://api.slingui.com";
const MEETING_AUDIO_CHUNK_DOWNLOAD_CONCURRENCY = 4;
const MEETING_AUDIO_CHUNK_STALE_RETRY_DELAYS_MS = [1000, 1500, 2000, 2500, 3000];

const isPostStopMode = () => {
  try {
    return new URLSearchParams(window.location.search).get("mode") === "postStop";
  } catch {
    return false;
  }
};

const firstNonEmptyValue = (values) => {
  const value = values.find(
    (candidate) =>
      (typeof candidate === "string" && candidate.trim()) ||
      typeof candidate === "number",
  );

  return value == null ? null : String(value).trim();
};

const resolveMeetingIdFromContext = (meetingContext, fallbackRecordingId = null) => {
  if (!meetingContext || typeof meetingContext !== "object") {
    return fallbackRecordingId ? String(fallbackRecordingId).trim() : null;
  }

  // Prefer explicit/technical identifiers. Human-readable names like
  // `name`/`roomName` are intentionally only fallbacks because classroom names
  // such as "teste" are not necessarily the meetingId used to upload chunks.
  return firstNonEmptyValue([
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
    fallbackRecordingId,
    meetingContext.meetingName,
    meetingContext.roomName,
    meetingContext.classroom?.name,
    meetingContext.classroomName,
    meetingContext.name,
  ]);
};

const resolveAudioChunksToken = async (preferredUser = null) => {
  if (preferredUser && !preferredUser.expired && preferredUser.access_token) {
    return preferredUser.access_token;
  }

  try {
    const user = await getUser();
    if (user && !user.expired && user.access_token) {
      return user.access_token;
    }
  } catch (error) {
    console.warn("[EditorWebCodecs][MeetingAudioChunks] Failed to read Slingui user", error);
  }

  try {
    const { screenityToken } = await chrome.storage.local.get(["screenityToken"]);
    if (screenityToken) return screenityToken;
  } catch {
    // ignore storage fallback failures
  }

  return null;
};

const decodeBase64UrlJson = (value) => {
  const normalized = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const binary = window.atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return JSON.parse(new TextDecoder().decode(bytes));
};

const decodeMeetingAudioChunkMetadata = (fileName) => {
  const fileNameWithoutExtension = String(fileName || "").replace(/\.(mp3|webm|opus|ogg|m4a|aac)$/i, "");
  const parts = fileNameWithoutExtension.split("-");
  const metadataCandidates = [fileNameWithoutExtension];

  for (let index = 1; index < parts.length; index += 1) {
    metadataCandidates.push(parts.slice(index).join("-"));
  }

  for (const metadataToken of metadataCandidates) {
    if (!metadataToken) continue;

    try {
      const compactMetadata = decodeBase64UrlJson(metadataToken);
      if (!Array.isArray(compactMetadata)) continue;

      const [
        version,
        sequence,
        startedAtEpochMs,
        durationMs,
        sampleRate,
        totalSamples,
        isFinalChunk,
      ] = compactMetadata;

      return {
        version,
        sequence,
        startedAtEpochMs,
        startedAt: startedAtEpochMs ? new Date(startedAtEpochMs).toISOString() : null,
        durationMs,
        sampleRate,
        totalSamples,
        isFinalChunk: Boolean(isFinalChunk),
      };
    } catch {
      // Try the next suffix. This supports meetingId/prefix values containing
      // hyphens while preserving base64url tokens that may also contain hyphens.
    }
  }

  console.warn("[EditorWebCodecs][MeetingAudioChunks] Failed to decode chunk metadata", {
    fileName,
  });
  return null;
};

const toFiniteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const toEpochMs = (value) => {
  if (value == null || value === "") return null;

  const numeric = toFiniteNumber(value);
  if (numeric != null) {
    return numeric > 0 && numeric < 100000000000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const resolveMeetingAudioChunkStartedAtMs = (chunk) =>
  toEpochMs(chunk?.startedAtEpochMs) ??
  toEpochMs(chunk?.startedAtMs) ??
  toEpochMs(chunk?.startTimeMs) ??
  toEpochMs(chunk?.startedAt) ??
  toEpochMs(chunk?.metadata?.startedAtEpochMs) ??
  toEpochMs(chunk?.metadata?.startedAtMs) ??
  toEpochMs(chunk?.metadata?.startTimeMs) ??
  toEpochMs(chunk?.metadata?.startedAt);

const resolveMeetingAudioChunkDurationFromSamplesMs = (chunk) => {
  const sampleRate = toFiniteNumber(chunk?.sampleRate ?? chunk?.metadata?.sampleRate);
  const totalSamples = toFiniteNumber(chunk?.totalSamples ?? chunk?.metadata?.totalSamples);

  if (!(sampleRate > 0) || !(totalSamples > 0)) return null;
  return (totalSamples / sampleRate) * 1000;
};

const resolveMeetingAudioChunkDurationMs = (chunk) =>
  resolveMeetingAudioChunkDurationFromSamplesMs(chunk) ??
  toFiniteNumber(chunk?.durationMs) ??
  toFiniteNumber(chunk?.duration) ??
  toFiniteNumber(chunk?.metadata?.durationMs) ??
  toFiniteNumber(chunk?.metadata?.duration);

const summarizeMeetingAudioChunkTiming = (audioChunks, recordingStartedAtMs = null) => {
  const chunks = Array.isArray(audioChunks?.chunks) ? audioChunks.chunks : [];
  const timedChunks = chunks
    .map((chunk) => {
      const startedAtMs = resolveMeetingAudioChunkStartedAtMs(chunk);
      const durationMs = resolveMeetingAudioChunkDurationMs(chunk);
      const endedAtMs =
        Number.isFinite(startedAtMs) && Number.isFinite(durationMs) && durationMs > 0
          ? startedAtMs + durationMs
          : null;

      return {
        chunk,
        fileName: chunk?.fileName || null,
        startedAtMs,
        durationMs,
        endedAtMs,
      };
    })
    .filter(({ startedAtMs }) => Number.isFinite(startedAtMs));

  const chunksWithDuration = timedChunks.filter(({ endedAtMs }) => Number.isFinite(endedAtMs));
  const chunkWindowStartedAtMs = timedChunks.length
    ? Math.min(...timedChunks.map(({ startedAtMs }) => startedAtMs))
    : null;
  const chunkWindowEndedAtMs = chunksWithDuration.length
    ? Math.max(...chunksWithDuration.map(({ endedAtMs }) => endedAtMs))
    : null;

  const appearsStaleForRecordingStart = Boolean(
    chunks.length > 0 &&
      Number.isFinite(recordingStartedAtMs) &&
      timedChunks.length === chunks.length &&
      chunksWithDuration.length === timedChunks.length &&
      Number.isFinite(chunkWindowEndedAtMs) &&
      chunkWindowEndedAtMs < recordingStartedAtMs,
  );

  return {
    total: chunks.length,
    timed: timedChunks.length,
    withDuration: chunksWithDuration.length,
    chunkWindowStartedAtMs,
    chunkWindowEndedAtMs,
    latestChunkOffsetFromRecordingStartMs:
      Number.isFinite(recordingStartedAtMs) && Number.isFinite(chunkWindowEndedAtMs)
        ? chunkWindowEndedAtMs - recordingStartedAtMs
        : null,
    appearsStaleForRecordingStart,
    chunks: timedChunks.map(({ fileName, startedAtMs, durationMs, endedAtMs }) => ({
      fileName,
      startedAtMs,
      durationMs,
      endedAtMs,
    })),
  };
};

const resolveRecordingStartFromId = (recordingId) => {
  const match = String(recordingId || "").match(/^(\d{12,14})(?:-|$)/);
  if (!match) return null;

  const startedAtMs = Number(match[1]);
  return Number.isFinite(startedAtMs) ? startedAtMs : null;
};

const normalizeRecordingMetaForPostStop = (recordingMeta, recordingId = null) => {
  if (!recordingMeta || typeof recordingMeta !== "object") {
    const recordingStartedAtMs = resolveRecordingStartFromId(recordingId);
    if (recordingStartedAtMs == null) return null;

    return {
      recordingId: recordingId || null,
      recordingStartedAtMs,
      recordingStartedAt: new Date(recordingStartedAtMs).toISOString(),
      startedAt: recordingStartedAtMs,
      recordingStartedAtSource: "recordingId",
      recoveredFromRecordingId: true,
    };
  }

  const recordingStartedAtMsFromExplicitMs = toEpochMs(recordingMeta.recordingStartedAtMs);
  const recordingStartedAtMsFromIso = toEpochMs(recordingMeta.recordingStartedAt);
  const recordingStartedAtMsFromStartedAt = toEpochMs(recordingMeta.startedAt);
  const recordingStartedAtMsFromId = resolveRecordingStartFromId(
    recordingId || recordingMeta.recordingId,
  );
  const recordingStartedAtMs =
    recordingStartedAtMsFromExplicitMs ??
    recordingStartedAtMsFromIso ??
    recordingStartedAtMsFromStartedAt ??
    recordingStartedAtMsFromId;
  const recordingStartedAtSource = recordingStartedAtMsFromExplicitMs != null
    ? "recordingMeta.recordingStartedAtMs"
    : recordingStartedAtMsFromIso != null
      ? "recordingMeta.recordingStartedAt"
      : recordingStartedAtMsFromStartedAt != null
        ? "recordingMeta.startedAt"
        : recordingStartedAtMsFromId != null
          ? "recordingId"
          : null;

  return {
    ...recordingMeta,
    recordingId: recordingId || recordingMeta.recordingId || null,
    recordingStartedAtMs,
    recordingStartedAt:
      recordingStartedAtMs != null
        ? new Date(recordingStartedAtMs).toISOString()
        : recordingMeta.recordingStartedAt || null,
    startedAt: recordingMeta.startedAt || recordingStartedAtMs || null,
    recordingStartedAtSource,
    recoveredFromRecordingId:
      Boolean(recordingStartedAtMs) && recordingStartedAtSource === "recordingId",
  };
};

const buildMeetingAudioAlignment = (audioChunks, recordingMeta = null) => {
  const recordingStartedAtMs =
    toEpochMs(recordingMeta?.recordingStartedAtMs) ??
    toEpochMs(recordingMeta?.recordingStartedAt) ??
    toEpochMs(recordingMeta?.startedAt) ??
    toEpochMs(audioChunks?.alignment?.recordingStartedAtMs) ??
    toEpochMs(audioChunks?.alignment?.recordingStartedAt);

  return {
    ...(audioChunks?.alignment || {}),
    recordingStartedAtMs,
    recordingStartedAt:
      recordingStartedAtMs != null
        ? new Date(recordingStartedAtMs).toISOString()
        : audioChunks?.alignment?.recordingStartedAt || null,
    recordingStartedAtSource:
      recordingMeta?.recordingStartedAtSource ||
      audioChunks?.alignment?.recordingStartedAtSource ||
      null,
    recoveredFromRecordingId: Boolean(
      recordingMeta?.recoveredFromRecordingId ||
      audioChunks?.alignment?.recoveredFromRecordingId,
    ),
  };
};

const resolveStoredRecordingMetaForPostStop = ({
  recordingId = null,
  recordingMeta = null,
  scopedRecordingMeta = null,
  latestRecordingMeta = null,
  latestRecordingMetaKey = null,
} = {}) => {
  const latestMatchesRecording =
    recordingId && latestRecordingMetaKey && String(latestRecordingMetaKey) === String(recordingId);
  const resolved =
    scopedRecordingMeta || recordingMeta || (latestMatchesRecording ? latestRecordingMeta : null);

  return normalizeRecordingMetaForPostStop(resolved, recordingId);
};

const getMeetingAudioChunkMetadata = (chunk) =>
  chunk?.metadata || decodeMeetingAudioChunkMetadata(chunk?.fileName);

const sortMeetingAudioChunks = (chunks) =>
  [...chunks]
    .map((chunk) => ({
      ...chunk,
      metadata: getMeetingAudioChunkMetadata(chunk),
    }))
    .sort((a, b) => {
      const aStart = toFiniteNumber(a?.startedAtEpochMs ?? a?.metadata?.startedAtEpochMs);
      const bStart = toFiniteNumber(b?.startedAtEpochMs ?? b?.metadata?.startedAtEpochMs);

      if (aStart != null && bStart != null && aStart !== bStart) {
        return aStart - bStart;
      }
      if (aStart != null && bStart == null) return -1;
      if (aStart == null && bStart != null) return 1;

      const aSequence = toFiniteNumber(a?.sequence ?? a?.metadata?.sequence);
      const bSequence = toFiniteNumber(b?.sequence ?? b?.metadata?.sequence);

      if (aSequence != null && bSequence != null && aSequence !== bSequence) {
        return aSequence - bSequence;
      }
      if (aSequence != null && bSequence == null) return -1;
      if (aSequence == null && bSequence != null) return 1;

      return String(a?.fileName || "").localeCompare(String(b?.fileName || ""));
    });

const mapWithConcurrencyLimit = async (items, limit, mapper) => {
  if (!items.length) return [];

  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    }),
  );

  return results;
};

const downloadMeetingAudioChunk = async (chunk) => {
  const metadata = getMeetingAudioChunkMetadata(chunk);

  console.info("[EditorWebCodecs][MeetingAudioChunks] Download chunk start", {
    fileName: chunk?.fileName || null,
    metadata,
    hasSignedUrl: Boolean(chunk?.signedUrl),
  });

  if (!chunk?.signedUrl) {
    console.info("[EditorWebCodecs][MeetingAudioChunks] Download chunk skipped: missing signedUrl", {
      fileName: chunk?.fileName || null,
      metadata,
    });
    return {
      ...chunk,
      metadata,
      audioBlob: null,
      downloadError: "Missing signedUrl",
    };
  }

  try {
    const response = await fetch(chunk.signedUrl);
    console.info("[EditorWebCodecs][MeetingAudioChunks] Download chunk response", {
      fileName: chunk?.fileName || null,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type"),
      contentLength: response.headers.get("content-length"),
    });
    if (!response.ok) {
      throw new Error(`Failed to download audio chunk (${response.status})`);
    }

    const audioBlob = await response.blob();
    const responseContentType = response.headers.get("content-type") || "";
    const audioBlobType = audioBlob.type || responseContentType || chunk?.contentType || chunk?.mimeType || "audio/mpeg";
    console.info("[EditorWebCodecs][MeetingAudioChunks] Download chunk done", {
      fileName: chunk?.fileName || null,
      metadata,
      audioBlobSize: audioBlob.size,
      audioBlobType,
    });
    return {
      ...chunk,
      metadata,
      audioBlob,
      audioBlobSize: audioBlob.size,
      audioBlobType,
    };
  } catch (error) {
    console.warn("[EditorWebCodecs][MeetingAudioChunks] Failed to download audio chunk", {
      fileName: chunk?.fileName,
      error: error?.message || String(error),
    });

    return {
      ...chunk,
      metadata,
      audioBlob: null,
      downloadError: error?.message || String(error),
    };
  }
};

const toSerializableMeetingAudioChunks = (audioChunks) => ({
  ...audioChunks,
  chunks: Array.isArray(audioChunks?.chunks)
    ? audioChunks.chunks.map(({ audioBlob, ...chunk }) => ({
        ...chunk,
        audioBlobSize: chunk.audioBlobSize ?? audioBlob?.size ?? null,
        audioBlobType: chunk.audioBlobType ?? audioBlob?.type ?? null,
        hasAudioBlobInMemory: Boolean(audioBlob),
      }))
    : [],
});

const listMeetingAudioChunks = async (
  meetingContext,
  recordingId = null,
  preferredUser = null,
  {
    recordingStartedAtMs = null,
    attempt = 1,
    cacheBust = false,
    reason = "unknown",
  } = {},
) => {
  const meetingId = resolveMeetingIdFromContext(meetingContext, recordingId);

  console.info("[EditorWebCodecs][MeetingAudioChunks] List start", {
    recordingId,
    meetingId,
    meetingContext,
    hasPreferredUser: Boolean(preferredUser),
    recordingStartedAtMs,
    attempt,
    cacheBust,
    reason,
  });

  if (!meetingId) {
    console.warn("[EditorWebCodecs][MeetingAudioChunks] Missing meetingId", {
      recordingId,
      meetingContext,
    });
    return null;
  }

  const token = await resolveAudioChunksToken(preferredUser);
  console.info("[EditorWebCodecs][MeetingAudioChunks] Token resolved", {
    recordingId,
    meetingId,
    hasToken: Boolean(token),
  });
  if (!token) {
    throw new Error("Missing JWT token for audio chunks request");
  }

  const params = new URLSearchParams({ meetingId });
  if (recordingId) params.set("recordingId", String(recordingId));
  if (Number.isFinite(recordingStartedAtMs)) {
    params.set("recordingStartedAtMs", String(Math.round(recordingStartedAtMs)));
  }
  if (Number.isFinite(attempt)) params.set("attempt", String(attempt));
  if (cacheBust) params.set("_", String(Date.now()));

  const headers = {
    Authorization: `Bearer ${token}`,
  };
  if (cacheBust) {
    headers["Cache-Control"] = "no-cache";
    headers.Pragma = "no-cache";
  }

  const res = await fetch(
    `${API_BASE}/storage/audio/chunks?${params.toString()}`,
    {
      method: "GET",
      headers,
      credentials: "include",
      cache: cacheBust ? "no-store" : "default",
    },
  );

  console.info("[EditorWebCodecs][MeetingAudioChunks] List response", {
    recordingId,
    meetingId,
    attempt,
    cacheBust,
    status: res.status,
    ok: res.ok,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`Failed to list audio chunks (${res.status}): ${errorText}`);
  }

  const data = await res.json();
  const chunks = Array.isArray(data?.chunks)
    ? sortMeetingAudioChunks(data.chunks)
    : [];

  console.info("[EditorWebCodecs][MeetingAudioChunks] List payload", {
    recordingId,
    requestedMeetingId: meetingId,
    responseMeetingId: data?.meetingId || null,
    prefix: data?.prefix || null,
    attempt,
    cacheBust,
    total: chunks.length,
    chunks,
  });

  const enrichedChunks = await mapWithConcurrencyLimit(
    chunks,
    MEETING_AUDIO_CHUNK_DOWNLOAD_CONCURRENCY,
    (chunk) => downloadMeetingAudioChunk(chunk),
  );

  console.info("[EditorWebCodecs][MeetingAudioChunks] List enriched", {
    recordingId,
    meetingId: data?.meetingId || meetingId,
    attempt,
    cacheBust,
    total: enrichedChunks.length,
    downloaded: enrichedChunks.filter((chunk) => chunk.audioBlob instanceof Blob).length,
    failed: enrichedChunks.filter((chunk) => chunk.downloadError).length,
    chunks: enrichedChunks.map(({ signedUrl, audioBlob, ...chunk }) => ({
      ...chunk,
      hasSignedUrl: Boolean(signedUrl),
      audioBlobSize: audioBlob?.size ?? chunk.audioBlobSize ?? null,
      audioBlobType: audioBlob?.type ?? chunk.audioBlobType ?? null,
    })),
  });

  return {
    meetingId: data?.meetingId || meetingId,
    prefix: data?.prefix || null,
    chunks: enrichedChunks,
  };
};

const Sandbox = () => {
  const iframeRef = useRef(null);
  const triggerLoad = useRef(false);
  const ffmpegInstance = useRef(null);
  const mediabunnyLoaded = useRef(false);
  const authAttemptedRef = useRef(false);
  const meetingAudioChunksCheckedRef = useRef(false);
  const meetingAudioChunksRef = useRef(null);
  const meetingAudioChunksRequestPromiseRef = useRef(null);
  const recordingMetaRef = useRef(null);
  const isAuthLoadingRef = useRef(true);
  const slingUserRef = useRef(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isPostStopProcessing, setIsPostStopProcessing] = useState(() => isPostStopMode());
  const [slingUser, setSlingUser] = useState(null);

  const sendMessage = (message) => {
    iframeRef.current?.contentWindow?.postMessage(message, "*");
  };

  const sendAuthStateToIframe = (user, loading = false) => {
    sendMessage({
      type: "slingui-auth-state",
      user,
      loading,
      authenticated: Boolean(user && !user.expired),
    });
  };

  const loadFfmpeg = async () => {
    if (mediabunnyLoaded.current || !triggerLoad.current) return;
    try {
      mediabunnyLoaded.current = true;
      sendMessage({ type: "ffmpeg-loaded" });
    } catch (error) {
      sendMessage({
        type: "ffmpeg-load-error",
        error: JSON.stringify(error),
        fallback: true,
      });
    }
  };

  function isMp4Blob(blob) {
    return blob
      .slice(4, 8)
      .text()
      .then((t) => t === "ftyp");
  }

  const toBase64 = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(blob);
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
    });

  const base64ToWebmBlob = (base64) => {
    const dataURLRegex = /^data:.+;base64,/;
    if (dataURLRegex.test(base64)) base64 = base64.replace(dataURLRegex, "");
    const binary = window.atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: "video/webm" });
  };

  const getPostStopLaunchParams = () => {
    try {
      const params = new URLSearchParams(window.location.search);
      return {
        isPostStop: params.get("mode") === "postStop",
        recordingId: params.get("recordingId") || null,
      };
    } catch {
      return { isPostStop: false, recordingId: null };
    }
  };

  const sendMeetingAudioChunksToIframe = (
    audioChunks = meetingAudioChunksRef.current,
    recordingMeta = recordingMetaRef.current,
    reason = "unknown",
  ) => {
    if (!audioChunks) return false;

    console.info("[EditorWebCodecs][MeetingAudioChunks] Sending chunks to iframe", {
      reason,
      meetingId: audioChunks.meetingId,
      prefix: audioChunks.prefix,
      total: audioChunks.chunks?.length || 0,
      downloaded:
        audioChunks.chunks?.filter((chunk) => chunk.audioBlob instanceof Blob)
          .length || 0,
      hasRecordingMeta: Boolean(recordingMeta),
    });
    sendMessage({
      type: "meeting-audio-chunks",
      audioChunks,
      recordingMeta,
    });
    return true;
  };

  const sendMeetingAudioChunksErrorToIframe = (error, reason = "unknown") => {
    sendMessage({
      type: "meeting-audio-chunks-error",
      reason,
      error: error?.message || String(error || "unknown"),
    });
  };

  const resolveAndSendMeetingAudioChunks = async ({
    force = false,
    reason = "postStop-effect",
    requestedRecordingId = null,
  } = {}) => {
    const { isPostStop, recordingId: launchRecordingId } = getPostStopLaunchParams();
    const recordingId = requestedRecordingId || launchRecordingId || null;

    console.info("[EditorWebCodecs][MeetingAudioChunks] Resolve requested", {
      reason,
      recordingId,
      isPostStop,
      force,
      hasCachedChunks: Boolean(meetingAudioChunksRef.current),
      isAuthLoading: isAuthLoadingRef.current,
      hasSlingUser: Boolean(slingUserRef.current && !slingUserRef.current.expired),
    });

    if (!isPostStop) return null;

    if (meetingAudioChunksRef.current && !force) {
      sendMeetingAudioChunksToIframe(
        meetingAudioChunksRef.current,
        recordingMetaRef.current,
        `${reason}:cached`,
      );
      return meetingAudioChunksRef.current;
    }

    if (isAuthLoadingRef.current) {
      console.info("[EditorWebCodecs][MeetingAudioChunks] Resolve postponed: auth loading", {
        reason,
        recordingId,
      });
      return null;
    }

    if (meetingAudioChunksRequestPromiseRef.current) {
      console.info("[EditorWebCodecs][MeetingAudioChunks] Resolve joined in-flight request", {
        reason,
        recordingId,
      });
      const audioChunks = await meetingAudioChunksRequestPromiseRef.current;
      if (audioChunks) {
        sendMeetingAudioChunksToIframe(
          audioChunks,
          recordingMetaRef.current,
          `${reason}:in-flight-complete`,
        );
      }
      return audioChunks;
    }

    meetingAudioChunksCheckedRef.current = true;
    setIsPostStopProcessing(true);

    const requestPromise = (async () => {
      try {
        const scopedRecordingMetaKey = recordingId
          ? `recordingMeta:${recordingId}`
          : null;
        const storageKeys = [
          "recordingMeta",
          "screenityMeetingState",
          "latestRecordingMeta",
          "latestRecordingMetaKey",
        ];
        if (scopedRecordingMetaKey) storageKeys.push(scopedRecordingMetaKey);

        const storage = await chrome.storage.local.get(storageKeys);
        const {
          recordingMeta = null,
          screenityMeetingState = null,
          latestRecordingMeta = null,
          latestRecordingMetaKey = null,
        } = storage;
        const scopedRecordingMeta = scopedRecordingMetaKey
          ? storage[scopedRecordingMetaKey] || null
          : null;
        const resolvedRecordingMeta = resolveStoredRecordingMetaForPostStop({
          recordingId,
          recordingMeta,
          scopedRecordingMeta,
          latestRecordingMeta,
          latestRecordingMetaKey,
        });

        const meetingContext =
          resolvedRecordingMeta?.meetingContext || screenityMeetingState || null;

        console.info("[EditorWebCodecs][MeetingAudioChunks] PostStop storage context", {
          reason,
          recordingId,
          hasRecordingMeta: Boolean(recordingMeta),
          hasScopedRecordingMeta: Boolean(scopedRecordingMeta),
          hasLatestRecordingMeta: Boolean(latestRecordingMeta),
          latestRecordingMetaKey,
          hasResolvedRecordingMeta: Boolean(resolvedRecordingMeta),
          hasScreenityMeetingState: Boolean(screenityMeetingState),
          recordingMeta,
          scopedRecordingMeta,
          resolvedRecordingMeta,
          screenityMeetingState,
          meetingContext,
        });

        const initialAlignment = buildMeetingAudioAlignment(null, resolvedRecordingMeta);
        const recordingStartedAtMs = initialAlignment.recordingStartedAtMs;
        const maxAttempts = MEETING_AUDIO_CHUNK_STALE_RETRY_DELAYS_MS.length + 1;
        let alignedAudioChunks = null;
        let timingSummary = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          const cacheBust = attempt > 1;
          const audioChunks = await listMeetingAudioChunks(
            meetingContext,
            recordingId,
            slingUserRef.current,
            {
              recordingStartedAtMs,
              attempt,
              cacheBust,
              reason,
            },
          );

          if (!audioChunks) {
            setIsPostStopProcessing(false);
            sendMeetingAudioChunksErrorToIframe(
              new Error("Não foi possível resolver o meetingId dos chunks MP3."),
              reason,
            );
            return null;
          }

          alignedAudioChunks = {
            ...audioChunks,
            alignment: buildMeetingAudioAlignment(audioChunks, resolvedRecordingMeta),
          };
          timingSummary = summarizeMeetingAudioChunkTiming(
            alignedAudioChunks,
            alignedAudioChunks.alignment.recordingStartedAtMs,
          );

          console.info("[EditorWebCodecs][MeetingAudioChunks] List timing summary", {
            reason,
            recordingId,
            meetingId: alignedAudioChunks.meetingId,
            attempt,
            maxAttempts,
            alignment: alignedAudioChunks.alignment,
            timingSummary,
          });

          if (!timingSummary.appearsStaleForRecordingStart) break;

          const retryDelayMs = MEETING_AUDIO_CHUNK_STALE_RETRY_DELAYS_MS[attempt - 1];
          if (!retryDelayMs) {
            console.warn(
              "[EditorWebCodecs][MeetingAudioChunks] List still appears stale after retries; using last response",
              {
                reason,
                recordingId,
                meetingId: alignedAudioChunks.meetingId,
                attempt,
                maxAttempts,
                recordingStartedAtMs,
                timingSummary,
              },
            );
            break;
          }

          console.info(
            "[EditorWebCodecs][MeetingAudioChunks] List appears stale for recording start; retrying with cache bust",
            {
              reason,
              recordingId,
              meetingId: alignedAudioChunks.meetingId,
              attempt,
              nextAttempt: attempt + 1,
              maxAttempts,
              retryDelayMs,
              recordingStartedAtMs,
              timingSummary,
            },
          );
          await sleep(retryDelayMs);
        }

        if (!alignedAudioChunks) {
          setIsPostStopProcessing(false);
          sendMeetingAudioChunksErrorToIframe(
            new Error("Não foi possível carregar chunks MP3 da reunião."),
            reason,
          );
          return null;
        }

        console.info("[EditorWebCodecs][MeetingAudioChunks] Chunks resolved", {
          reason,
          recordingId,
          meetingId: alignedAudioChunks.meetingId,
          prefix: alignedAudioChunks.prefix,
          total: alignedAudioChunks.chunks.length,
          alignment: alignedAudioChunks.alignment,
          timingSummary,
          chunks: alignedAudioChunks.chunks,
          downloaded: alignedAudioChunks.chunks.filter((chunk) => chunk.audioBlob instanceof Blob).length,
        });

        meetingAudioChunksRef.current = alignedAudioChunks;
        recordingMetaRef.current = resolvedRecordingMeta;
        sendMeetingAudioChunksToIframe(alignedAudioChunks, resolvedRecordingMeta, reason);
        setIsPostStopProcessing(false);

        try {
          await chrome.storage.local.set({
            [`meetingAudioChunks:${recordingId || alignedAudioChunks.meetingId}`]:
              toSerializableMeetingAudioChunks(alignedAudioChunks),
            latestMeetingAudioChunks: toSerializableMeetingAudioChunks(alignedAudioChunks),
            latestMeetingAudioChunksKey: recordingId || alignedAudioChunks.meetingId || null,
            latestMeetingDocumentContext: {
              recordingId,
              meetingId: alignedAudioChunks.meetingId || null,
              recordingMeta: resolvedRecordingMeta,
              screenityMeetingState,
              meetingContext,
              capturedAt: Date.now(),
            },
          });
        } catch {
          // Persisting is best-effort; the in-memory postMessage is what matters.
        }

        return alignedAudioChunks;
      } catch (error) {
        console.warn("[EditorWebCodecs][MeetingAudioChunks] Failed to list chunks", {
          reason,
          recordingId,
          error: error?.message || String(error),
        });
        setIsPostStopProcessing(false);
        sendMeetingAudioChunksErrorToIframe(error, reason);
        return null;
      } finally {
        meetingAudioChunksRequestPromiseRef.current = null;
      }
    })();

    meetingAudioChunksRequestPromiseRef.current = requestPromise;
    return requestPromise;
  };

  const onMessage = async (message) => {
    try {
      switch (message.type) {
        case "request-meeting-audio-chunks": {
          console.info("[EditorWebCodecs][MeetingAudioChunks] Iframe requested chunks", {
            recordingId: message.recordingId || null,
            hasCachedChunks: Boolean(meetingAudioChunksRef.current),
            isAuthLoading: isAuthLoadingRef.current,
            hasSlingUser: Boolean(slingUserRef.current && !slingUserRef.current.expired),
          });
          await resolveAndSendMeetingAudioChunks({
            reason: "iframe-request",
            requestedRecordingId: message.recordingId || null,
          });
          break;
        }

        case "load-ffmpeg":
          triggerLoad.current = true;
          await loadFfmpeg();
          break;

        case "add-audio-to-video": {
          const blob = await addAudioToVideo(
            ffmpegInstance.current,
            message.blob,
            message.audio,
            message.duration,
            message.volume,
            message.replaceAudio,
            (progress) =>
              sendMessage({
                type: "ffmpeg-progress",
                progress: Math.round(progress * 100),
              })
          );
          const base64 = await toBase64(blob);
          sendMessage({
            type: "updated-blob",
            base64,
            topLevel: true,
            fromAudio: true,
            skipReencode: true,
            _opId: message._opId,
          });
          break;
        }

        case "apply-meeting-audio-chunks": {
          setIsPostStopProcessing(true);
          console.info("[EditorWebCodecs][MeetingAudioChunks] Apply message received", {
            opId: message._opId ?? null,
            videoBlobSize: message.blob?.size ?? null,
            videoBlobType: message.blob?.type ?? null,
            recordingDuration: message.recordingDuration ?? message.duration ?? null,
            hasRecordingMeta: Boolean(message.recordingMeta),
            meetingId: message.audioChunks?.meetingId || null,
            totalChunks: message.audioChunks?.chunks?.length || 0,
            downloaded: message.audioChunks?.chunks?.filter((chunk) => chunk.audioBlob instanceof Blob).length || 0,
          });
          const blob = await addMeetingAudioChunksToVideo(
            ffmpegInstance.current,
            message.blob,
            message.audioChunks,
            message.recordingMeta,
            message.recordingDuration ?? message.duration,
            (progress) =>
              sendMessage({
                type: "ffmpeg-progress",
                progress: Math.round(progress * 100),
              })
          );
          console.info("[EditorWebCodecs][MeetingAudioChunks] Apply complete, serializing result", {
            opId: message._opId ?? null,
            outputBlobSize: blob?.size ?? null,
            outputBlobType: blob?.type ?? null,
          });
          const base64 = await toBase64(blob);
          sendMessage({
            type: "updated-blob",
            base64,
            topLevel: true,
            meetingAudioChunksApplied: true,
            _opId: message._opId,
          });
          setIsPostStopProcessing(false);
          break;
        }

        case "compress-video": {
          if (typeof message.base64 !== "string" || !message.base64.startsWith("data:")) {
            throw new Error("compress-video: expected data: URL");
          }
          const rawBlob = await fetch(message.base64).then((r) => r.blob());

          const compressed = await reencodeVideo(
            ffmpegInstance.current,
            rawBlob,
            null,
            (progress) =>
              sendMessage({
                type: "compression-progress",
                progress: Math.round(progress * 100),
              })
          );
          const base64 = await toBase64(compressed);
          sendMessage({
            type: "updated-blob",
            base64,
            topLevel: true,
            _opId: message._opId,
          });
          break;
        }

        case "base64-to-blob": {
          if (typeof message.base64 !== "string" || !message.base64.startsWith("data:")) {
            throw new Error("base64-to-blob: expected data: URL");
          }
          const rawBlob = await fetch(message.base64).then((r) => r.blob());

          const header = await rawBlob.slice(4, 8).text();
          const looksMp4 = header === "ftyp";

          if (looksMp4) {
            sendMessage({
              type: "updated-blob",
              base64: message.base64,
              topLevel: true,
            });
            break;
          }

          const webmBlob = base64ToWebmBlob(message.base64);
          const mp4Blob = await convertWebmToMp4(webmBlob, (progress) =>
            sendMessage({
              type: "ffmpeg-progress",
              progress: Math.round(progress * 100),
            })
          );

          const base64 = await toBase64(mp4Blob);
          sendMessage({ type: "updated-blob", base64, topLevel: true });
          break;
        }

        case "blob-to-array-buffer": {
          const arrayBuffer = await blobToArrayBuffer(
            ffmpegInstance.current,
            message.blob
          );
          sendMessage({ type: "updated-array-buffer", arrayBuffer });
          break;
        }

        case "crop-video": {
          const blob = await cropVideo(
            ffmpegInstance.current,
            message.blob,
            {
              x: message.x,
              y: message.y,
              width: message.width,
              height: message.height,
            },
            (progress) => sendMessage({ type: "ffmpeg-progress", progress })
          );
          const base64 = await toBase64(blob);
          sendMessage({ type: "updated-blob", base64, topLevel: true, _opId: message._opId });
          break;
        }

        case "cut-video": {
          const blob = await cutVideo(
            ffmpegInstance.current,
            message.blob,
            message.startTime,
            message.endTime,
            message.cut,
            message.duration,
            message.encode,
            (progress) => sendMessage({ type: "ffmpeg-progress", progress })
          );
          const base64 = await toBase64(blob);
          sendMessage({
            type: "updated-blob",
            base64,
            addToHistory: true,
            topLevel: true,
            _opId: message._opId,
          });
          break;
        }

        case "get-frame": {
          const blob = await getFrame(
            ffmpegInstance.current,
            message.blob,
            message.time
          );
          sendMessage({ type: "new-frame", frame: blob });
          break;
        }

        case "has-audio": {
          const audio = await hasAudio(ffmpegInstance.current, message.video);
          sendMessage({ type: "updated-has-audio", hasAudio: audio });
          break;
        }

        case "mute-video": {
          const blob = await muteVideo(
            ffmpegInstance.current,
            message.blob,
            message.startTime,
            message.endTime,
            message.duration,
            (progress) => sendMessage({ type: "ffmpeg-progress", progress })
          );
          const base64 = await toBase64(blob);
          sendMessage({
            type: "updated-blob",
            base64,
            addToHistory: true,
            topLevel: true,
            _opId: message._opId,
          });
          break;
        }

        case "reencode-video": {
          const blob = await reencodeVideo(
            ffmpegInstance.current,
            message.blob,
            message.duration,
            (progress) =>
              sendMessage({
                type: "ffmpeg-progress",
                progress: Math.round(progress * 100),
              })
          );
          const base64 = await toBase64(blob);
          sendMessage({ type: "updated-blob", base64, topLevel: true, _opId: message._opId });
          break;
        }

        case "to-gif": {
          const blob = await toGIF(ffmpegInstance.current, message.blob);
          const base64 = await toBase64(blob);
          sendMessage({ type: "download-gif", base64 });
          break;
        }

        case "to-webm": {
          if (message.blob?.type === "video/webm") {
            const base64 = await toBase64(message.blob);
            sendMessage({ type: "download-webm", base64 });
            return;
          }

          const result = await convertMp4ToWebm(message.blob, (progress) =>
            sendMessage({
              type: "ffmpeg-progress",
              progress: Math.round(progress * 100),
            })
          );

          const base64 = await toBase64(result);
          sendMessage({ type: "download-webm", base64 });
          break;
        }

        default:
          break;
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack = error instanceof Error ? error.stack : null;

      if (message.type === "apply-meeting-audio-chunks") {
        setIsPostStopProcessing(false);
      }

      // Error props are non-enumerable; JSON.stringify drops them.
      console.error("[Screenity][EditorWebCodecs] op failed", {
        type: message.type,
        message: errMsg,
        stack: errStack,
        opId: message._opId,
      });

      if (errMsg.includes("too long")) {
        sendMessage({ type: "edit-too-long", _opId: message._opId });
      } else if (errMsg.includes("background-audio-too-large")) {
        sendMessage({ type: "audio-too-large", _opId: message._opId });
      } else {
        sendMessage({
          type: "ffmpeg-error",
          error: errMsg || "unknown",
          errorStack: errStack,
          errorMessage: errMsg,
          opType: message.type,
          _opId: message._opId,
        });
      }
    }
  };

  useEffect(() => {
    const handler = (event) => onMessage(event.data);
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  useEffect(() => {
    isAuthLoadingRef.current = isAuthLoading;
  }, [isAuthLoading]);

  useEffect(() => {
    slingUserRef.current = slingUser;
  }, [slingUser]);

  useEffect(() => {
    const authenticateOnLoad = async () => {
      if (authAttemptedRef.current) return;
      authAttemptedRef.current = true;
      setIsAuthLoading(true);

      try {
        const storedUser = await getUser();
        if (storedUser && !storedUser.expired) {
          setSlingUser(storedUser);
          sendAuthStateToIframe(storedUser, false);
          return;
        }

        const authenticatedUser = await login();
        setSlingUser(authenticatedUser);
        sendAuthStateToIframe(authenticatedUser, false);
      } catch (error) {
        console.error("Slingui authentication on editor load failed:", error);
        setSlingUser(null);
        sendAuthStateToIframe(null, false);
      } finally {
        setIsAuthLoading(false);
      }
    };

    authenticateOnLoad();
  }, []);

  useEffect(() => {
    if (meetingAudioChunksCheckedRef.current) return;
    const { isPostStop } = getPostStopLaunchParams();
    if (!isPostStop) return;
    if (isAuthLoading) return;

    resolveAndSendMeetingAudioChunks({ reason: "postStop-effect" });
  }, [isAuthLoading, slingUser]);

  const handleIframeLoad = () => {
    sendAuthStateToIframe(slingUser, isAuthLoading);
    if (meetingAudioChunksRef.current) {
      sendMeetingAudioChunksToIframe(
        meetingAudioChunksRef.current,
        recordingMetaRef.current,
        "iframe-load",
      );
    }
  };

  const showBlockingSplash = isAuthLoading || isPostStopProcessing;

  // Bridge editor-force-close from BG to the sandboxed iframe via
  // postMessage; sandbox.html has no chrome.runtime access. Also
  // clear the parent's beforeunload if set.
  useEffect(() => {
    const onRuntimeMessage = (message, _sender, sendResponse) => {
      if (message?.type !== "editor-force-close") return;
      try {
        window.onbeforeunload = null;
      } catch {}
      try {
        iframeRef.current?.contentWindow?.postMessage(
          { type: "editor-force-close" },
          "*",
        );
      } catch {}
      try {
        sendResponse?.({ ok: true });
      } catch {}
    };
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    return () => chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  }, []);

  useEffect(() => {
    const storageHandler = (changes, areaName) => {
      if (areaName !== "local") return;
      if (!changes.editorRecordingError) return;
      const payload = changes.editorRecordingError.newValue;
      if (!payload) return;
      try {
        iframeRef.current?.contentWindow?.postMessage(
          { type: "recording-error-from-parent", payload },
          "*",
        );
      } catch {}
    };
    chrome.storage.onChanged.addListener(storageHandler);
    const respondWithLatest = () => {
      chrome.storage.local.get(["editorRecordingError"]).then((res) => {
        if (!res?.editorRecordingError) return;
        try {
          iframeRef.current?.contentWindow?.postMessage(
            {
              type: "recording-error-from-parent",
              payload: res.editorRecordingError,
            },
            "*",
          );
        } catch {}
      });
    };
    const requestHandler = (event) => {
      if (event?.data?.type === "request-recording-error-state") {
        respondWithLatest();
      }
    };
    window.addEventListener("message", requestHandler);
    respondWithLatest();
    return () => {
      chrome.storage.onChanged.removeListener(storageHandler);
      window.removeEventListener("message", requestHandler);
    };
  }, []);

  return (
    <div>
      <iframe
        ref={iframeRef}
        src={`sandbox.html${window.location.search || ""}`}
        allowFullScreen
        onLoad={handleIframeLoad}
        style={{
          width: "100%",
          border: "none",
          height: "100vh",
          position: "absolute",
          top: 0,
          left: 0,
          visibility: showBlockingSplash ? "hidden" : "visible",
        }}
      />
      {showBlockingSplash && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: 16,
            background: "#ffffff",
            fontFamily:
              "Inter, Satoshi, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          }}
        >
          <div
            style={{
              width: 180,
              height: 180,
              borderRadius: 32,
              background: "#ffffff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <img
              src={chrome.runtime.getURL("assets/logo.png")}
              alt="Slingui"
              style={{
                width: 96,
                height: 96,
                objectFit: "contain",
                animation: "slingui-post-stop-pulse 1.4s ease-in-out infinite",
              }}
            />
          </div>
          <style>{`
            @keyframes slingui-post-stop-pulse {
              0%, 100% { opacity: 0.2; }
              50% { opacity: 1; }
            }
          `}</style>
        </div>
      )}
    </div>
  );
};

export default Sandbox;

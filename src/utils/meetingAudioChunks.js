const DEFAULT_API_BASE =
  process.env.SCREENITY_API_BASE_URL || "https://api.slingui.com";

export const MEETING_AUDIO_CHUNKS_ENDPOINT = "/storage/audio/chunks";

const noop = () => {};
const DEFAULT_CHUNK_DOWNLOAD_CONCURRENCY = 4;

const firstNonEmptyValue = (values) => {
  const value = values.find(
    (candidate) =>
      (typeof candidate === "string" && candidate.trim()) ||
      typeof candidate === "number",
  );

  return value == null ? null : String(value).trim();
};

export const resolveMeetingIdFromContext = (
  meetingContext,
  fallbackRecordingId = null,
) => {
  if (!meetingContext || typeof meetingContext !== "object") {
    return fallbackRecordingId ? String(fallbackRecordingId).trim() : null;
  }

  // Prefer explicit/technical identifiers. Human-readable names are kept only
  // as last-resort fallbacks because the API expects the same meetingId used
  // when the chunks were uploaded.
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

export const decodeMeetingAudioChunkMetadata = (fileName, { warn = noop } = {}) => {
  const fileNameWithoutExtension = String(fileName || "").replace(
    /\.(mp3|webm|opus|ogg|m4a|aac)$/i,
    "",
  );
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

  warn("failed to decode chunk metadata", { fileName });
  return null;
};

const toFiniteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const getMeetingAudioChunkMetadata = (chunk, { warn = noop } = {}) =>
  chunk?.metadata || decodeMeetingAudioChunkMetadata(chunk?.fileName, { warn });

export const sortMeetingAudioChunks = (chunks, { warn = noop } = {}) =>
  [...chunks]
    .map((chunk) => ({
      ...chunk,
      metadata: getMeetingAudioChunkMetadata(chunk, { warn }),
    }))
    .sort((a, b) => {
      const aStart = toFiniteNumber(
        a?.startedAtEpochMs ?? a?.metadata?.startedAtEpochMs,
      );
      const bStart = toFiniteNumber(
        b?.startedAtEpochMs ?? b?.metadata?.startedAtEpochMs,
      );

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

export const summarizeMeetingAudioChunk = (chunk) => ({
  fileName: chunk?.fileName || null,
  sequence: chunk?.sequence ?? chunk?.metadata?.sequence ?? null,
  startedAt: chunk?.startedAt ?? chunk?.metadata?.startedAt ?? null,
  startedAtEpochMs:
    chunk?.startedAtEpochMs ?? chunk?.metadata?.startedAtEpochMs ?? null,
  durationMs: chunk?.durationMs ?? chunk?.metadata?.durationMs ?? null,
  sampleRate: chunk?.sampleRate ?? chunk?.metadata?.sampleRate ?? null,
  totalSamples: chunk?.totalSamples ?? chunk?.metadata?.totalSamples ?? null,
  isFinalChunk: chunk?.isFinalChunk ?? chunk?.metadata?.isFinalChunk ?? null,
  signedUrlPresent: Boolean(chunk?.signedUrl),
  audioBlobSize: chunk?.audioBlob?.size ?? chunk?.audioBlobSize ?? null,
  audioBlobType: chunk?.audioBlob?.type ?? chunk?.audioBlobType ?? null,
  downloadError: chunk?.downloadError || null,
});

export const downloadMeetingAudioChunk = async (
  chunk,
  { log = noop, warn = noop } = {},
) => {
  const metadata =
    chunk?.metadata || decodeMeetingAudioChunkMetadata(chunk?.fileName, { warn });

  log("download chunk start", {
    chunk: summarizeMeetingAudioChunk({ ...chunk, metadata }),
  });

  if (chunk?.audioBlob instanceof Blob) {
    log("download chunk skipped: already in memory", {
      chunk: summarizeMeetingAudioChunk({ ...chunk, metadata }),
    });
    return {
      ...chunk,
      metadata,
      audioBlobSize: chunk.audioBlobSize ?? chunk.audioBlob.size,
      audioBlobType:
        chunk.audioBlobType ??
        chunk.audioBlob.type ??
        chunk?.contentType ??
        chunk?.mimeType ??
        "audio/mpeg",
    };
  }

  if (!chunk?.signedUrl) {
    log("download chunk skipped: missing signedUrl", {
      chunk: summarizeMeetingAudioChunk({ ...chunk, metadata }),
    });
    return {
      ...chunk,
      metadata,
      audioBlob: null,
      downloadError: chunk?.downloadError || "Missing signedUrl",
    };
  }

  try {
    const response = await fetch(chunk.signedUrl);
    log("download chunk response", {
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
    const audioBlobType =
      audioBlob.type ||
      responseContentType ||
      chunk?.contentType ||
      chunk?.mimeType ||
      "audio/mpeg";
    log("download chunk done", {
      chunk: summarizeMeetingAudioChunk({
        ...chunk,
        metadata,
        audioBlob,
        audioBlobSize: audioBlob.size,
        audioBlobType,
      }),
    });
    return {
      ...chunk,
      metadata,
      audioBlob,
      audioBlobSize: audioBlob.size,
      audioBlobType,
    };
  } catch (error) {
    warn("failed to download audio chunk", {
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

export const listMeetingAudioChunks = async ({
  meetingContext,
  recordingId = null,
  token,
  resolveToken,
  apiBase = DEFAULT_API_BASE,
  downloadChunks = true,
  downloadConcurrency = DEFAULT_CHUNK_DOWNLOAD_CONCURRENCY,
  returnEmptyOnMissingMeetingId = false,
  log = noop,
  warn = noop,
} = {}) => {
  const meetingId = resolveMeetingIdFromContext(meetingContext, recordingId);

  log("list start", {
    recordingId,
    meetingId,
    meetingContext,
    apiBase,
  });

  if (!meetingId) {
    warn("missing meetingId", { recordingId, meetingContext });
    return returnEmptyOnMissingMeetingId
      ? { meetingId: null, prefix: null, chunks: [] }
      : null;
  }

  const resolvedToken = token || (resolveToken ? await resolveToken() : null);
  log("token resolved", {
    recordingId,
    meetingId,
    hasToken: Boolean(resolvedToken),
  });
  if (!resolvedToken) {
    throw new Error("Missing JWT token for audio chunks request");
  }

  const res = await fetch(
    `${apiBase}${MEETING_AUDIO_CHUNKS_ENDPOINT}?meetingId=${encodeURIComponent(
      meetingId,
    )}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${resolvedToken}`,
      },
      credentials: "include",
    },
  );

  log("list response", {
    recordingId,
    meetingId,
    status: res.status,
    ok: res.ok,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`Failed to list audio chunks (${res.status}): ${errorText}`);
  }

  const data = await res.json();
  const chunks = Array.isArray(data?.chunks)
    ? sortMeetingAudioChunks(data.chunks, { warn })
    : [];

  log("list payload", {
    recordingId,
    requestedMeetingId: meetingId,
    responseMeetingId: data?.meetingId || null,
    prefix: data?.prefix || null,
    total: chunks.length,
    chunks: chunks.map(summarizeMeetingAudioChunk),
  });

  const resolvedChunks = downloadChunks
    ? await mapWithConcurrencyLimit(
        chunks,
        downloadConcurrency,
        (chunk) => downloadMeetingAudioChunk(chunk, { log, warn }),
      )
    : chunks;

  log("list enriched", {
    recordingId,
    meetingId: data?.meetingId || meetingId,
    total: resolvedChunks.length,
    downloaded: resolvedChunks.filter((chunk) => chunk.audioBlob instanceof Blob)
      .length,
    failed: resolvedChunks.filter((chunk) => chunk.downloadError).length,
    chunks: resolvedChunks.map(summarizeMeetingAudioChunk),
  });

  return {
    meetingId: data?.meetingId || meetingId,
    prefix: data?.prefix || null,
    chunks: resolvedChunks,
  };
};
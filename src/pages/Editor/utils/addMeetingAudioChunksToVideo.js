import { VideoAudioMixer } from "../mediabunny/lib/videoAudioMixer.ts";

const LOG_PREFIX = "[EditorWebCodecs][MeetingAudioChunks][Normalize]";

const isAudioBlob = (value) =>
  Boolean(
    value &&
      typeof value.arrayBuffer === "function" &&
      Number.isFinite(value.size) &&
      value.size > 0,
  );

const logInfo = (message, payload = null) => {
  if (payload == null) {
    console.info(`${LOG_PREFIX} ${message}`);
    return;
  }
  console.info(`${LOG_PREFIX} ${message}`, payload);
};

const summarizeChunkForLog = (chunk) => ({
  fileName: chunk?.fileName || null,
  sequence: chunk?.sequence ?? chunk?.metadata?.sequence ?? null,
  offsetMs: chunk?.offsetMs ?? null,
  originalOffsetMs: chunk?.originalOffsetMs ?? null,
  sourceStartMs: chunk?.sourceStartMs ?? null,
  durationMs: chunk?.durationMs ?? chunk?.metadata?.durationMs ?? null,
  durationFromSamplesMs: chunk?.durationFromSamplesMs ?? null,
  maxDurationMs: chunk?.maxDurationMs ?? null,
  startedAt: chunk?.startedAt ?? chunk?.metadata?.startedAt ?? null,
  startedAtEpochMs:
    chunk?.startedAtEpochMs ?? chunk?.metadata?.startedAtEpochMs ?? null,
  endedAtEpochMs: chunk?.endedAtEpochMs ?? null,
  sampleRate: chunk?.sampleRate ?? chunk?.metadata?.sampleRate ?? null,
  totalSamples: chunk?.totalSamples ?? chunk?.metadata?.totalSamples ?? null,
  isFinalChunk: chunk?.isFinalChunk ?? chunk?.metadata?.isFinalChunk ?? null,
  gapFromPreviousMs: chunk?.gapFromPreviousMs ?? null,
  hasReliableOffset: chunk?.hasReliableOffset ?? null,
  audioBlobSize: chunk?.audioBlob?.size ?? chunk?.audioBlobSize ?? null,
  audioBlobType: chunk?.audioBlob?.type ?? chunk?.audioBlobType ?? null,
});

const toNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const toEpochMs = (value) => {
  if (value == null || value === "") return null;

  const numeric = toNumber(value);
  if (numeric != null) {
    // Epoch timestamps may arrive as seconds from some APIs and milliseconds
    // from the chunk filename metadata. Normalize likely seconds to ms.
    return numeric > 0 && numeric < 100000000000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const resolveChunkStartedAtMs = (chunk) =>
  toEpochMs(chunk?.startedAtEpochMs) ??
  toEpochMs(chunk?.startedAt) ??
  toEpochMs(chunk?.metadata?.startedAtEpochMs) ??
  toEpochMs(chunk?.metadata?.startedAt);

const resolveChunkDurationMs = (chunk) =>
  resolveChunkDurationFromSamplesMs(chunk) ??
  toNumber(chunk?.durationMs) ??
  toNumber(chunk?.metadata?.durationMs);

const resolveChunkDurationFromSamplesMs = (chunk) => {
  const totalSamples = toNumber(chunk?.totalSamples) ?? toNumber(chunk?.metadata?.totalSamples);
  const sampleRate = toNumber(chunk?.sampleRate) ?? toNumber(chunk?.metadata?.sampleRate);
  if (totalSamples != null && totalSamples > 0 && sampleRate != null && sampleRate > 0) {
    return (totalSamples / sampleRate) * 1000;
  }
  return null;
};

const resolveRecordingStartedAtMs = (recordingMeta) =>
  toEpochMs(recordingMeta?.startedAt) ??
  toEpochMs(recordingMeta?.meetingStartedAt) ??
  toEpochMs(recordingMeta?.meetingContext?.startedAt) ??
  toEpochMs(recordingMeta?.meetingContext?.startTime);

const resolveRecordingDurationMs = (recordingDurationSeconds) => {
  const duration = toNumber(recordingDurationSeconds);
  return duration != null && duration > 0 ? duration * 1000 : null;
};

const resolveSequence = (chunk, fallbackIndex = 0) =>
  toNumber(chunk?.sequence) ?? toNumber(chunk?.metadata?.sequence) ?? fallbackIndex;

const hasMeaningfulVariation = (values) => {
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (finiteValues.length < 2) return false;

  const min = Math.min(...finiteValues);
  const max = Math.max(...finiteValues);
  // Treat tiny differences as jitter, not as timeline positioning.
  return max - min > 5;
};

const resolveStartedAtAnchorMs = (preparedChunks, recordingStartedAtMs) => {
  const startedAts = preparedChunks
    .map(({ startedAtMs }) => startedAtMs)
    .filter((value) => Number.isFinite(value));

  if (!startedAts.length) return null;

  const firstStartedAtMs = Math.min(...startedAts);
  if (recordingStartedAtMs == null) return firstStartedAtMs;

  return recordingStartedAtMs;
};

const normalizeMeetingAudioChunks = (
  audioChunks,
  recordingMeta = null,
  recordingDurationSeconds = null,
) => {
  const recordingStartedAtMs = resolveRecordingStartedAtMs(recordingMeta);
  const recordingDurationMs = resolveRecordingDurationMs(recordingDurationSeconds);

  logInfo("input", {
    meetingId: audioChunks?.meetingId || null,
    prefix: audioChunks?.prefix || null,
    totalChunks: Array.isArray(audioChunks?.chunks) ? audioChunks.chunks.length : 0,
    downloadedChunks: Array.isArray(audioChunks?.chunks)
      ? audioChunks.chunks.filter((chunk) => isAudioBlob(chunk?.audioBlob)).length
      : 0,
    recordingStartedAtMs,
    recordingStartedAt: recordingStartedAtMs
      ? new Date(recordingStartedAtMs).toISOString()
      : null,
    recordingDurationSeconds,
    recordingDurationMs,
    recordingMeta,
    chunks: Array.isArray(audioChunks?.chunks)
      ? audioChunks.chunks.map(summarizeChunkForLog)
      : [],
  });

  const preparedChunks = (Array.isArray(audioChunks?.chunks) ? audioChunks.chunks : [])
    .filter((chunk) => isAudioBlob(chunk?.audioBlob))
    .map((chunk, index) => ({
      chunk,
      index,
      explicitOffsetMs: toNumber(chunk.offsetMs) ?? toNumber(chunk.metadata?.offsetMs),
      startedAtMs: resolveChunkStartedAtMs(chunk),
      durationMs: resolveChunkDurationMs(chunk),
      metadataDurationMs: toNumber(chunk?.durationMs) ?? toNumber(chunk?.metadata?.durationMs),
      durationFromSamplesMs: resolveChunkDurationFromSamplesMs(chunk),
      sequence: resolveSequence(chunk, index),
    }))
    .sort((a, b) => {
      const sequenceDiff = (a.sequence ?? a.index) - (b.sequence ?? b.index);
      if (sequenceDiff) return sequenceDiff;
      return a.index - b.index;
    });

  const explicitOffsets = preparedChunks.map(({ explicitOffsetMs }) => explicitOffsetMs);
  const startedAts = preparedChunks.map(({ startedAtMs }) => startedAtMs);
  const hasExplicitOffset = explicitOffsets.some((value) => Number.isFinite(value));
  const hasStartedAt = startedAts.some((value) => Number.isFinite(value));
  const explicitOffsetsAreUseful =
    hasExplicitOffset &&
    (hasMeaningfulVariation(explicitOffsets) || preparedChunks.length === 1);
  const startedAtsAreUseful =
    hasStartedAt &&
    (hasMeaningfulVariation(startedAts) || recordingStartedAtMs != null);
  const startedAtAnchorMs = startedAtsAreUseful
    ? resolveStartedAtAnchorMs(preparedChunks, recordingStartedAtMs)
    : null;

  const sampleTimelineCandidate =
    preparedChunks.length > 1 &&
    preparedChunks.every(
      ({ durationFromSamplesMs, sequence, chunk }) =>
        Number.isFinite(durationFromSamplesMs) &&
        durationFromSamplesMs > 0 &&
        Number.isFinite(sequence) &&
        (toNumber(chunk?.sampleRate) ?? toNumber(chunk?.metadata?.sampleRate)) != null,
    ) &&
    preparedChunks.every((prepared, index) => {
      if (index === 0) return true;
      return prepared.sequence === preparedChunks[index - 1].sequence + 1;
    });

  let cumulativeSampleDurationMs = 0;
  const sampleTimelineDiagnostics = preparedChunks.map((prepared, index) => {
    const previous = index > 0 ? preparedChunks[index - 1] : null;
    const wallClockGapVsSamplesMs =
      previous?.startedAtMs != null &&
      prepared.startedAtMs != null &&
      previous.durationFromSamplesMs != null
        ? prepared.startedAtMs - (previous.startedAtMs + previous.durationFromSamplesMs)
        : null;
    const expectedStartedAtFromSamplesMs =
      preparedChunks[0]?.startedAtMs != null
        ? preparedChunks[0].startedAtMs + cumulativeSampleDurationMs
        : null;
    const driftFromSampleTimelineMs =
      prepared.startedAtMs != null && expectedStartedAtFromSamplesMs != null
        ? prepared.startedAtMs - expectedStartedAtFromSamplesMs
        : null;
    const diagnostic = {
      index,
      sequence: prepared.sequence,
      fileName: prepared.chunk?.fileName || null,
      startedAtMs: prepared.startedAtMs,
      durationMs: prepared.durationMs,
      metadataDurationMs: prepared.metadataDurationMs,
      durationFromSamplesMs: prepared.durationFromSamplesMs,
      expectedStartedAtFromSamplesMs,
      wallClockGapVsSamplesMs,
      driftFromSampleTimelineMs,
    };
    cumulativeSampleDurationMs += prepared.durationFromSamplesMs || 0;
    return diagnostic;
  });
  const maxAbsWallClockGapVsSamplesMs = sampleTimelineDiagnostics.reduce(
    (max, diagnostic) =>
      diagnostic.wallClockGapVsSamplesMs == null
        ? max
        : Math.max(max, Math.abs(diagnostic.wallClockGapVsSamplesMs)),
    0,
  );
  const sampleTimelineOffsetsAreSafe =
    sampleTimelineCandidate &&
    (!hasStartedAt || maxAbsWallClockGapVsSamplesMs <= 25);

  const firstPrepared = preparedChunks[0] || null;
  const sampleTimelineAnchorOffsetMs = (() => {
    if (!sampleTimelineOffsetsAreSafe || !firstPrepared) return null;
    if (explicitOffsetsAreUseful && firstPrepared.explicitOffsetMs != null) {
      return firstPrepared.explicitOffsetMs;
    }
    if (
      startedAtsAreUseful &&
      firstPrepared.startedAtMs != null &&
      startedAtAnchorMs != null
    ) {
      return firstPrepared.startedAtMs - startedAtAnchorMs;
    }
    return 0;
  })();

  logInfo("offset strategy", {
    preparedCount: preparedChunks.length,
    explicitOffsets,
    startedAts,
    hasExplicitOffset,
    hasStartedAt,
    explicitOffsetsAreUseful,
    startedAtsAreUseful,
    startedAtAnchorMs,
    startedAtAnchor: startedAtAnchorMs
      ? new Date(startedAtAnchorMs).toISOString()
      : null,
    sampleTimelineCandidate,
    sampleTimelineOffsetsAreSafe,
    sampleTimelineAnchorOffsetMs,
    maxAbsWallClockGapVsSamplesMs,
    sampleTimelineDiagnostics,
  });

  let sequenceOffsetMs = 0;
  let sampleTimelineOffsetMs = 0;

  let previousPrepared = null;

  const normalizedChunks = preparedChunks
    .map(({ chunk, index, explicitOffsetMs, startedAtMs, durationMs, sequence }) => {
      const currentSampleTimelineOffsetMs = sampleTimelineOffsetMs;
      const durationFromSamplesMs = resolveChunkDurationFromSamplesMs(chunk);
      if (durationFromSamplesMs != null && durationFromSamplesMs > 0) {
        sampleTimelineOffsetMs += durationFromSamplesMs;
      }

      const hasReliableOffset =
        sampleTimelineOffsetsAreSafe ||
        (explicitOffsetsAreUseful && explicitOffsetMs != null) ||
        (startedAtsAreUseful && startedAtMs != null && startedAtAnchorMs != null);

      let offsetMs = sampleTimelineOffsetsAreSafe
        ? (sampleTimelineAnchorOffsetMs || 0) + currentSampleTimelineOffsetMs
        : null;
      if (offsetMs == null && explicitOffsetsAreUseful) {
        offsetMs = explicitOffsetMs;
      }
      if (
        offsetMs == null &&
        startedAtsAreUseful &&
        startedAtMs != null &&
        startedAtAnchorMs != null
      ) {
        offsetMs = startedAtMs - startedAtAnchorMs;
      }
      if (offsetMs == null) {
        offsetMs = sequenceOffsetMs;
      }

      if (durationMs != null && durationMs > 0) {
        sequenceOffsetMs += durationMs;
      }

      const rawOffsetMs = offsetMs || 0;
      const sourceStartMs = Math.max(0, -rawOffsetMs);
      const effectiveOffsetMs = Math.max(0, rawOffsetMs);

      if (recordingDurationMs != null) {
        if (effectiveOffsetMs >= recordingDurationMs) {
          logInfo("dropping chunk after recording end", {
            chunk: summarizeChunkForLog(chunk),
            rawOffsetMs,
            effectiveOffsetMs,
            recordingDurationMs,
          });
          return null;
        }

        if (durationMs != null && durationMs > 0) {
          const remainingChunkDurationMs = durationMs - sourceStartMs;
          const remainingRecordingDurationMs =
            recordingDurationMs - effectiveOffsetMs;

          if (
            remainingChunkDurationMs <= 0 ||
            remainingRecordingDurationMs <= 0
          ) {
            logInfo("dropping chunk without overlap", {
              chunk: summarizeChunkForLog(chunk),
              rawOffsetMs,
              sourceStartMs,
              effectiveOffsetMs,
              durationMs,
              remainingChunkDurationMs,
              remainingRecordingDurationMs,
              recordingDurationMs,
            });
            return null;
          }
        }
      }
      const metadataDurationMs = toNumber(chunk?.durationMs) ?? toNumber(chunk?.metadata?.durationMs);
      const endedAtEpochMs =
        startedAtMs != null && durationMs != null ? startedAtMs + durationMs : null;
      const previousEndedAtEpochMs =
        previousPrepared?.startedAtMs != null && previousPrepared?.durationMs != null
          ? previousPrepared.startedAtMs + previousPrepared.durationMs
          : null;
      const gapFromPreviousMs =
        startedAtMs != null && previousEndedAtEpochMs != null
          ? startedAtMs - previousEndedAtEpochMs
          : null;

      previousPrepared = { startedAtMs, durationMs };

      const maxDurationMs =
        durationMs != null && durationMs > 0 && recordingDurationMs != null
          ? Math.min(
              durationMs - sourceStartMs,
              recordingDurationMs - effectiveOffsetMs,
            )
          : null;

      return {
        ...chunk,
        index,
        sequence,
        audioBlob: chunk.audioBlob,
        offsetMs: effectiveOffsetMs,
        originalOffsetMs: rawOffsetMs,
        sourceStartMs,
        durationMs,
        metadataDurationMs,
        durationFromSamplesMs,
        endedAtEpochMs,
        gapFromPreviousMs,
        maxDurationMs,
        hasReliableOffset,
        offsetPolicy: sampleTimelineOffsetsAreSafe
          ? "sample-continuous"
          : explicitOffsetsAreUseful
            ? "explicit-offset"
            : startedAtsAreUseful
              ? "startedAtEpochMs"
              : "sequence-duration",
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const offsetDiff = (a.offsetMs || 0) - (b.offsetMs || 0);
      if (offsetDiff) return offsetDiff;
      return (
        (toNumber(a.sequence) ?? toNumber(a.metadata?.sequence) ?? a.index ?? 0) -
        (toNumber(b.sequence) ?? toNumber(b.metadata?.sequence) ?? b.index ?? 0)
      );
    });

  logInfo("normalized output", {
    pipeline: "WebAudio decode + sample-timeline mix + Mediabunny MP4/AAC mux",
    durationPolicy:
      "Prefer totalSamples/sampleRate from filename metadata; fallback to metadata durationMs; fallback later to decoded duration.",
    offsetPolicy:
      sampleTimelineOffsetsAreSafe
        ? "Use first reliable anchor plus cumulative totalSamples/sampleRate for every chunk to avoid wall-clock ms rounding gaps/overlaps."
        : "Use startedAtEpochMs anchored to recording start when available; otherwise sequence timeline.",
    normalizedCount: normalizedChunks.length,
    chunks: normalizedChunks.map(summarizeChunkForLog),
    gaps: normalizedChunks.map((chunk, index) => ({
      index,
      sequence: chunk.sequence,
      fileName: chunk.fileName || null,
      startedAtEpochMs: chunk.startedAtEpochMs ?? chunk.metadata?.startedAtEpochMs ?? null,
      endedAtEpochMs: chunk.endedAtEpochMs,
      gapFromPreviousMs: chunk.gapFromPreviousMs,
      durationMs: chunk.durationMs,
      metadataDurationMs: chunk.metadataDurationMs,
      durationFromSamplesMs: chunk.durationFromSamplesMs,
    })),
  });

  return normalizedChunks;
};

async function addMeetingAudioChunksToVideo(
  ffmpeg,
  videoBlob,
  audioChunks,
  recordingMeta = null,
  recordingDurationSeconds = null,
  onProgress,
) {
  const startedAt = performance.now();
  const inputChunks = Array.isArray(audioChunks?.chunks) ? audioChunks.chunks : [];
  const downloadedChunkCount = inputChunks.filter((chunk) =>
    isAudioBlob(chunk?.audioBlob),
  ).length;

  logInfo("apply start", {
    hasVideoBlob: videoBlob instanceof Blob,
    videoBlobSize: videoBlob?.size ?? null,
    videoBlobType: videoBlob?.type ?? null,
    meetingId: audioChunks?.meetingId || null,
    inputChunkCount: inputChunks.length,
    downloadedChunkCount,
    recordingDurationSeconds,
  });

  if (typeof recordingDurationSeconds === "function" && onProgress == null) {
    onProgress = recordingDurationSeconds;
    recordingDurationSeconds = null;
  }

  const chunks = normalizeMeetingAudioChunks(
    audioChunks,
    recordingMeta,
    recordingDurationSeconds,
  );

  if (!chunks.length) {
    // The storage list can contain chunks for the wider meeting that do not
    // overlap this particular recording. They were downloaded successfully,
    // but normalization excluded them using the recording's time window; this
    // is a valid no-op, not a failed mix.
    if (downloadedChunkCount) {
      const fallbackReason = "no-meeting-audio-overlaps-recording";
      logInfo("apply completed summary", {
        ok: true,
        elapsedMs: Math.round(performance.now() - startedAt),
        videoInputSize: videoBlob?.size ?? null,
        videoInputType: videoBlob?.type ?? null,
        inputChunkCount: inputChunks.length,
        downloadedChunkCount,
        normalizedChunkCount: 0,
        outputBlobSize: videoBlob?.size ?? null,
        outputBlobType: videoBlob?.type ?? null,
        fallbackReason,
      });
      return videoBlob;
    }

    const error = new Error("No downloaded meeting audio chunks to mix");
    logInfo("apply completed summary", {
      ok: false,
      elapsedMs: Math.round(performance.now() - startedAt),
      videoInputSize: videoBlob?.size ?? null,
      videoInputType: videoBlob?.type ?? null,
      inputChunkCount: inputChunks.length,
      downloadedChunkCount,
      normalizedChunkCount: 0,
      fallbackReason: error.message,
    });
    throw error;
  }

  const mixer = new VideoAudioMixer();
  logInfo("mixer policy", {
    mode: "mix",
    videoVolume: 1,
    chunksVolume: 1,
    reason:
      "Preserve the original recording audio track (tab/system/microphone) and add external meeting chunks on top. This avoids dropping microphone/tab audio during post-stop meeting audio recovery.",
  });
  try {
    const mixedBlob = await mixer.addAudioChunks(videoBlob, chunks, {
      mode: "mix",
      videoVolume: 1,
      chunksVolume: 1,
      onProgress,
    });

    logInfo("apply done", {
      outputBlobSize: mixedBlob?.size ?? null,
      outputBlobType: mixedBlob?.type ?? null,
    });
    logInfo("apply completed summary", {
      ok: true,
      elapsedMs: Math.round(performance.now() - startedAt),
      videoInputSize: videoBlob?.size ?? null,
      videoInputType: videoBlob?.type ?? null,
      inputChunkCount: inputChunks.length,
      downloadedChunkCount,
      normalizedChunkCount: chunks.length,
      outputBlobSize: mixedBlob?.size ?? null,
      outputBlobType: mixedBlob?.type ?? null,
      fallbackReason: null,
    });

    return mixedBlob;
  } catch (error) {
    logInfo("apply completed summary", {
      ok: false,
      elapsedMs: Math.round(performance.now() - startedAt),
      videoInputSize: videoBlob?.size ?? null,
      videoInputType: videoBlob?.type ?? null,
      inputChunkCount: inputChunks.length,
      downloadedChunkCount,
      normalizedChunkCount: chunks.length,
      outputBlobSize: null,
      outputBlobType: null,
      fallbackReason: error?.message || String(error),
    });
    throw error;
  }
}

export default addMeetingAudioChunksToVideo;

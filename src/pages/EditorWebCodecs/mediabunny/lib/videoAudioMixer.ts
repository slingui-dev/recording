// @ts-nocheck
import {
  Input,
  BlobSource,
  Output,
  BufferTarget,
  Mp4OutputFormat,
  VideoSampleSource,
  AudioSampleSource,
  AudioSampleSink,
  VideoSampleSink,
  AudioSample,
  ALL_FORMATS,
  QUALITY_HIGH,
} from "mediabunny";
import { videoConverter } from "./videoConverter";

const MIXER_LOG_PREFIX = "[EditorWebCodecs][MeetingAudioChunks][Mixer]";

const mixerLog = (message, payload = null) => {
  if (payload == null) {
    console.info(`${MIXER_LOG_PREFIX} ${message}`);
    return;
  }
  console.info(`${MIXER_LOG_PREFIX} ${message}`, payload);
};

const summarizeMixerChunk = (chunk) => ({
  fileName: chunk?.fileName || null,
  sequence: chunk?.sequence ?? chunk?.metadata?.sequence ?? null,
  offsetMs: chunk?.offsetMs ?? null,
  effectiveOffsetMs: chunk?.effectiveOffsetMs ?? null,
  sourceStartMs: chunk?.sourceStartMs ?? null,
  durationMs: chunk?.durationMs ?? null,
  maxDurationMs: chunk?.maxDurationMs ?? null,
  writableDurationMs: chunk?.writableDurationMs ?? null,
  hasReliableOffset: chunk?.hasReliableOffset ?? null,
  audioBlobSize: chunk?.audioBlob?.size ?? null,
  audioBlobType: chunk?.audioBlob?.type ?? null,
  metadataDurationMs: chunk?.metadataDurationMs ?? chunk?.metadata?.durationMs ?? null,
  durationFromSamplesMs: chunk?.durationFromSamplesMs ?? null,
  sampleRate: chunk?.sampleRate ?? chunk?.metadata?.sampleRate ?? null,
  totalSamples: chunk?.totalSamples ?? chunk?.metadata?.totalSamples ?? null,
  startedAtEpochMs: chunk?.startedAtEpochMs ?? chunk?.metadata?.startedAtEpochMs ?? null,
  endedAtEpochMs: chunk?.endedAtEpochMs ?? null,
  gapFromPreviousMs: chunk?.gapFromPreviousMs ?? null,
  isFinalChunk: chunk?.isFinalChunk ?? chunk?.metadata?.isFinalChunk ?? null,
  continuousDecode: chunk?.continuousDecode ?? null,
  continuousSourceStartSamples: chunk?.continuousSourceStartSamples ?? null,
  continuousSourceEndSamples: chunk?.continuousSourceEndSamples ?? null,
  continuousBoundaryPaddingSamples:
    chunk?.continuousBoundaryPaddingSamples ?? null,
  continuousMetadataSampleRate: chunk?.continuousMetadataSampleRate ?? null,
  continuousDecodedSampleRate: chunk?.continuousDecodedSampleRate ?? null,
  continuousMetadataStartSamples: chunk?.continuousMetadataStartSamples ?? null,
  continuousMetadataEndSamples: chunk?.continuousMetadataEndSamples ?? null,
  continuousSourceStartMs: chunk?.continuousSourceStartMs ?? null,
  continuousSourceEndMs: chunk?.continuousSourceEndMs ?? null,
  continuousLeadingPaddingSamples:
    chunk?.continuousLeadingPaddingSamples ?? null,
  continuousTrailingPaddingSamples:
    chunk?.continuousTrailingPaddingSamples ?? null,
  continuousExpectedDecodedSamples:
    chunk?.continuousExpectedDecodedSamples ?? null,
  continuousDecodedSampleDelta:
    chunk?.continuousDecodedSampleDelta ?? null,
  decodedDuration: chunk?.decodedAudio?.duration ?? null,
  decodedDurationMs: chunk?.decodedAudio?.duration ? chunk.decodedAudio.duration * 1000 : null,
  decodedLengthSamples: chunk?.decodedAudio?.length ?? null,
  decodedSampleRate: chunk?.decodedAudio?.sampleRate ?? null,
  decodedChannels: chunk?.decodedAudio?.numberOfChannels ?? null,
});

const toFiniteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const getMetadataSampleRate = (chunk) =>
  toFiniteNumber(chunk?.sampleRate) ?? toFiniteNumber(chunk?.metadata?.sampleRate);

const getMetadataTotalSamples = (chunk) =>
  toFiniteNumber(chunk?.totalSamples) ?? toFiniteNumber(chunk?.metadata?.totalSamples);

const getDurationFromSamplesMs = (chunk) => {
  const totalSamples = getMetadataTotalSamples(chunk);
  const sampleRate = getMetadataSampleRate(chunk);
  if (totalSamples != null && totalSamples > 0 && sampleRate != null && sampleRate > 0) {
    return (totalSamples / sampleRate) * 1000;
  }
  return null;
};

const getMp3DecoderDelaySamples = (decodedSampleRate, metadataSampleRate) => {
  const decodedRate = toFiniteNumber(decodedSampleRate);
  const metadataRate = toFiniteNumber(metadataSampleRate) || decodedRate;

  if (!decodedRate || !metadataRate) return 0;

  // Most browser MP3 decoders expose the usual MPEG/LAME priming delay when
  // gapless metadata is unavailable or stripped by chunking. Compensate it once
  // for the continuous stream, never once per chunk boundary.
  return Math.round((1105 / metadataRate) * decodedRate);
};

const getAudioChunkMimeType = (chunk) =>
  String(
    chunk?.audioBlob?.type ||
      chunk?.audioBlobType ||
      chunk?.contentType ||
      chunk?.mimeType ||
      "",
  ).toLowerCase();

const getAudioChunkExtension = (chunk) => {
  const match = String(chunk?.fileName || "").match(/\.([a-z0-9]+)$/i);
  return match?.[1]?.toLowerCase() || "";
};

const getAudioChunkContainer = (chunk) => {
  const mimeType = getAudioChunkMimeType(chunk);
  const extension = getAudioChunkExtension(chunk);
  if (mimeType.includes("webm") || extension === "webm") return "webm";
  if (mimeType.includes("opus") || extension === "opus") return "opus";
  if (mimeType.includes("ogg") || extension === "ogg") return "ogg";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3") || extension === "mp3") return "mp3";
  return extension || mimeType || "unknown";
};

const isMp3AudioChunk = (chunk) => getAudioChunkContainer(chunk) === "mp3";

const isContinuousAudioTimelineCandidate = (chunks) => {
  if (!Array.isArray(chunks) || chunks.length < 2) return false;
  const containers = chunks.map(getAudioChunkContainer).filter(Boolean);
  const hasMixedKnownContainers = new Set(containers.filter((value) => value !== "unknown")).size > 1;
  if (hasMixedKnownContainers) return false;

  return chunks.every(
    (chunk) =>
      chunk?.audioBlob instanceof Blob &&
      getMetadataSampleRate(chunk) != null &&
      getMetadataTotalSamples(chunk) != null &&
      (chunk?.sequence != null || chunk?.metadata?.sequence != null),
  );
};

export class VideoAudioMixer {
  async addAudio(
    videoBlob,
    audioBlob,
    {
      mode = "mix",
      videoVolume = 0.7,
      audioVolume = 0.3,
      loop = false,
      verbose = false,
      onProgress,
    } = {}
  ) {
    const input = new Input({
      source: new BlobSource(videoBlob),
      formats: ALL_FORMATS,
    });

    const outputTarget = new BufferTarget();
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: outputTarget,
    });

    const videoTrack = await input.getPrimaryVideoTrack();
    const videoSink = new VideoSampleSink(videoTrack);
    const codecInfo = await videoConverter.detectBestCodec("mp4");
    const videoCodec = codecInfo?.codec ?? "avc";
    const videoSource = new VideoSampleSource({
      codec: videoCodec,
      bitrate: QUALITY_HIGH,
    });
    output.addVideoTrack(videoSource);

    const videoDuration = await this._getDuration(videoBlob);

    const videoAudioTrack = await input.getPrimaryAudioTrack().catch(() => null);
    const hasVideoAudio =
      !!videoAudioTrack && (await videoAudioTrack.canDecode().catch(() => false));

    const audioSource = new AudioSampleSource({
      codec: "aac",
      bitrate: 128000,
    });
    output.addAudioTrack(audioSource);

    if (audioBlob.size > 50_000_000) {
      throw new Error("background-audio-too-large");
    }
    let bgArrayBuffer = await audioBlob.arrayBuffer();
    const audioCtx = new AudioContext();
    let decodedAudio;
    try {
      decodedAudio = await audioCtx.decodeAudioData(bgArrayBuffer);
      bgArrayBuffer = null;
    } finally {
      audioCtx.close().catch(() => {});
    }
    const bgSr = decodedAudio.sampleRate;
    const bgDur = decodedAudio.duration;
    const bgData = decodedAudio.getChannelData(0);
    const bgLen = bgData.length;

    const bgSampleAt = (tSec) => {
      // Zero-duration BG would NaN through the modulo below.
      if (!(bgDur > 0)) return 0;
      let t = tSec;
      if (loop) {
        t = ((t % bgDur) + bgDur) % bgDur;
      } else if (t < 0 || t >= bgDur) {
        return 0;
      }
      const idx = t * bgSr;
      const i0 = Math.floor(idx);
      if (i0 < 0 || i0 >= bgLen) return 0;
      const frac = idx - i0;
      const s0 = bgData[i0];
      const s1 = i0 + 1 < bgLen ? bgData[i0 + 1] : s0;
      return s0 + (s1 - s0) * frac;
    };

    await output.start();

    for await (const frame of videoSink.samples(0, videoDuration)) {
      await videoSource.add(frame);
      frame.close();
      if (onProgress && videoDuration > 0)
        onProgress((frame.timestamp / videoDuration) * 0.8);
    }

    if (hasVideoAudio && mode === "mix") {
      const audioSink = new AudioSampleSink(videoAudioTrack);
      let lastSr = bgSr;
      let lastNumCh = 1;
      let lastEnd = 0;
      for await (const sample of audioSink.samples()) {
        const numCh = sample.numberOfChannels;
        const sr = sample.sampleRate;
        const N = sample.numberOfFrames;
        const ts = sample.timestamp;
        lastSr = sr;
        lastNumCh = numCh;

        const mixed = new Float32Array(N * numCh);
        for (let ch = 0; ch < numCh; ch++) {
          const plane = mixed.subarray(ch * N, (ch + 1) * N);
          sample.copyTo(plane, { format: "f32-planar", planeIndex: ch });
        }
        for (let ch = 0; ch < numCh; ch++) {
          const offset = ch * N;
          for (let f = 0; f < N; f++) {
            const t = ts + f / sr;
            mixed[offset + f] =
              mixed[offset + f] * videoVolume + bgSampleAt(t) * audioVolume;
          }
        }

        const out = new AudioSample({
          data: mixed,
          format: "f32-planar",
          numberOfChannels: numCh,
          sampleRate: sr,
          timestamp: ts,
          duration: N / sr,
        });
        await audioSource.add(out);
        out.close();
        sample.close();
        lastEnd = ts + N / sr;
        if (onProgress && videoDuration > 0)
          onProgress(0.8 + Math.min(1, ts / videoDuration) * 0.2);
      }

      // Source audio shorter than video: fill remainder with BG only.
      if (lastEnd < videoDuration - 0.01) {
        const sr = lastSr;
        const numCh = lastNumCh;
        const totalFrames = Math.floor((videoDuration - lastEnd) * sr);
        const chunkFrames = sr * 2;
        let frame = 0;
        while (frame < totalFrames) {
          const n = Math.min(chunkFrames, totalFrames - frame);
          const chunk = new Float32Array(n * numCh);
          for (let ch = 0; ch < numCh; ch++) {
            const offset = ch * n;
            for (let f = 0; f < n; f++) {
              const t = lastEnd + (frame + f) / sr;
              chunk[offset + f] = bgSampleAt(t) * audioVolume;
            }
          }
          const out = new AudioSample({
            data: chunk,
            format: "f32-planar",
            numberOfChannels: numCh,
            sampleRate: sr,
            timestamp: lastEnd + frame / sr,
            duration: n / sr,
          });
          await audioSource.add(out);
          out.close();
          frame += n;
        }
      }
    } else {
      const sr = bgSr;
      const totalFrames = Math.floor(videoDuration * sr);
      const chunkFrames = sr * 2;
      let frame = 0;
      while (frame < totalFrames) {
        const n = Math.min(chunkFrames, totalFrames - frame);
        const chunk = new Float32Array(n);
        for (let f = 0; f < n; f++) {
          const t = (frame + f) / sr;
          chunk[f] = bgSampleAt(t) * audioVolume;
        }
        const out = new AudioSample({
          data: chunk,
          format: "f32-planar",
          numberOfChannels: 1,
          sampleRate: sr,
          timestamp: frame / sr,
          duration: n / sr,
        });
        await audioSource.add(out);
        out.close();
        frame += n;
        if (onProgress && totalFrames > 0)
          onProgress(0.8 + (frame / totalFrames) * 0.2);
      }
    }

    await output.finalize();
    return new Blob([outputTarget.buffer], { type: "video/mp4" });
  }

  async addAudioChunks(
    videoBlob,
    audioChunks = [],
    {
      mode = "mix",
      videoVolume = 0.7,
      chunksVolume = 1,
      onProgress,
    } = {}
  ) {
    mixerLog("start", {
      videoBlobSize: videoBlob?.size ?? null,
      videoBlobType: videoBlob?.type ?? null,
      receivedChunks: Array.isArray(audioChunks) ? audioChunks.length : 0,
      options: { mode, videoVolume, chunksVolume },
      chunks: Array.isArray(audioChunks) ? audioChunks.map(summarizeMixerChunk) : [],
    });

    const chunks = Array.isArray(audioChunks)
      ? audioChunks.filter((chunk) => chunk?.audioBlob instanceof Blob)
      : [];

    if (!chunks.length) {
      mixerLog("no downloadable chunks", { receivedChunks: audioChunks?.length || 0 });
      throw new Error("No meeting audio chunks available to mix");
    }

    const input = new Input({
      source: new BlobSource(videoBlob),
      formats: ALL_FORMATS,
    });

    const outputTarget = new BufferTarget();
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: outputTarget,
    });

    const videoTrack = await input.getPrimaryVideoTrack();
    const videoSink = new VideoSampleSink(videoTrack);
    const codecInfo = await videoConverter.detectBestCodec("mp4");
    const videoCodec = codecInfo?.codec ?? "avc";
    mixerLog("video track resolved", { codecInfo, videoCodec });
    const videoSource = new VideoSampleSource({
      codec: videoCodec,
      bitrate: QUALITY_HIGH,
    });
    output.addVideoTrack(videoSource);

    const videoDuration = await this._getDuration(videoBlob);
    mixerLog("video duration", { videoDuration, videoDurationMs: videoDuration * 1000 });
    if (videoDuration > 900) {
      throw new Error(
        `Video is too long for in-browser audio mixing (${Math.round(videoDuration / 60)} min). ` +
          `Maximum supported length is 15 minutes.`
      );
    }

    const hasVideoAudio = await input
      .getPrimaryAudioTrack()
      .then((t) => !!t)
      .catch(() => false);
    mixerLog("video audio track", { hasVideoAudio, mode });

    const decodedChunks = [];
    let sr = 48000;
    const decodeChunksIndividually = async () => {
      const individuallyDecodedChunks = [];
      let detectedSampleRate = sr;

      for (const chunk of chunks) {
        const audioCtx = new AudioContext();
        try {
          mixerLog("decode chunk start", summarizeMixerChunk(chunk));
          const buffer = await chunk.audioBlob.arrayBuffer();
          const decodedAudio = await audioCtx.decodeAudioData(buffer);
          if (!individuallyDecodedChunks.length) {
            detectedSampleRate = decodedAudio.sampleRate || detectedSampleRate;
          }
          const decodedChunk = {
            ...chunk,
            decodedAudio,
            offsetMs: Number.isFinite(Number(chunk.offsetMs))
              ? Number(chunk.offsetMs)
              : 0,
            sourceStartMs: Number.isFinite(Number(chunk.sourceStartMs))
              ? Math.max(0, Number(chunk.sourceStartMs))
              : 0,
            durationMs: Number.isFinite(Number(chunk.durationMs))
              ? Number(chunk.durationMs)
              : decodedAudio.duration * 1000,
            maxDurationMs: Number.isFinite(Number(chunk.maxDurationMs))
              ? Number(chunk.maxDurationMs)
              : null,
            hasReliableOffset: chunk.hasReliableOffset === true,
          };
          individuallyDecodedChunks.push(decodedChunk);
          mixerLog("decode chunk done", summarizeMixerChunk(decodedChunk));
        } catch (error) {
          mixerLog("decode chunk failed", {
            chunk: summarizeMixerChunk(chunk),
            error: error?.message || String(error),
          });
          throw error;
        } finally {
          audioCtx.close().catch(() => {});
        }
      }

      return { decoded: individuallyDecodedChunks, sampleRate: detectedSampleRate };
    };

    const continuousTimelineCandidate = isContinuousAudioTimelineCandidate(chunks);
    const continuousContainer = continuousTimelineCandidate
      ? getAudioChunkContainer(chunks[0])
      : null;
    const continuousUsesMp3PaddingModel = continuousTimelineCandidate && chunks.every(isMp3AudioChunk);
    mixerLog("decode strategy", {
      continuousTimelineCandidate,
      continuousContainer,
      continuousUsesMp3PaddingModel,
      strategy: continuousTimelineCandidate
        ? "concat-audio-blobs-then-single-decode"
        : "decode-each-chunk-individually",
      reason: continuousTimelineCandidate
        ? "Chunks include sequence + sample metadata; meeting encoder is expected to emit one continuous audio timeline (MP3 or WebM/Opus)."
        : "Insufficient metadata or mixed containers for safe continuous audio decode.",
      chunks: chunks.map(summarizeMixerChunk),
    });

    if (continuousTimelineCandidate) {
      const audioCtx = new AudioContext();
      try {
        const concatenatedAudioBlob = new Blob(
          chunks.map((chunk) => chunk.audioBlob),
          { type: chunks[0]?.audioBlob?.type || "audio/mpeg" },
        );
        const expectedSamples = chunks.reduce(
          (sum, chunk) => sum + (getMetadataTotalSamples(chunk) || 0),
          0,
        );
        const metadataSampleRate = getMetadataSampleRate(chunks[0]);
        mixerLog("decode continuous audio start", {
          concatenatedBlobSize: concatenatedAudioBlob.size,
          concatenatedBlobType: concatenatedAudioBlob.type,
          continuousContainer,
          expectedSamples,
          metadataSampleRate,
          expectedDurationMs:
            expectedSamples && metadataSampleRate
              ? (expectedSamples / metadataSampleRate) * 1000
              : null,
        });
        const decodedAudio = await audioCtx.decodeAudioData(
          await concatenatedAudioBlob.arrayBuffer(),
        );
        sr = decodedAudio.sampleRate || sr;
        const expectedDecodedSamples = chunks.reduce((sum, chunk) => {
          const metadataSamples = getMetadataTotalSamples(chunk) || 0;
          const chunkSampleRate = getMetadataSampleRate(chunk) || metadataSampleRate;
          if (!metadataSamples || !chunkSampleRate) return sum;
          return sum + Math.round((metadataSamples / chunkSampleRate) * sr);
        }, 0);
        const decodedSampleDelta = decodedAudio.length - expectedDecodedSamples;
        const expectedDecoderDelaySamples = continuousUsesMp3PaddingModel
          ? getMp3DecoderDelaySamples(sr, metadataSampleRate)
          : 0;
        const maxSafeGlobalPaddingSamples = Math.round(sr * 0.25);
        const shouldTrimGlobalMp3Padding =
          decodedSampleDelta > 0 &&
          decodedSampleDelta <= maxSafeGlobalPaddingSamples &&
          expectedDecodedSamples > 0 &&
          decodedAudio.length >= expectedDecodedSamples;
        const continuousLeadingPaddingSamples = shouldTrimGlobalMp3Padding
          ? Math.min(expectedDecoderDelaySamples, decodedSampleDelta)
          : 0;
        const continuousTrailingPaddingSamples = shouldTrimGlobalMp3Padding
          ? Math.max(0, decodedSampleDelta - continuousLeadingPaddingSamples)
          : 0;
        mixerLog("decode continuous audio duration/timebase diagnostics", {
          decodedLengthSamples: decodedAudio.length,
          expectedSamples,
          expectedDecodedSamples,
          decodedSampleDelta,
          expectedDecoderDelaySamples,
          continuousContainer,
          continuousUsesMp3PaddingModel,
          continuousLeadingPaddingSamples,
          continuousTrailingPaddingSamples,
          metadataSampleRate,
          decodedSampleRate: sr,
          decodedDurationMs: decodedAudio.duration * 1000,
          expectedDurationMs:
            expectedDecodedSamples && sr
              ? (expectedDecodedSamples / sr) * 1000
              : null,
          compensationEnabled: shouldTrimGlobalMp3Padding,
          reason:
            shouldTrimGlobalMp3Padding
              ? continuousUsesMp3PaddingModel
                ? "Continuous meeting MP3 chunks are one encoder timeline. Browser decode exposed a small global MP3 priming/padding delta, so trim it once for the whole stream and never per chunk boundary."
                : "Continuous meeting audio chunks are one encoder timeline. Browser decode exposed a small global padding delta, so trim it once at the stream boundary and never per chunk boundary."
              : "Continuous meeting audio chunks are one encoder timeline. Boundaries are converted from metadata sample durations to the decoded AudioBuffer sample rate; no per-boundary encoder-delay/padding trim is applied.",
        });
        let metadataSampleCursor = 0;
        let sourceStartMsCursor = 0;
        chunks.forEach((chunk, index) => {
          const metadataSamples = getMetadataTotalSamples(chunk) || 0;
          const chunkMetadataSampleRate =
            getMetadataSampleRate(chunk) || metadataSampleRate || sr;
          const durationFromSamplesMs = getDurationFromSamplesMs(chunk);
          const chunkDurationMs =
            durationFromSamplesMs ??
            (metadataSamples && chunkMetadataSampleRate
              ? (metadataSamples / chunkMetadataSampleRate) * 1000
              : 0);
          const continuousSourceStartMs = sourceStartMsCursor;
          const continuousSourceEndMs = sourceStartMsCursor + chunkDurationMs;
          const sourceStartSamples = Math.round(
            (continuousSourceStartMs / 1000) * sr,
          );
          const sourceEndSamples = Math.round(
            (continuousSourceEndMs / 1000) * sr,
          );
          const metadataStartSamples = metadataSampleCursor;
          const metadataEndSamples = metadataStartSamples + metadataSamples;
          const decodedChunk = {
            ...chunk,
            decodedAudio,
            continuousDecode: true,
            continuousSourceStartSamples:
              continuousLeadingPaddingSamples + sourceStartSamples,
            continuousSourceEndSamples:
              continuousLeadingPaddingSamples + sourceEndSamples,
            continuousBoundaryPaddingSamples: 0,
            continuousLeadingPaddingSamples,
            continuousTrailingPaddingSamples,
            continuousExpectedDecodedSamples: expectedDecodedSamples,
            continuousDecodedSampleDelta: decodedSampleDelta,
            continuousMetadataSampleRate: chunkMetadataSampleRate,
            continuousDecodedSampleRate: sr,
            continuousMetadataStartSamples: metadataStartSamples,
            continuousMetadataEndSamples: metadataEndSamples,
            continuousSourceStartMs,
            continuousSourceEndMs,
            offsetMs: Number.isFinite(Number(chunk.offsetMs))
              ? Number(chunk.offsetMs)
              : 0,
            sourceStartMs: Number.isFinite(Number(chunk.sourceStartMs))
              ? Math.max(0, Number(chunk.sourceStartMs))
              : 0,
            durationMs: Number.isFinite(Number(durationFromSamplesMs))
              ? durationFromSamplesMs
              : Number.isFinite(Number(chunk.durationMs))
                ? Number(chunk.durationMs)
                : decodedAudio.duration * 1000,
            maxDurationMs: Number.isFinite(Number(chunk.maxDurationMs))
              ? Number(chunk.maxDurationMs)
              : null,
            hasReliableOffset: chunk.hasReliableOffset === true,
          };
          metadataSampleCursor += metadataSamples;
          sourceStartMsCursor = continuousSourceEndMs;
          decodedChunks.push(decodedChunk);
          mixerLog("decode continuous virtual chunk", {
            index,
            continuousSourceStartSamples: decodedChunk.continuousSourceStartSamples,
            continuousSourceEndSamples: decodedChunk.continuousSourceEndSamples,
            untrimmedSourceStartSamples: sourceStartSamples,
            untrimmedSourceEndSamples: sourceEndSamples,
            continuousLeadingPaddingSamples,
            continuousTrailingPaddingSamples,
            continuousMetadataStartSamples: metadataStartSamples,
            continuousMetadataEndSamples: metadataEndSamples,
            continuousMetadataSampleRate: chunkMetadataSampleRate,
            continuousDecodedSampleRate: sr,
            continuousSourceStartMs,
            continuousSourceEndMs,
            chunk: summarizeMixerChunk(decodedChunk),
          });
        });
        mixerLog("decode continuous audio done", {
          decodedDurationMs: decodedAudio.duration * 1000,
          decodedLengthSamples: decodedAudio.length,
          decodedSampleRate: decodedAudio.sampleRate,
          expectedSamples,
          expectedDecodedSamples,
          metadataSampleCursor,
          decodedSampleDelta: decodedAudio.length - expectedDecodedSamples,
          continuousLeadingPaddingSamples,
          continuousTrailingPaddingSamples,
          compensationEnabled: shouldTrimGlobalMp3Padding,
          continuousContainer,
          expectedDurationMs:
            sourceStartMsCursor || null,
          expectedDurationFromDecodedSamplesMs:
            expectedDecodedSamples && decodedAudio.sampleRate
              ? (expectedDecodedSamples / decodedAudio.sampleRate) * 1000
              : null,
        });
      } catch (error) {
        mixerLog("decode continuous audio failed; falling back to per-chunk decode", {
          error: error?.message || String(error),
          continuousContainer,
        });
        decodedChunks.length = 0;
        const fallback = await decodeChunksIndividually();
        decodedChunks.push(...fallback.decoded);
        sr = fallback.sampleRate;
      } finally {
        audioCtx.close().catch(() => {});
      }
    } else {
      const result = await decodeChunksIndividually();
      decodedChunks.push(...result.decoded);
      sr = result.sampleRate;
    }

    mixerLog("decoded chunks summary", {
      sampleRate: sr,
      decodedCount: decodedChunks.length,
      chunks: decodedChunks.map(summarizeMixerChunk),
    });

    let nextSequentialOffsetMs = 0;
    decodedChunks.forEach((chunk) => {
      if (chunk.hasReliableOffset) {
        chunk.effectiveOffsetMs = Math.max(0, chunk.offsetMs || 0);
        if ((chunk.offsetMs || 0) < 0) {
          chunk.sourceStartMs = Math.max(
            chunk.sourceStartMs || 0,
            Math.abs(chunk.offsetMs || 0)
          );
        }
        nextSequentialOffsetMs = Math.max(
          nextSequentialOffsetMs,
          chunk.effectiveOffsetMs + (chunk.durationMs || 0)
        );
      } else {
        chunk.effectiveOffsetMs = nextSequentialOffsetMs;
        nextSequentialOffsetMs += chunk.durationMs || 0;
      }
    });

    mixerLog("effective offsets resolved", {
      nextSequentialOffsetMs,
      chunks: decodedChunks.map(summarizeMixerChunk),
    });

    const audioSource = new AudioSampleSource({
      codec: "aac",
      bitrate: 128000,
    });
    output.addAudioTrack(audioSource);

    await output.start();
    mixerLog("output started");

    let videoSamplesWritten = 0;
    for await (const frame of videoSink.samples(0, videoDuration)) {
      await videoSource.add(frame);
      frame.close();
      videoSamplesWritten += 1;
      if (onProgress && videoDuration > 0) {
        onProgress(Math.min(0.45, (frame.timestamp / videoDuration) * 0.45));
      }
    }
    mixerLog("video samples copied", { videoSamplesWritten });

    const mixBuffer = new Float32Array(Math.ceil(sr * videoDuration));
    mixerLog("mix buffer allocated", {
      sampleRate: sr,
      length: mixBuffer.length,
      approxBytes: mixBuffer.byteLength,
    });
    const getMonoSamples = (audioBuffer) => {
      if (!audioBuffer || audioBuffer.numberOfChannels <= 1) {
        return audioBuffer?.getChannelData(0) || new Float32Array(0);
      }

      const mixed = new Float32Array(audioBuffer.length);
      const channels = audioBuffer.numberOfChannels;
      for (let channel = 0; channel < channels; channel++) {
        const data = audioBuffer.getChannelData(channel);
        for (let i = 0; i < data.length; i++) {
          mixed[i] += data[i] / channels;
        }
      }
      return mixed;
    };
    const writeMix = (data, offset, vol, sourceStart = 0, maxLength = null) => {
      const start = Math.max(0, offset);
      const normalizedSourceStart = Math.max(
        0,
        Math.floor(offset < 0 ? sourceStart + Math.abs(offset) : sourceStart)
      );
      const sourceEnd =
        maxLength != null
          ? Math.min(data.length, normalizedSourceStart + Math.max(0, maxLength))
          : data.length;

      for (
        let i = normalizedSourceStart;
        i < sourceEnd && start + i - normalizedSourceStart < mixBuffer.length;
        i++
      ) {
        mixBuffer[start + i - normalizedSourceStart] += data[i] * vol;
      }
    };

    const getChunkSourceStartSamples = (chunk, chunkSampleRate) => {
      const timeBasedSourceStartSamples = Math.round(
        ((chunk.sourceStartMs || 0) / 1000) * chunkSampleRate,
      );
      if (!chunk.continuousDecode) return timeBasedSourceStartSamples;

      const explicitContinuousStartSamples = toFiniteNumber(
        chunk.continuousSourceStartSamples,
      );
      if (explicitContinuousStartSamples != null) {
        return explicitContinuousStartSamples + timeBasedSourceStartSamples;
      }

      return (
        Math.round(
          (Math.max(0, Number(chunk.continuousSourceStartMs) || 0) / 1000) *
            chunkSampleRate,
        ) + timeBasedSourceStartSamples
      );
    };

    if (hasVideoAudio && mode === "mix") {
      const videoAudioCtx = new AudioContext();
      try {
        mixerLog("decode original video audio start");
        const videoArrayBuffer = await videoBlob.arrayBuffer();
        const decodedVideoAudio = await videoAudioCtx.decodeAudioData(
          videoArrayBuffer
        );
        const videoSamples = getMonoSamples(decodedVideoAudio);
        writeMix(videoSamples, 0, videoVolume);
        mixerLog("decode original video audio done", {
          duration: decodedVideoAudio.duration,
          sampleRate: decodedVideoAudio.sampleRate,
          channels: decodedVideoAudio.numberOfChannels,
          samples: videoSamples.length,
        });
      } catch (error) {
        mixerLog("decode original video audio failed", {
          error: error?.message || String(error),
        });
      } finally {
        videoAudioCtx.close().catch(() => {});
      }
    }

    const videoDurationMs = videoDuration * 1000;
    const writableChunks = decodedChunks
      .map((chunk) => {
        const effectiveOffsetMs = Math.max(0, chunk.effectiveOffsetMs || 0);
        const sourceStartMs = Math.min(
          Math.max(0, chunk.sourceStartMs || 0),
          chunk.durationMs || 0
        );
        const availableChunkDurationMs = Math.max(
          0,
          (chunk.durationMs || 0) - sourceStartMs
        );
        const availableVideoDurationMs = Math.max(
          0,
          videoDurationMs - effectiveOffsetMs
        );
        const configuredMaxDurationMs =
          Number.isFinite(Number(chunk.maxDurationMs)) && chunk.maxDurationMs > 0
            ? chunk.maxDurationMs
            : Infinity;
        const writableDurationMs = Math.min(
          availableChunkDurationMs,
          availableVideoDurationMs,
          configuredMaxDurationMs
        );

        if (writableDurationMs <= 0) return null;

        return {
          ...chunk,
          effectiveOffsetMs,
          sourceStartMs,
          writableDurationMs,
        };
      })
      .filter(Boolean);

    if (!writableChunks.length) {
      mixerLog("no chunks overlap video timeline", {
        videoDurationMs,
        decodedChunks: decodedChunks.map(summarizeMixerChunk),
      });
      throw new Error("No meeting audio chunks overlap the video timeline");
    }

    mixerLog("writable chunks", {
      videoDurationMs,
      chunks: writableChunks.map(summarizeMixerChunk),
    });

    writableChunks.forEach((chunk, index) => {
      const offsetSamples = Math.round(
        (Math.max(0, chunk.effectiveOffsetMs || 0) / 1000) * sr
      );
      const sourceStartSamples = getChunkSourceStartSamples(chunk, sr);
      const maxSamples = Math.round((chunk.writableDurationMs / 1000) * sr);
      writeMix(
        getMonoSamples(chunk.decodedAudio),
        offsetSamples,
        chunksVolume,
        sourceStartSamples,
        maxSamples
      );
      if (onProgress) {
        onProgress(0.45 + ((index + 1) / writableChunks.length) * 0.25);
      }
      mixerLog("chunk mixed", {
        index,
        offsetSamples,
        sourceStartSamples,
        maxSamples,
        chunk: summarizeMixerChunk(chunk),
      });
    });

    const totalSamples = Math.floor(videoDuration * sr);
    const chunkSize = sr * 2;
    let written = 0;

    while (written < totalSamples) {
      const slice = mixBuffer.slice(written, written + chunkSize);
      for (let i = 0; i < slice.length; i++) {
        slice[i] = Math.max(-1, Math.min(1, slice[i]));
      }
      const dur = slice.length / sr;
      const sample = new AudioSample({
        data: slice,
        format: "f32-planar",
        numberOfChannels: 1,
        sampleRate: sr,
        timestamp: written / sr,
        duration: dur,
      });
      await audioSource.add(sample);
      sample.close();
      written += chunkSize;
      if (onProgress && totalSamples > 0) {
        onProgress(0.7 + Math.min(0.25, (written / totalSamples) * 0.25));
      }
    }

    mixerLog("audio samples written", {
      totalSamples,
      written,
      chunkSize,
    });

    await output.finalize();
    if (onProgress) onProgress(1);
    const outputBlob = new Blob([outputTarget.buffer], { type: "video/mp4" });
    mixerLog("done", {
      outputBlobSize: outputBlob.size,
      outputBlobType: outputBlob.type,
    });
    return outputBlob;
  }

  async _getDuration(blob) {
    return new Promise((resolve, reject) => {
      const v = document.createElement("video");
      const url = URL.createObjectURL(blob);
      v.src = url;
      v.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        resolve(v.duration);
      };
      v.onerror = (e) => {
        URL.revokeObjectURL(url);
        reject(e);
      };
    });
  }
}
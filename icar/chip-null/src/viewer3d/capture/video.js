/**
 * Recordings (plan 3.8 viewer3d/capture/video.js, D24; inventory G3, G4).
 *
 * The frames the 3D view draws while it records are composited with the
 * overlay (capture/png.js compositeFrame) into a canvas of a size fixed at
 * the start, encoded as H.264 with WebCodecs by the vendored Mediabunny
 * 1.61.0, and muxed as fragmented MP4 (a fragment about every second, each
 * starting at a keyframe). The muxer writes through a StreamTarget; the
 * writes of each fragment go to the server as one chunk (sink.put), in
 * order, so the server holds every finished fragment even if the page goes
 * away (plan 3.4: a quit loses at most the fragment in flight).
 *
 * A failure while recording (the encoder, an upload) or while stopping keeps
 * what the server already holds, cut back to its last complete fragment
 * (salvage); onError, or the error stop() throws, carries that answer as
 * `kept` when something was kept.
 *
 * Time: each frame's timestamp is the time it was drawn, measured from the
 * first frame, minus the time the recording was paused (the Viewer tab
 * hidden, or the page hidden), so a take with time spent on the Dashboard is
 * that much shorter and has no frozen stretch. At most maxFps frames a
 * second are kept; a frame that comes while the encoder is still taking the
 * previous one is skipped. The track's timescale is Mediabunny's default
 * (57600 a second), so these times are kept as they are.
 *
 * evenFrameSize and outputFps are the twins of core/captures.py
 * even_frame_size and recording_output_fps (tests/fixtures/web/recording_vectors.json).
 * encoderSupport() says whether WebCodecs offers H.264 at a size, with a
 * one-line reason when it does not (Record is then disabled).
 *
 * Plain ES module: Mediabunny is imported when a recording starts.
 */

import { compositeFrame } from './png.js';

export const RECORD_NOMINAL_FPS = 24;
export const RECORD_MIN_FPS = 1;
export const RECORD_MAX_FPS = 60;
export const KEYFRAME_SECONDS = 1;
export const UPLOAD_PIECE = 8 * 1024 * 1024; // bytes per PUT at most (the server takes 16 MB)
// G4: what Record says when it cannot record, and how to fix it (the encoder is part of macOS; no command to type).
export const NO_ENCODER = 'Recording is not available in this install: macOS reports no video encoder for it. '
  + 'Screenshots still work. To fix this, update macOS in System Settings > General > Software Update, '
  + 'then open Neuronode again.';
export const NO_H264 = 'Recording is not available at this window size: macOS reports no H.264 encoder for a video '
  + 'this large. Make the window smaller, or update macOS in System Settings > General > Software Update.';

const AVC_PROFILES = { high: '64', main: '4d', baseline: '42' };
const AVC_LEVELS = [ // [level_idc, max frame size in macroblocks, max macroblocks per second]
  [0x1e, 1620, 40500], [0x1f, 3600, 108000], [0x20, 5120, 216000], [0x28, 8192, 245760],
  [0x2a, 8704, 522240], [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600],
  [0x3c, 139264, 4177920],
];

/** Python's a % b for b > 0 (never negative). */
function mod(a, b) {
  return ((a % b) + b) % b;
}

/**
 * Round a frame size down to even numbers (H.264 4:2:0 needs them), at least 2x2
 * (core/captures.py even_frame_size).
 * @returns {[number, number]}
 */
export function evenFrameSize(width, height) {
  const w = Math.trunc(Number(width));
  const h = Math.trunc(Number(height));
  return [Math.max(2, w - mod(w, 2)), Math.max(2, h - mod(h, 2))];
}

/**
 * The playback rate that makes a video last as long as its recording did:
 * frames / seconds, clamped (core/captures.py recording_output_fps).
 */
export function outputFps(frameCount, activeSeconds, fallback = RECORD_NOMINAL_FPS, minFps = RECORD_MIN_FPS,
  maxFps = RECORD_MAX_FPS) {
  const n = Math.trunc(Number(frameCount));
  const t = Number(activeSeconds);
  if (!(n > 0) || !Number.isFinite(t) || t <= 0) return Number(fallback);
  return Math.min(maxFps, Math.max(minFps, n / t));
}

/** The H.264 codec string for a profile whose level fits width x height at fps. */
export function avcCodec(profile, width, height, fps) {
  const frame = Math.ceil(width / 16) * Math.ceil(height / 16);
  const level = AVC_LEVELS.find(([, maxFrame, maxRate]) => frame <= maxFrame && frame * fps <= maxRate);
  const hex = (n) => n.toString(16).padStart(2, '0');
  return `avc1.${AVC_PROFILES[profile]}00${hex(level ? level[0] : 0x3c)}`;
}

/** Bits per second for a recording: about 0.07 bit per pixel and frame, from 2 to 50 Mbit/s. */
export function recordingBitrate(width, height, fps) {
  return Math.round(Math.min(50e6, Math.max(2e6, width * height * fps * 0.07)));
}

/**
 * Whether WebCodecs can encode H.264 at width x height.
 * @returns {Promise<{ok: boolean, codec?: string, reason?: string}>}
 */
export async function encoderSupport({ width, height, fps = RECORD_MAX_FPS }) {
  const Encoder = globalThis.VideoEncoder;
  if (typeof Encoder !== 'function' || typeof Encoder.isConfigSupported !== 'function') {
    return { ok: false, reason: NO_ENCODER };
  }
  const bitrate = recordingBitrate(width, height, fps);
  for (const profile of Object.keys(AVC_PROFILES)) {
    const codec = avcCodec(profile, width, height, fps);
    try {
      const answer = await Encoder.isConfigSupported({ codec, width, height, bitrate, framerate: fps });
      if (answer?.supported) return { ok: true, codec };
    } catch {
      // This profile is not offered; try the next.
    }
  }
  return { ok: false, reason: NO_H264 };
}

function message(error) {
  return (error && error.message) || String(error || 'unknown error');
}

/**
 * One recording.
 * @param {{width: number, height: number, scale: number, codec: string, sink: object,
 *          maxFps?: number, onError?: (message: string) => void, now?: () => number}} options
 *   width, height: the frame size in device px (even); scale: device px per CSS px of the view;
 *   sink: {open({width, height, fps_cap}), put(n, offset, bytes), finish({frames, duration_s}), abort()}.
 */
export function createRecorder({ width, height, scale, codec, sink, maxFps = RECORD_MAX_FPS, onError,
  now = () => performance.now() }) {
  const surface = document.createElement('canvas');
  surface.width = width;
  surface.height = height;
  const ctx = surface.getContext('2d', { alpha: false });
  const minStep = 1 / maxFps - 0.002; // frames closer than this are not kept
  let state = 'new'; // new, starting, recording, stopping, done, failed
  let output = null;
  let source = null;
  let busy = null;
  let failure = null;
  let startTime = null;
  let pausedTotal = 0;
  let pausedAt = null;
  let last = null;
  const counts = { frames: 0, skipped_busy: 0, skipped_rate: 0, chunks: 0, bytes: 0 };
  const timestamps = [];
  // Upload: the muxer's writes, in order, joined per task and sent as one chunk each.
  let written = 0;
  let pending = [];
  let flushTimer = 0;
  let uploads = Promise.resolve();

  /** Remember the first failure; onError hears of one that ends a running recording (start and stop throw it). */
  function fail(error) {
    if (failure) return;
    failure = error instanceof Error ? error : new Error(message(error));
    const running = state === 'recording';
    if (state !== 'done') state = 'failed';
    if (running) onError?.(failure.message);
  }

  /** Send what the muxer wrote since the last flush, as one chunk (a Blob, so the request does not copy it again). */
  function flush() {
    clearTimeout(flushTimer);
    flushTimer = 0;
    if (!pending.length) return;
    const joined = new Blob(pending);
    pending = [];
    for (let start = 0; start < joined.size; start += UPLOAD_PIECE) {
      const piece = joined.slice(start, Math.min(joined.size, start + UPLOAD_PIECE));
      const n = counts.chunks;
      const offset = counts.bytes;
      counts.chunks += 1;
      counts.bytes += piece.size;
      uploads = uploads.then(() => (failure ? null : sink.put(n, offset, piece))).catch((error) => fail(error));
    }
  }

  const writable = new WritableStream({
    write(chunk) {
      if (chunk.type !== 'write') return;
      if (chunk.position !== written) {
        throw new Error(`The video muxer wrote at byte ${chunk.position}, not at the end (${written}).`);
      }
      pending.push(chunk.data.slice()); // the muxer may reuse its buffer
      written += chunk.data.byteLength;
      if (!flushTimer) flushTimer = setTimeout(flush, 0);
    },
  });

  /** Seconds recorded so far (paused time left out). */
  function elapsed(at = now()) {
    if (startTime === null) return 0;
    const pausedNow = pausedAt !== null ? at - Math.max(pausedAt, startTime) : 0;
    return Math.max(0, (at - startTime - pausedTotal - pausedNow) / 1000);
  }

  return {
    get state() {
      return state;
    },

    elapsed,

    /** Open the server's recording and the muxer (writes ftyp and moov). */
    async start() {
      state = 'starting';
      try {
        await sink.open({ width, height, fps_cap: maxFps });
        const mb = await import('mediabunny');
        output = new mb.Output({
          // A fragment at every keyframe: a minimum a little under the keyframe interval, since frame times
          // are not exact multiples of it (at exactly 1 s, rounding made some fragments 2 s long).
          format: new mb.Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 0.9 * KEYFRAME_SECONDS }),
          target: new mb.StreamTarget(writable),
        });
        source = new mb.CanvasSource(surface, {
          codec: 'avc',
          fullCodecString: codec,
          bitrate: recordingBitrate(width, height, maxFps),
          keyFrameInterval: KEYFRAME_SECONDS,
          sizeChangeBehavior: 'deny',
        });
        output.addVideoTrack(source); // no frame rate: the default timescale keeps the frames' own times
        await output.start();
        flush();
      } catch (error) {
        fail(error);
        await this.cancel();
        throw failure;
      }
      if (state === 'starting') state = 'recording';
    },

    /**
     * The 3D view drew a frame at `time` (ms, the animation frame's clock): keep it when it is due.
     * Call in the same task as the draw.
     */
    frame(time, glCanvas, items, palette, under = null) {
      if (state !== 'recording' || pausedAt !== null || failure) return;
      if (startTime === null) {
        startTime = time;
        pausedTotal = 0;
      }
      const t = (time - startTime - pausedTotal) / 1000;
      if (last !== null && (t <= last || t - last < minStep)) {
        counts.skipped_rate += 1;
        return;
      }
      if (busy) {
        counts.skipped_busy += 1;
        return;
      }
      compositeFrame(ctx, glCanvas, items, { scale, palette, under });
      busy = source.add(t, 1 / maxFps).then(() => { busy = null; }, (error) => { busy = null; fail(error); });
      counts.frames += 1;
      last = t;
      timestamps.push(t);
    },

    pause(at = now()) {
      if (pausedAt === null) pausedAt = at;
    },

    resume(at = now()) {
      if (pausedAt === null) return;
      if (startTime !== null) pausedTotal += at - Math.max(pausedAt, startTime);
      pausedAt = null;
    },

    /** Finish: encode what is queued, write the last fragment, send it and finish on the server. */
    async stop() {
      if (state !== 'recording') {
        if (failure) throw failure;
        return null;
      }
      state = 'stopping';
      try {
        await busy;
        if (failure) throw failure;
        if (!counts.frames) throw new Error('No frames were drawn while recording.');
        await output.finalize();
        flush();
        await uploads;
        if (failure) throw failure;
        const duration = last + 1 / maxFps;
        const answer = await sink.finish({ frames: counts.frames, duration_s: duration });
        state = 'done';
        return { ...answer, duration_s: duration, fps: outputFps(counts.frames, duration), counts: { ...counts } };
      } catch (error) {
        fail(error);
        const kept = await this.salvage();
        if (kept) failure.kept = kept;
        throw failure;
      }
    },

    /**
     * After a failure: keep what the server received, up to its last complete fragment. The server's
     * finish answer, or null when nothing could be kept (the server then holds nothing).
     */
    async salvage() {
      if (state === 'done') return null;
      state = 'failed';
      clearTimeout(flushTimer);
      pending = [];
      try {
        await output?.cancel();
      } catch {
        // Already ended.
      }
      await uploads.catch(() => {});
      if (!counts.chunks) return null;
      try {
        return await sink.finish({ frames: counts.frames, duration_s: last === null ? 0 : last, salvage: true });
      } catch {
        await Promise.resolve(sink.abort()).catch(() => {});
        return null;
      }
    },

    /** Drop the recording: the muxer stops and the server removes what it received. */
    async cancel() {
      if (state === 'done') return;
      state = 'failed';
      clearTimeout(flushTimer);
      pending = [];
      try {
        await output?.cancel();
      } catch {
        // Already ended.
      }
      await uploads.catch(() => {});
      try {
        await sink.abort();
      } catch {
        // The server may have gone; it keeps nothing it cannot play.
      }
    },

    /** For tests: what was kept and skipped, and the kept frames' times (s). */
    debug() {
      return { state, width, height, codec, ...counts, timestamps: timestamps.slice(), elapsed: elapsed(),
        paused_ms: pausedTotal, failure: failure ? failure.message : null };
    },
  };
}

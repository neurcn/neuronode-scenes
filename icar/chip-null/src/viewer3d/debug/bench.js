/**
 * Frame-time measurements (plan 3.8 viewer3d/debug/bench.js, section 6 budgets).
 *
 * The two WKWebView metrics of plan section 6:
 * - render time: render plus gl.finish(), over 120 frames; its p95 is the gate.
 *   A 1-pixel readPixels follows the finish, as in the P0 gate, because some
 *   engines (Chrome) return from finish() before the GPU has finished;
 * - while orbiting: requestAnimationFrame intervals, as mean fps and the share
 *   of intervals over 25 ms. A rAF-interval p95 is reported but never gated.
 * installBench() adds per-frame hooks to a renderer only with ?debug=1 in the
 * page address, and exposes them as window.__nn.debug.bench.
 *
 * Plain ES module; no imports.
 */

export const RENDER_FRAMES = 120;
export const LONG_INTERVAL_MS = 25;

/** @param {number[]} sorted ascending  @param {number} p 0-100 */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

/**
 * @param {number[]} values
 * @returns {{n: number, mean: number|null, min: number|null, p50: number|null, p95: number|null, max: number|null}}
 */
export function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const round = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
  return {
    n,
    mean: n ? round(sorted.reduce((s, v) => s + v, 0) / n) : null,
    min: round(sorted[0] ?? null),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    max: round(sorted[n - 1] ?? null),
  };
}

/**
 * Render time: each frame is step(i) (move the camera), render(), gl.finish() and a 1-pixel
 * readPixels, so the GPU has finished.
 * @param {{gl: WebGL2RenderingContext, render: () => void, step?: (i: number) => void,
 *          frames?: number, warmup?: number}} spec
 * @returns {{frames: number, ms: object}}
 */
export function measureRenderTimes({ gl, render, step = () => {}, frames = RENDER_FRAMES, warmup = 10 }) {
  const pixel = new Uint8Array(4);
  const finish = () => {
    gl.finish();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  };
  for (let i = 0; i < warmup; i += 1) {
    step(i);
    render();
  }
  finish();
  const times = [];
  for (let i = 0; i < frames; i += 1) {
    step(warmup + i);
    const started = performance.now();
    render();
    finish();
    times.push(performance.now() - started);
  }
  return { frames, ms: summarize(times) };
}

/**
 * Orbit for durationMs, drawing in every animation frame: step(dtSeconds) moves the camera and draws.
 * The first warmupMs are drawn but not counted.
 * @param {{durationMs: number, step: (dtSeconds: number) => void, warmupMs?: number}} spec
 * @returns {Promise<{frames: number, seconds: number, mean_fps: number|null, over_25ms: number,
 *                    over_25ms_fraction: number|null, intervals_ms: object}>}
 */
export function measureRaf({ durationMs, step, warmupMs = 500 }) {
  return new Promise((resolve) => {
    const intervals = [];
    let begin = null;
    let first = null;
    let last = null;
    function frame(time) {
      if (begin === null) begin = time;
      if (first === null) {
        if (time - begin >= warmupMs) first = time;
      } else {
        intervals.push(time - last);
      }
      step(last === null ? 0 : (time - last) / 1000);
      last = time;
      if (first === null || time - first < durationMs) {
        requestAnimationFrame(frame);
        return;
      }
      const seconds = (last - first) / 1000;
      const over = intervals.filter((v) => v > LONG_INTERVAL_MS).length;
      resolve({
        frames: intervals.length,
        seconds: Math.round(seconds * 1000) / 1000,
        mean_fps: seconds > 0 ? Math.round((intervals.length / seconds) * 100) / 100 : null,
        over_25ms: over,
        over_25ms_fraction: intervals.length ? Math.round((over / intervals.length) * 10000) / 10000 : null,
        intervals_ms: summarize(intervals),
      });
    }
    requestAnimationFrame(frame);
  });
}

/** True when the page address has ?debug=1. */
export function debugEnabled() {
  try {
    return new URLSearchParams(window.location.search).get('debug') === '1';
  } catch {
    return false;
  }
}

/**
 * Record each drawn frame's script time and the rAF interval before it, when ?debug=1.
 * @param {{addFrameHook: (fn: Function) => Function}} renderer  from createRenderer()
 * @param {{force?: boolean, keep?: number}} [options]
 * @returns {{stats: () => object, reset: () => void, remove: () => void} | null}
 */
export function installBench(renderer, { force = false, keep = 600 } = {}) {
  if (!force && !debugEnabled()) return null;
  let cpu = [];
  let intervals = [];
  let lastTime = null;
  const remove = renderer.addFrameHook(({ time, cpuMs }) => {
    cpu.push(cpuMs);
    if (lastTime !== null) intervals.push(time - lastTime);
    lastTime = time;
    if (cpu.length > keep) cpu = cpu.slice(-keep);
    if (intervals.length > keep) intervals = intervals.slice(-keep);
  });
  const bench = {
    stats: () => ({ frame_cpu_ms: summarize(cpu), raf_interval_ms: summarize(intervals) }),
    reset: () => {
      cpu = [];
      intervals = [];
      lastTime = null;
    },
    remove,
  };
  window.__nn = window.__nn || {};
  window.__nn.debug = window.__nn.debug || {};
  window.__nn.debug.bench = bench;
  return bench;
}

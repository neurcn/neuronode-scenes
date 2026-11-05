/**
 * The WebGL2 renderer of the 3D view (plan 3.8 viewer3d/renderer.js).
 *
 * - three.js WebGLRenderer on a WebGL2 context with MSAA (antialias: true;
 *   the browser picks 4 samples), color management off and linear output,
 *   as VTK draws and as the prototype matched it pixel for pixel. The canvas
 *   has an alpha channel (premultiplied), so a transparent background (clear
 *   alpha 0) shows the page behind; an opaque one is cleared at alpha 1.
 * - Render on demand, lifted from the prototype (proto.js 571-595): a frame
 *   is drawn only after invalidate(), or on every animation frame while
 *   setContinuous(true) (Spin). No frame is drawn while nothing changes.
 * - A ResizeObserver keeps the drawing buffer at the host's CSS size times
 *   devicePixelRatio, unless lockSize() fixed it (a recording keeps its size;
 *   CSS object-fit letterboxes the canvas). A lock may also fix the view's
 *   CSS size and pixel ratio (cssWidth, cssHeight, pixelRatio): size() then
 *   reports those, so the camera, the picking and the overlay keep the
 *   recording's framing while the host changes size (hostWidth, hostHeight).
 * - Context loss: drawing stops at 'webglcontextlost' and resumes at
 *   'webglcontextrestored'; three.js uploads its geometry and textures again
 *   on the next frame. contextLosses counts the losses (full screen and the
 *   viewer's other changes must cause none).
 *
 * Plain ES module: imports three only; no Lit, no store.
 */

import * as THREE from 'three';

/**
 * @typedef {object} FrameInfo
 * @property {number} time      rAF timestamp (ms), or performance.now() for renderNow().
 * @property {number} frame     Frames drawn so far, this one included.
 * @property {boolean} continuous
 */

/**
 * @typedef {object} Size
 * @property {number} cssWidth     The view's width in CSS px (the lock's, when it fixes one).
 * @property {number} cssHeight
 * @property {number} width        Drawing buffer width in device pixels.
 * @property {number} height       Drawing buffer height in device pixels.
 * @property {number} pixelRatio   Device pixels per CSS px of the view.
 * @property {number} hostWidth    The host's CSS size, whatever the lock.
 * @property {number} hostHeight
 * @property {boolean} locked
 */

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{host?: Element, background?: THREE.ColorRepresentation, pixelRatio?: () => number,
 *          onResize?: (size: Size) => void, onContextLost?: () => void,
 *          onContextRestored?: () => void}} [options]
 */
export function createRenderer(canvas, options = {}) {
  const {
    host = canvas.parentElement,
    background = null,
    pixelRatio = () => window.devicePixelRatio || 1,
    onResize,
    onContextLost,
    onContextRestored,
  } = options;

  THREE.ColorManagement.enabled = false; // as VTK: no color management, blend in display space
  const three = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  });
  three.outputColorSpace = THREE.LinearSRGBColorSpace;
  three.info.autoReset = false; // a frame can be several passes; reset once per frame
  // The background: three.js's default clear color (black at alpha 0) until the caller sets one (the 3D view
  // sets its background theme's, palette.THEMES).
  if (background !== null) three.setClearColor(background, 1);
  const gl = three.getContext();
  if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) {
    three.dispose();
    throw new Error('This browser has no WebGL2, which the 3D view needs.');
  }

  /** @type {((info: FrameInfo) => void) | null} */
  let drawFrame = null;
  const hooks = new Set();
  let pending = 0;
  let needsFrame = false;
  let continuous = false;
  let lost = false;
  let losses = 0;
  let disposed = false;
  let frames = 0;
  let locked = null;
  const size = { cssWidth: 0, cssHeight: 0, width: 0, height: 0, pixelRatio: 1, hostWidth: 0, hostHeight: 0, locked: false };

  function schedule() {
    if (!pending && !lost && !disposed) pending = requestAnimationFrame(tick);
  }

  function draw(time) {
    if (!drawFrame || lost || disposed) return;
    frames += 1;
    three.info.reset();
    const started = performance.now();
    drawFrame({ time, frame: frames, continuous });
    const cpuMs = performance.now() - started;
    for (const hook of hooks) hook({ time, frame: frames, cpuMs, continuous });
  }

  function tick(time) {
    pending = 0;
    const wanted = needsFrame || continuous;
    needsFrame = false;
    if (wanted) draw(time);
    if (continuous) schedule();
  }

  function measure() {
    const rect = host ? host.getBoundingClientRect() : canvas.getBoundingClientRect();
    return { w: Math.max(1, Math.round(rect.width)), h: Math.max(1, Math.round(rect.height)) };
  }

  /** @param {boolean} [force]  apply even when nothing changed (the size was locked or unlocked) */
  function applySize(force = false) {
    if (disposed) return;
    const { w, h } = measure();
    if (!force && w === size.hostWidth && h === size.hostHeight && (locked || pixelRatio() === size.pixelRatio)) return;
    size.hostWidth = w;
    size.hostHeight = h;
    size.cssWidth = locked?.cssWidth ?? w;
    size.cssHeight = locked?.cssHeight ?? h;
    if (locked) {
      three.setPixelRatio(1);
      three.setSize(locked.width, locked.height, false);
    } else {
      three.setPixelRatio(pixelRatio());
      three.setSize(w, h, false);
    }
    const buffer = three.getDrawingBufferSize(new THREE.Vector2());
    size.width = buffer.x;
    size.height = buffer.y;
    size.pixelRatio = locked?.pixelRatio ?? three.getPixelRatio();
    size.locked = Boolean(locked);
    onResize?.({ ...size });
    needsFrame = true;
    schedule();
  }

  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => applySize());
  observer?.observe(host || canvas);

  function contextLost(event) {
    event.preventDefault(); // lets the browser restore the context
    lost = true;
    losses += 1;
    if (pending) cancelAnimationFrame(pending);
    pending = 0;
    onContextLost?.();
  }

  function contextRestored() {
    lost = false;
    applySize(true);
    onContextRestored?.();
  }

  canvas.addEventListener('webglcontextlost', contextLost);
  canvas.addEventListener('webglcontextrestored', contextRestored);
  applySize(true);

  return {
    three,
    gl,
    canvas,

    /** @param {(info: FrameInfo) => void} fn  Draws one frame (all passes). */
    setFrame(fn) {
      drawFrame = fn;
      this.invalidate();
    },

    /** Draw once at the next animation frame. */
    invalidate() {
      needsFrame = true;
      schedule();
    },

    /** @param {boolean} on  Draw on every animation frame (Spin), or only on demand. */
    setContinuous(on) {
      continuous = Boolean(on);
      if (continuous) schedule();
    },

    /** Draw now, synchronously (captures, benchmarks, readback). */
    renderNow() {
      draw(performance.now());
    },

    /**
     * Fix the drawing buffer at width x height device pixels, whatever the canvas's
     * CSS size (a recording), or follow the host again with null. cssWidth,
     * cssHeight and pixelRatio, when given, fix the view's size as size() reports it.
     * @param {{width: number, height: number, cssWidth?: number, cssHeight?: number,
     *          pixelRatio?: number} | null} fixed
     */
    lockSize(fixed) {
      locked = fixed ? {
        width: Math.round(fixed.width), height: Math.round(fixed.height),
        cssWidth: fixed.cssWidth, cssHeight: fixed.cssHeight, pixelRatio: fixed.pixelRatio,
      } : null;
      applySize(true);
    },

    /** Size the drawing buffer for the host (or the lock) again, after a caller drew at another size (an export). */
    refit() {
      applySize(true);
    },

    /** @returns {Size} */
    size() {
      return { ...size };
    },

    /** @param {(entry: {time: number, frame: number, cpuMs: number, continuous: boolean}) => void} fn */
    addFrameHook(fn) {
      hooks.add(fn);
      return () => hooks.delete(fn);
    },

    get contextLost() {
      return lost || gl.isContextLost();
    },

    /** How many times the context was lost since the renderer was made. */
    get contextLosses() {
      return losses;
    },

    get frames() {
      return frames;
    },

    /** What the GPU and context offer, for diagnostics. */
    describe() {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        webgl2: true,
        renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        msaa_samples: gl.getParameter(gl.SAMPLES),
        max_samples: gl.getParameter(gl.MAX_SAMPLES),
        antialias: Boolean(gl.getContextAttributes()?.antialias),
        three_revision: THREE.REVISION,
      };
    },

    dispose() {
      disposed = true;
      if (pending) cancelAnimationFrame(pending);
      pending = 0;
      observer?.disconnect();
      canvas.removeEventListener('webglcontextlost', contextLost);
      canvas.removeEventListener('webglcontextrestored', contextRestored);
      hooks.clear();
      three.dispose();
    },
  };
}

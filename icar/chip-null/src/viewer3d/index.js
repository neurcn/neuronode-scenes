/**
 * The 3D view (plan 3.8 viewer3d/index.js): one WebGL2 canvas and one 2D
 * overlay canvas in `host`, drawing a pair's static scene and display packets.
 *
 * createViewer(host, callbacks) returns {loadScene, loadGeometry,
 * applyDisplay, setSelection, setHover, screenOf, getCamera, setCamera,
 * preset, reset, fit, spin, pause, size, capturePng, recordingSupport,
 * startRecording, stopRecording, cancelRecording, dispose, debug}.
 *
 * Captures (P3b, capture/png.js and capture/video.js): capturePng() draws a
 * frame and returns a PNG of the 3D view with its overlay, at the view's
 * size in device px; startRecording() fixes the drawing buffer at the
 * recording's size (the canvases are letterboxed with CSS object-fit while
 * the viewport has another size, and clicks are mapped back), draws on every
 * animation frame and hands each frame to the recorder until
 * stopRecording(). A hidden tab (pause) or a hidden page pauses the
 * recording's clock.
 *
 * Background theme (display.figure.background; scene.style.themes): black or
 * white on screen; an export may also be transparent (drawExport's
 * background). It sets the clear color (alpha 0 when transparent),
 * the shell's colors, and `data-fig-theme="light"` with `data-fig-background`
 * on callbacks.themeRoot (the viewport, which holds the legend card too), so
 * the overlay's tokens and the legend follow it. An export may draw another
 * theme (drawExport's background) without the screen changing.
 *
 * Split view (split.js): callbacks.panel 'L' or 'R' makes this view one
 * half of it: it draws only that side's spheres and edges (panelMasks), its
 * half of the shell, region meshes and outlines; showScaleBar false leaves
 * its scale bar out; onPose(pose) hears every camera change so the other
 * panel can follow.
 *
 * Callbacks: onHover(key | null) and onPick({key | null, add, edge}) with key
 * {acr, hemi} (edge: the id of the edge line a click hit when it missed every
 * sphere, or null; E27); onHoverEdge(edge id | null, {x, y}) when the edge line under the
 * pointer changes while no sphere is there (P8); onCamera(pose) at the end of each camera move; onSpin(on) when
 * Spin stops by itself; onError(message) when the region meshes cannot be
 * loaded (the spheres and edges still draw).
 *
 * What is drawn, in order:
 * - opaque: the spheres (layers/nodes.js) and the shell's silhouette
 *   (layers/shell.js);
 * - translucent: the edge lines (layers/edges.js, back to front) and the
 *   arrowheads (layers/arrows.js), then the shell fill; in Meshes mode the
 *   region meshes (layers/regions.js) and the shell fill are depth-peeled
 *   (transparency.js, 8 layers), otherwise three.js sorts and blends;
 * - the 2D overlay (overlay/layout.js, overlay/paint2d.js): labels, hover
 *   glow, selection halo, ring and tag, the orientation marker and the scale
 *   bar.
 * The view draws on demand; Spin, the smooth zoom and the label fade draw on
 * every animation frame while they run.
 *
 * window.__nn.debug reads this view's `debug` (counts, projected positions,
 * camera, readback, picking and frame times) for tests.
 *
 * Plain ES module: imports three only (no Lit, no store).
 */

import * as THREE from 'three';
import { fetchGeometry, checkDisplay, checkScene } from './assets/loader.js';
import {
  applyToThree, azimuth, copyPose, createCameraController, createThreeCamera, frame as cameraFrame, poseDifference,
  umPerPixel,
} from './camera.js';
import { measureRenderTimes, summarize } from './debug/bench.js';
import { createArrowsLayer } from './layers/arrows.js';
import { createEdgesLayer } from './layers/edges.js';
import { createNodesLayer } from './layers/nodes.js';
import { createOutlinesLayer } from './layers/outlines.js';
import { createRegionsLayer } from './layers/regions.js';
import { createShellLayer } from './layers/shell.js';
import { CAP_HEIGHT_EM, LABEL_FONT_WEIGHT, layoutOverlay, markerLetterAt, projectPoints, screenRadius }
  from './overlay/layout.js';
import { createMeasure, fontOf, paintOverlay, readPalette } from './overlay/paint2d.js';
import { pickEdge, pickSphere } from './picking.js';
import { frameCanvas, pngBlob } from './capture/png.js';
import { createRecorder, encoderSupport, evenFrameSize, RECORD_MAX_FPS } from './capture/video.js';
import { createRenderer } from './renderer.js';
import { createTransparency } from './transparency.js';

// VTK's light: one headlight along the view direction, intensity 1 (three.js's
// Lambert term divides by pi, hence pi here); no ambient light. With today's
// sphere material (diffuse only) a sphere is its color times cos(normal, view).
const AMBIENT_INTENSITY = 0;
const HEADLIGHT_INTENSITY = Math.PI;
const HEADLIGHT_DIRECTION = [0, 0, 1]; // camera space; the light's target is the camera's origin
const LABEL_FADE_PER_SEC = 0.28 / 0.033;   // viewer.py: step 0.28 every 33 ms
const LABEL_FADE_BACK_MS = 90;             // viewer.py _on_label_interaction_end
const HOVER_PICK_KEEP = 200;               // hover pick times kept for debug stats
// High-resolution exports (P8, D45): tiles at most this many px a side, and the largest picture composed in
// one canvas before the rows go to the server to be stitched (WebKit's canvas area limit is about 268 M px).
export const EXPORT_MAX_TILE = 4096;
export const EXPORT_MAX_CANVAS_PIXELS = 16384 * 16384;
export const EXPORT_MAX_SIDE = 32767;

/**
 * @param {HTMLElement} host  the viewport element; the canvases fill it
 * @param {{onHover?: Function, onPick?: Function, onCamera?: Function, onSpin?: Function,
 *          onError?: Function, getGeometry?: (path: string) => Promise<*>}} [callbacks]
 */
/** E27: an emphasized edge draws this much wider (app px), and the other edges at most this alpha. */
export const EDGE_FOCUS_WIDEN = 1.6;
export const EDGE_FOCUS_ADD = 2;
export const EDGE_FOCUS_DIM = 0.12;
export const EDGE_PICK_SLOP_PX = 3;

/**
 * A split view's panels (split.js): for each sphere 'L', 'R' or 'C' (both panels: a midline sphere) from the
 * static scene's sides (a comparison: A left, B right) or hemispheres; for each edge copy its ends' panel,
 * 'C' between two midline spheres, or 'X' (neither: an edge between the hemispheres).
 */
export function panelMasks(scene) {
  const side = scene.nodes.side;
  const nodes = scene.nodes.acr.map((_, i) => (side ? (side[i] === 'B' ? 'R' : 'L') : scene.nodes.hemi[i]));
  const edges = scene.edges.s.map((s, k) => {
    const a = nodes[s];
    const b = nodes[scene.edges.t[k]];
    if (a === b) return a;
    if (a === 'C') return b;
    if (b === 'C') return a;
    return 'X';
  });
  return { nodes, edges };
}

/**
 * The point every turn pivots on (camera.js setPivot): the center of what the view shows. A split panel turns
 * about its half's center (the right panel's is the mirror of the left's, so the linked cameras stay mirrored);
 * a one-hemisphere view (hemi_mode L or R: in a comparison A or B only) about that hemisphere's; else the
 * brain's (world.center). World x above the midline is the left hemisphere.
 */
export function turnPivot(world, hemiMode, panel = null) {
  const m = Number(world.midline_x);
  const b = world.bounds.map(Number);
  const c = world.center.map(Number);
  const left = [(m + b[1]) / 2, c[1], c[2]];
  if (panel === 'L' || (!panel && hemiMode === 'L')) return left;
  if (panel === 'R') return [2 * m - left[0], c[1], c[2]];
  if (hemiMode === 'R') return [(b[0] + m) / 2, c[1], c[2]];
  return c;
}

export function createViewer(host, callbacks = {}) {
  const { onHover, onHoverEdge, onPick, onCamera, onSpin, onError, getGeometry, getFurniture, onPose,
    onAxisLock, onSliceStep } = callbacks;
  const panel = callbacks.panel ?? null;
  const showScaleBar = callbacks.showScaleBar !== false;
  let masks = null; // panelMasks(scene) while this view is a split panel
  const themeRoot = callbacks.themeRoot ?? host;
  let background = 'black'; // the view's background theme (display.figure.background)
  let hoverEdge = null; // P8: the edge id under the pointer when no sphere is there
  let edgeFocus = null; // E27: the edge id a table row emphasizes, or null
  let regionFocus = []; // Q23: in Meshes mode, the selected spheres' regions stay and the others dim
  const glCanvas = document.createElement('canvas');
  glCanvas.className = 'nn-viewport__gl';
  const overlay = document.createElement('canvas');
  overlay.className = 'nn-viewport__overlay';
  overlay.setAttribute('aria-hidden', 'true');
  host.append(glCanvas, overlay);
  const ctx2d = overlay.getContext('2d');
  let palette = readPalette(host);
  let measure = createMeasure(ctx2d, palette);
  // The overlay's faces: canvas text does not wait for a web font, so load them and draw again once they are in.
  if (document.fonts?.load) {
    const faces = [fontOf(palette, { px: 12, weight: 600 }), fontOf(palette, { px: 12, weight: 400 }),
      fontOf(palette, { px: 12, mono: true, weight: 400 }), fontOf(palette, { px: 12, mono: true, weight: 500 })];
    Promise.all(faces.map((face) => document.fonts.load(face))).then(() => {
      if (disposed) return;
      measure = createMeasure(ctx2d, palette);
      renderer.invalidate();
    }, () => {});
  }

  const three3 = new THREE.Scene();
  let camera = createThreeCamera(30);
  let projection = 'perspective'; // display.figure.projection
  three3.add(camera);
  const ambient = new THREE.AmbientLight();
  ambient.intensity = AMBIENT_INTENSITY;
  three3.add(ambient);
  const headlight = new THREE.DirectionalLight();
  headlight.intensity = HEADLIGHT_INTENSITY;
  headlight.position.set(...HEADLIGHT_DIRECTION);
  camera.add(headlight);
  camera.add(headlight.target); // at the camera's origin: the light shines along the view direction

  let scene = null;
  let display = null;
  let layers = { nodes: null, edges: null, arrows: null, regions: null, outlines: null, shell: null };
  let geometryStatus = 'none';
  let geometryKey = null;
  let geometryBounds = null;
  let paused = false;
  let disposed = false;
  let needs3D = true;
  let lastTime = null;
  let lastSortedPose = null;
  let keyIndex = new Map();
  let keyHemis = [];
  let hoverIndex = -1;
  let selected = [];
  let labelOpacity = 1;
  let labelTarget = 1;
  let fadeTimer = 0;
  let previousLabels = new Set();
  let lastLayout = { items: [], labels: [], candidates: 0 };
  let insets = { left: 0, bottom: 0 }; // CSS px of the view under the panels over it (setInsets)
  let firstFrameAt = null;
  let fullFrameAt = null;
  let interacting = false;
  let edgeAlphaCap = 1; // E29: the edges' alpha cap, style.drag_edge_alpha while the view is dragged
  const hoverPickMs = [];
  let lastPath = 'none';
  let pendingAnimation = null; // {from, to, start, ms}
  let recorder = null; // capture/video.js, while a recording runs
  let exporting = false; // a high-resolution export is drawing (P8, D45)
  let recorderPaused = false;

  const renderer = createRenderer(glCanvas, {
    host,
    onResize: (size) => {
      overlay.width = Math.max(1, Math.round(size.cssWidth * size.pixelRatio));
      overlay.height = Math.max(1, Math.round(size.cssHeight * size.pixelRatio));
      needs3D = true;
    },
    onContextRestored: () => {
      // three.js made its GL state anew (initGLContext), the clear color included: set the theme's again.
      if (scene) setClear(background);
      needs3D = true;
    },
  });
  const three = renderer.three;
  three.localClippingEnabled = true;
  const transparency = createTransparency(three);

  const controller = createCameraController(glCanvas, {
    size: () => {
      const s = renderer.size();
      return { width: s.cssWidth, height: s.cssHeight };
    },
    fovDeg: 30,
    onChange: () => {
      needs3D = true;
      renderer.invalidate();
      syncContinuous();
      onPose?.(controller.pose);
    },
    onInteraction: (active) => {
      interacting = active;
      edgeAlphaCap = active ? Number(scene?.style?.drag_edge_alpha ?? 1) : 1;
      layers.edges?.setAlphaCap(edgeAlphaCap);
      clearTimeout(fadeTimer);
      if (active) {
        labelTarget = 0;
      } else {
        fadeTimer = setTimeout(() => {
          labelTarget = 1;
          syncContinuous();
          renderer.invalidate();
        }, LABEL_FADE_BACK_MS);
      }
      needs3D = true;
      syncContinuous();
      renderer.invalidate();
    },
    onEnd: (pose) => onCamera?.(pose),
    onSliceStep: (notches) => onSliceStep?.(notches),
    // A press on a letter of the orientation marker asks for the lock of that axis (or its release).
    onPress: (point) => {
      const axis = markerLetterAt(lastLayout.items, toView(point));
      if (!axis || !onAxisLock) return false;
      onAxisLock(axis);
      return true;
    },
    onClick: ({ x, y, shift, button }) => {
      if (button !== 0 || !scene) return;
      const point = toView({ x, y });
      const index = pick(point).index;
      // E27: a click that misses every sphere may hit an edge line; it reports the edge's id.
      const edge = index < 0 ? pickEdgeAt(point) : null;
      onPick?.({ key: index >= 0 ? keyOf(index) : null, add: Boolean(shift), edge });
    },
    onHover: (point) => {
      const view = point && scene ? toView(point) : null;
      const index = view ? pick(view, true).index : -1;
      if (index !== hoverIndex) {
        hoverIndex = index;
        onHover?.(index >= 0 ? keyOf(index) : null);
        renderer.invalidate();
      }
      // P8: with no sphere under the pointer, the edge line there (its chip shows its effect, p and q).
      const edge = view && index < 0 ? pickEdgeAt(view) : null;
      if (edge !== hoverEdge) {
        hoverEdge = edge;
        onHoverEdge?.(edge, edge === null ? null : { x: point.x, y: point.y });
      }
    },
    onSpin: (on) => onSpin?.(on),
  });

  function syncContinuous() {
    const fading = Math.abs(labelOpacity - labelTarget) > 1e-3;
    renderer.setContinuous(!paused && (Boolean(recorder) || controller.animating || fading || Boolean(pendingAnimation)));
  }

  /**
   * While a recording fixes the view's size and the viewport has another one, the canvases are
   * letterboxed (object-fit: contain): {k, x, y} maps view px to host px (host = view * k + offset).
   */
  function letterbox() {
    const s = renderer.size();
    if (!s.locked || !s.hostWidth || !s.hostHeight) return null;
    const k = Math.min(s.hostWidth / s.cssWidth, s.hostHeight / s.cssHeight);
    return { k, x: (s.hostWidth - s.cssWidth * k) / 2, y: (s.hostHeight - s.cssHeight * k) / 2 };
  }

  /** A point on the host (pointer position) in the view's CSS px. */
  function toView(point) {
    const b = letterbox();
    return b ? { x: (point.x - b.x) / b.k, y: (point.y - b.y) / b.k } : point;
  }

  /** The recording's clock stops while the tab or the page is hidden. */
  function syncRecorderPause() {
    const hidden = paused || document.visibilityState === 'hidden';
    if (!recorder || hidden === recorderPaused) return;
    recorderPaused = hidden;
    if (hidden) recorder.pause(performance.now());
    else recorder.resume(performance.now());
  }
  document.addEventListener('visibilitychange', syncRecorderPause);

  /** A sphere's key: {acr, hemi}, or in a comparison {acr, hemi: side}, since its two midline spheres share hemi C (D46). */
  function keyOf(i) {
    return { acr: scene.nodes.acr[i], hemi: keyHemis[i] };
  }

  function sceneBounds() {
    const b = geometryBounds || scene.world.bounds;
    const center = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2];
    return { center, radius: 0.5 * Math.hypot(b[1] - b[0], b[3] - b[2], b[5] - b[4]) };
  }

  /** Draw in perspective or orthographic projection: a new three.js camera, with the headlight moved onto it. */
  function setProjection(name) {
    const next = name === 'orthographic' ? 'orthographic' : 'perspective';
    if (next === projection) return;
    projection = next;
    const fresh = createThreeCamera(30, projection === 'orthographic');
    camera.remove(headlight, headlight.target);
    three3.remove(camera);
    camera = fresh;
    three3.add(camera);
    camera.add(headlight);
    camera.add(headlight.target);
    lastSortedPose = null;
    needs3D = true;
    renderer.invalidate();
  }

  // ------------------------------------------------------------ the background theme
  /** {background, shell, silhouette} colors of a theme (scene.style.themes; palette.THEMES). */
  function themeOf(name) {
    const themes = scene?.style?.themes;
    return themes?.[name] ?? themes?.black ?? { background: scene.style.background, shell: scene.style.shell.color,
      silhouette: scene.style.shell.silhouette.color };
  }

  function setClear(name) {
    three.setClearColor(new THREE.Color(themeOf(name).background), name === 'transparent' ? 0 : 1);
  }

  /** The tokens' theme on the theme root (light for white and transparent); returns the overlay palette. */
  function setTokens(name) {
    if (name === 'black') delete themeRoot.dataset.figTheme;
    else themeRoot.dataset.figTheme = 'light';
    themeRoot.dataset.figBackground = name;
    return readPalette(host);
  }

  /** Draw on `name`'s background: clear color, shell colors, overlay tokens (and the legend card's). */
  function applyBackground(name) {
    background = ['black', 'white', 'transparent'].includes(name) ? name : 'black';
    setClear(background);
    palette = setTokens(background);
    measure = createMeasure(ctx2d, palette);
    if (display) layers.shell?.apply(display.shell, themeOf(background));
    needs3D = true;
    renderer.invalidate();
  }

  function disposeLayers() {
    for (const layer of Object.values(layers)) {
      if (!layer) continue;
      three3.remove(layer.object);
      layer.dispose();
    }
    layers = { nodes: null, edges: null, arrows: null, regions: null, outlines: null, shell: null };
    geometryStatus = 'none';
    geometryKey = null;
    geometryBounds = null;
  }

  // ------------------------------------------------------------ the camera on three.js
  function cssSize() {
    const s = renderer.size();
    return { width: Math.max(1, s.cssWidth), height: Math.max(1, s.cssHeight), size: s };
  }

  function syncCamera() {
    const pose = controller.pose;
    if (!pose || !scene) return;
    const { width, height } = cssSize();
    const { center, radius } = sceneBounds();
    applyToThree(camera, pose, { aspect: width / height, fovDeg: scene.world.fov_deg, center, radius });
  }

  function pick(point, hover = false) {
    if (!layers.nodes || !display || display.mode !== 'nodes') return { index: -1, how: null, ms: 0 };
    syncCamera();
    const { width, height } = cssSize();
    const result = pickSphere(point, {
      camera, width, height, positions: layers.nodes.positions, radius: layers.nodes.radius,
      visible: layers.nodes.visible,
      pickRadiusPx: Number(scene.style.pick_radius_px) * Number(scene.style.edge_css_px_per_app_px),
    });
    if (hover) {
      hoverPickMs.push(result.ms);
      if (hoverPickMs.length > HOVER_PICK_KEEP) hoverPickMs.shift();
    }
    return result;
  }

  // ------------------------------------------------------------ frames
  function render3D() {
    const { size } = cssSize();
    const pxPerCss = size.height / Math.max(1, size.cssHeight);
    const pxPerAppPx = Number(scene.style.edge_css_px_per_app_px) * pxPerCss;
    layers.edges?.setResolution(size.width, size.height, pxPerAppPx);
    layers.shell?.setResolution(size.width, size.height, pxPerAppPx);
    layers.outlines?.setResolution(size.width, size.height, pxPerAppPx);
    layers.nodes?.setResolution(size.height, pxPerAppPx);
    const pose = controller.pose;
    if (layers.edges && (!lastSortedPose || poseDifference(lastSortedPose, pose) > 0)) {
      layers.edges.sort(camera);
      layers.nodes?.sort(camera);
      lastSortedPose = pose;
    }
    const peel = Boolean(layers.regions?.visible);
    const translucent = [layers.regions?.object, layers.shell?.fill].filter(Boolean);
    layers.shell?.renderFrontDepth(three, camera);
    lastPath = transparency.render(three3, camera, { peel, translucent });
  }

  function layoutNow({ width, height, scaleBar = null, insetBottom = 0 } = cssSize()) {
    const pose = controller.pose;
    const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
    const nodes = layers.nodes;
    const projected = projectPoints(m, nodes.positions, width, height);
    return layoutOverlay({
      width,
      height,
      fovDeg: scene.world.fov_deg,
      camera: { position: pose.position, frame: cameraFrame(pose), umPerPx: umPerPixel(pose, height, scene.world.fov_deg),
        orthographic: projection === 'orthographic', focalDistance: cameraFrame(pose).distance },
      projected,
      nodes: {
        positions: nodes.positions, radius: nodes.radius, visible: nodes.visible, alpha: nodes.alpha,
        acr: scene.nodes.acr, hemi: keyHemis, degree: display?.nodes?.label_degree ?? null, hollow: nodes.hollow,
        color: display?.nodes?.color ?? null, labelMode: display?.nodes?.label_mode ?? null,
      },
      labels: scene.labels,
      labelsOn: Boolean(display?.labels?.enabled),
      labelMode: display?.labels?.mode ?? 'auto',
      labelOpacity,
      labelMinDegree: display?.figure?.label_min_degree ?? 0,
      labelSize: display?.figure?.label_size ?? 'fit',
      labelPx: display?.figure?.label_px ?? 12,
      style: scene.style,
      hover: hoverIndex,
      selected,
      previous: previousLabels,
      measure,
      axes: scene.world.axes,
      marker: true,
      lockAxis: controller.lockAxis,
      insetBottom,
      titles: sideTitles(projected),
      scaleBar: scaleBar ?? (showScaleBar && display?.overlay?.scale_bar !== false),
      // D46: a hollow sphere's outline, as wide as the region outlines (CSS px).
      hollowWidth: (display?.one_dataset?.outline_width_px ?? 2.2) * (scene.style.edge_css_px_per_app_px ?? 0.5),
    });
  }

  /** A comparison's side titles (display.titles), each over the middle of its side's drawn spheres. */
  function sideTitles(projected) {
    const titles = display?.titles;
    const sides = scene?.nodes?.side;
    if (!titles || !sides) return null;
    const out = [];
    for (const side of ['A', 'B']) {
      let sum = 0;
      let count = 0;
      for (let i = 0; i < sides.length; i += 1) {
        if (sides[i] !== side || !layers.nodes.visible[i] || !projected.ok[i]) continue;
        sum += projected.x[i];
        count += 1;
      }
      if (count && titles[side]) out.push({ text: titles[side], x: sum / count });
    }
    return out;
  }

  /** The screen's layout for a capture: the marker and scale bar in the corner, not above a panel. */
  function captureLayout() {
    return insets.bottom ? layoutNow() : lastLayout;
  }

  function paint2D() {
    lastLayout = layoutNow({ ...cssSize(), insetBottom: insets.bottom });
    previousLabels = new Set(lastLayout.labels);
    const { size } = cssSize();
    paintOverlay(ctx2d, lastLayout.items, { scale: overlay.width / Math.max(1, size.cssWidth), palette });
  }

  function drawFrame({ time }) {
    if (!scene || !layers.nodes || paused || exporting) return;
    const dt = lastTime === null ? 0 : Math.max(0, (time - lastTime) / 1000);
    lastTime = time;
    if (pendingAnimation) stepAnimation(time);
    if (controller.advance(dt)) {
      needs3D = true;
      onPose?.(controller.pose); // Spin and the smooth zoom move the camera too: a split view's other panel follows
    }
    if (labelOpacity !== labelTarget) {
      const step = LABEL_FADE_PER_SEC * Math.max(dt, 1 / 120);
      labelOpacity = Math.abs(labelTarget - labelOpacity) <= step ? labelTarget
        : labelOpacity + Math.sign(labelTarget - labelOpacity) * step;
    }
    syncCamera();
    render3D();
    needs3D = false;
    paint2D();
    if (recorder) {
      const under = background === 'transparent' ? themeOf('white').background : null;
      recorder.frame(time, glCanvas, captureItems(captureLayout().items), palette, under);
    }
    if (firstFrameAt === null) firstFrameAt = performance.now();
    if (fullFrameAt === null && geometryStatus === 'ready') fullFrameAt = performance.now();
    syncContinuous();
  }
  renderer.setFrame(drawFrame);

  function stepAnimation(time) {
    const a = pendingAnimation;
    const t = Math.min(1, (time - a.start) / a.ms);
    const s = t * t * (3 - 2 * t);
    const lerp = (p, q) => p.map((v, i) => v + (q[i] - v) * s);
    const pose = { position: lerp(a.from.position, a.to.position), focal_point: lerp(a.from.focal_point, a.to.focal_point),
      view_up: lerp(a.from.view_up, a.to.view_up) };
    if (t >= 1) {
      pendingAnimation = null;
      controller.set(a.to, { end: true });
    } else {
      controller.set(pose);
    }
  }

  /**
   * What a capture draws over the 3D picture (G2): the overlay's items, without the orientation marker or the
   * scale bar when their capture switch is off (display.overlay.capture_marker, capture_scale_bar), plus the
   * legend card when it shows and capture_legend is on. `pick` overrides the switches ({legend, marker,
   * scaleBar}; an export's choices). Labels, the hover glow and the selection ring and tag always stay.
   */
  function captureItems(items, pick = {}) {
    const o = display?.overlay ?? {};
    const legend = pick.legend ?? o.capture_legend !== false;
    const marker = pick.marker ?? o.capture_marker !== false;
    const scaleBar = pick.scaleBar ?? o.capture_scale_bar !== false;
    const kept = items.filter((i) => (i.kind !== 'scalebar' || scaleBar) && (i.kind !== 'marker' || marker))
      // The axis lock is the screen's own: captures draw the marker plain.
      .map((i) => (i.kind === 'marker' ? { ...i, axes: i.axes.map((a) => ({ ...a, locked: false })) } : i));
    const extra = !legend || o.legend === false ? [] : (getFurniture?.() || []);
    return extra.length ? [...kept, ...extra] : kept;
  }

  /** The largest canvas this page is trusted to hold whole, in px (WebKit's limit is about this; Gate A checks it). */
  function canHoldCanvas(width, height, alpha = false) {
    if (width * height > EXPORT_MAX_CANVAS_PIXELS || width > EXPORT_MAX_SIDE || height > EXPORT_MAX_SIDE) return null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha });
      if (!ctx || canvas.width !== width || canvas.height !== height) return null;
      // A canvas the browser cannot back reads back nothing: try its far corner.
      ctx.fillStyle = palette.labelLight;
      ctx.fillRect(width - 1, height - 1, 1, 1);
      const probe = ctx.getImageData(width - 1, height - 1, 1, 1).data;
      if (!(probe[3] === 255 && probe[0] > 0)) return null;
      ctx.clearRect(width - 1, height - 1, 1, 1);
      return ctx;
    } catch {
      return null;
    }
  }

  /**
   * Draw the view at width x height device px in tiles (camera.setViewOffset) and hand the picture over:
   * D45: k = height / the view's CSS height, and every size in CSS px is drawn k times larger (edge widths
   * and silhouettes through their px per app px, and the overlay: labels, glow, ring and tag, marker, scale
   * bar and the legend). The export's frame is (width / k) x the view's CSS height in CSS px, so it keeps
   * the view's vertical field of view and its overlay layout; a wider frame shows more at the sides.
   * Tiles are at most maxTile px a side. When the page can hold the whole picture in one canvas it is
   * composed there and `whole` gets that canvas; otherwise (or with bands: true) each row of tiles is
   * composed in a band canvas (width x tile height) with its part of the overlay and `band(canvas, y)`
   * gets it, top first, so the server can stitch the rows.
   * look: {background, legend, marker, scaleBar} (the export dialog's choices; each defaults to the view's):
   * the picture is drawn on that background theme, the screen keeps its own.
   */
  async function drawExport({ width, height, maxTile = EXPORT_MAX_TILE, bands = false, whole, band, look = {} }) {
    const s = renderer.size();
    const cssH = Math.max(1, s.cssHeight);
    const k = height / cssH;
    const cssW = width / k;
    const pose = controller.pose;
    const { center, radius } = sceneBounds();
    const fovDeg = scene.world.fov_deg;
    const nx = Math.max(1, Math.ceil(width / maxTile));
    const ny = Math.max(1, Math.ceil(height / maxTile));
    const tw = Math.ceil(width / nx);
    const th = Math.ceil(height / ny);
    const theme = look.background ?? background;
    const alpha = theme === 'transparent';
    const full = bands ? null : canHoldCanvas(width, height, alpha);
    if (!full && !band) throw new Error('This picture is too large to compose here.');
    exporting = true;
    const live = background;
    try {
      applyToThree(camera, pose, { aspect: width / height, fovDeg, center, radius });
      // The export's theme: its tokens (and the legend card read under them), then the screen's again at once.
      const lookPalette = setTokens(theme);
      const items = captureItems(layoutNow({ width: cssW, height: cssH, scaleBar: look.scaleBar ?? null }).items,
        look);
      setTokens(live);
      setClear(theme);
      if (display) layers.shell?.apply(display.shell, themeOf(theme));
      const pxPerAppPx = Number(scene.style.edge_css_px_per_app_px) * k;
      layers.edges?.sort(camera);
      layers.nodes?.sort(camera);
      lastSortedPose = null;
      const peel = Boolean(layers.regions?.visible);
      const translucent = [layers.regions?.object, layers.shell?.fill].filter(Boolean);
      three.setPixelRatio(1);
      for (let j = 0; j < ny; j += 1) {
        const y0 = j * th;
        const h = Math.min(th, height - y0);
        let ctx = full;
        let oy = y0;
        if (!full) {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = h;
          ctx = canvas.getContext('2d', { alpha });
          oy = 0;
        }
        for (let i = 0; i < nx; i += 1) {
          const x0 = i * tw;
          const w = Math.min(tw, width - x0);
          three.setSize(w, h, false);
          camera.setViewOffset(width, height, x0, y0, w, h);
          layers.edges?.setResolution(w, h, pxPerAppPx);
          layers.shell?.setResolution(w, h, pxPerAppPx);
          layers.outlines?.setResolution(w, h, pxPerAppPx);
          layers.nodes?.setResolution(h, pxPerAppPx);
          layers.shell?.renderFrontDepth(three, camera);
          lastPath = transparency.render(three3, camera, { peel, translucent });
          ctx.drawImage(glCanvas, 0, 0, w, h, x0, oy, w, h);
        }
        if (!full) {
          paintOverlay(ctx, items, { scale: k, palette: lookPalette, clear: false, height: cssH, offsetY: y0 / k });
          // The 3D canvas is drawn again below, so the next band can wait for the server.
          await band(ctx.canvas, y0);
        }
      }
      if (full) {
        paintOverlay(full, items, { scale: k, palette: lookPalette, clear: false, height: cssH });
        return await whole(full.canvas);
      }
      return null;
    } finally {
      camera.clearViewOffset();
      setTokens(live);
      setClear(live);
      if (display) layers.shell?.apply(display.shell, themeOf(live));
      exporting = false;
      renderer.refit();
      needs3D = true;
      renderer.invalidate();
    }
  }

  /** The view follows its host again after a recording (the recorder itself is stopped by the caller). */
  function endRecording() {
    recorder = null;
    recorderPaused = false;
    if (disposed) return;
    host.classList.remove('is-recording');
    renderer.lockSize(null);
    needs3D = true;
    syncContinuous();
    renderer.invalidate();
  }

  // ------------------------------------------------------------ public
  function selectionIndices(list) {
    return (list || []).map((k) => keyIndex.get(`${k.acr}|${k.hemi}`)).filter((i) => i !== undefined);
  }

  /** The edge id under a point (CSS px of the view), or null: drawn copies only, within half their width + 3 px. */
  function pickEdgeAt(point) {
    if (!layers.edges || !display || display.mode !== 'nodes') return null;
    syncCamera();
    const { width, height } = cssSize();
    const packet = edgesPacket();
    const cssPerApp = Number(scene.style.edge_css_px_per_app_px);
    const k = pickEdge(point, {
      camera, width, height, positions: layers.nodes.positions, s: scene.edges.s, t: scene.edges.t,
      drawn: (i) => Boolean(packet.visible[i]) && Number(packet.alpha[i]) > 0 && Number(packet.width_px[i]) > 0,
      widthCss: (i) => Number(packet.width_px[i]) * cssPerApp, slopPx: EDGE_PICK_SLOP_PX,
      pathOf: (i) => layers.edges.pathOf(i),
    });
    return k >= 0 ? scene.edges.edge_id[k] : null;
  }

  /**
   * Slice view (display.figure.slice; core/slicing.py): the shell draws the plane's cut (the right panel's plane
   * is the left one's mirror across the midline), with the listed regions' cuts in their colors when asked or in
   * Meshes mode; the camera is orthographic and does not rotate.
   */
  function applySlice() {
    const plane = display?.figure?.slice ?? null;
    controller.setRotate(!display?.figure?.frozen); // Slice view and Named spheres in front freeze the view
    if (!layers.shell) return;
    if (!plane) {
      layers.shell.setSlice(null);
      return;
    }
    const m = scene.world.midline_x;
    const mirrored = panel === 'R';
    const normal = mirrored ? [-plane.normal[0], plane.normal[1], plane.normal[2]] : plane.normal;
    const point = mirrored ? [2 * m - plane.point[0], plane.point[1], plane.point[2]] : plane.point;
    const info = display.slice;
    const regions = [];
    if (info && (info.show_regions || display.mode === 'mesh')) {
      const colors = display.regions?.color?.B ?? [];
      for (const i of info.regions) {
        const range = scene.regions.geo_range[i];
        if (!range) continue;
        const rgb = [colors[3 * i], colors[3 * i + 1], colors[3 * i + 2]];
        regions.push({ color: `#${rgb.map((v) => Number(v || 0).toString(16).padStart(2, '0')).join('')}`,
          first: range[1], count: range[2] });
      }
    }
    layers.shell.setSlice({ normal, point }, regions);
  }

  /** A display packet as this split panel draws it: the other side's spheres and edges hidden, its shell half. */
  function panelDisplay(d) {
    if (!panel || !masks) return d;
    const keep = (p) => p === panel || p === 'C';
    return {
      ...d,
      nodes: { ...d.nodes, visible: d.nodes.visible.map((v, i) => Boolean(v) && keep(masks.nodes[i])) },
      edges: { ...d.edges, visible: d.edges.visible.map((v, k) => Boolean(v) && keep(masks.edges[k])) },
      shell: { ...d.shell, half: panel },
    };
  }

  /** The display's edges, with the table's emphasized edge (E27) drawn wider and the others dimmed. */
  function edgesPacket() {
    const edges = display.edges;
    if (edgeFocus === null || !scene) return edges;
    const ids = scene.edges.edge_id;
    const alpha = edges.alpha.map((a, k) => (ids[k] === edgeFocus ? (edges.visible[k] ? 1 : a) : Math.min(a, EDGE_FOCUS_DIM)));
    const width = edges.width_px.map((w, k) => (ids[k] === edgeFocus ? w * EDGE_FOCUS_WIDEN + EDGE_FOCUS_ADD : w));
    return { ...edges, alpha, width_px: width };
  }

  /** D31: the region outline segments for the current camera (layers/outlines.js countSegments). */
  function outlineCount() {
    if (!layers.outlines) return { segments: 0, regions: new Map(), dimmed: new Set() };
    syncCamera();
    return layers.outlines.countSegments(camera.position,
      projection === 'orthographic' ? cameraFrame(controller.pose).vpn : null);
  }

  /** Q23: the regions of the selected spheres, kept bright in Meshes mode while the others dim (empty: none). */
  function regionFocusSet() {
    return display?.mode === 'mesh' && regionFocus.length ? new Set(regionFocus) : null;
  }

  const api = {
    /**
     * Show a static scene (neuronode.scene/1). The camera starts at `pose` (the
     * saved view's), else the scene's start camera (core/camera.py default_pose).
     */
    loadScene(next, { pose = null } = {}) {
      checkScene(next);
      disposeLayers();
      scene = next;
      display = null;
      setClear(background);
      keyHemis = scene.nodes.side ?? scene.nodes.hemi;
      masks = panel ? panelMasks(scene) : null;
      keyIndex = new Map(scene.nodes.acr.map((acr, i) => [`${acr}|${keyHemis[i]}`, i]));
      hoverIndex = -1;
      selected = [];
      lastSortedPose = null;
      firstFrameAt = null;
      fullFrameAt = null;
      layers.nodes = createNodesLayer(scene.nodes);
      layers.edges = createEdgesLayer(scene.edges, layers.nodes.positions, layers.nodes.radius);
      three3.add(layers.nodes.object, layers.edges.object);
      if (scene.dataset.directed) {
        layers.arrows = createArrowsLayer(scene.edges.s.length);
        three3.add(layers.arrows.object);
      }
      transparency.releaseTargets();
      const { center, radius } = sceneBounds();
      controller.setBounds(center, radius);
      controller.setPivot(turnPivot(scene.world, 'B', panel));
      const start = pose && pose.position ? pose : scene.world.default_camera;
      controller.set(copyPose(start));
      needs3D = true;
      renderer.invalidate();
    },

    /**
     * Fetch the scene's region meshes and shell (assets/loader.js) and draw them.
     * Resolves when they are drawn; on failure the spheres and edges stay and onError is told.
     */
    async loadGeometry(ref = scene?.geometry) {
      if (!scene || !ref) return;
      const forScene = scene;
      geometryStatus = 'loading';
      let geometry;
      try {
        geometry = await fetchGeometry(ref, getGeometry);
      } catch (error) {
        if (scene === forScene && !disposed) {
          geometryStatus = 'failed';
          onError?.(error.message || 'The region meshes could not be loaded.');
        }
        return;
      }
      if (scene !== forScene || disposed) return;
      this.useGeometry(geometry);
    },

    /** Draw already parsed geometry (assets/loader.js parseGeometry). */
    useGeometry(geometry) {
      for (const name of ['outlines', 'regions', 'shell']) {
        if (layers[name]) {
          three3.remove(layers[name].object);
          layers[name].dispose();
          layers[name] = null;
        }
      }
      layers.regions = createRegionsLayer(geometry, scene.regions, scene.world.midline_x, transparency.peelUniforms);
      layers.shell = createShellLayer(geometry, scene.style.shell, transparency.peelUniforms, scene.world.midline_x);
      if (geometry.regionEdges && scene.style.region_outline) {
        layers.outlines = createOutlinesLayer(geometry, layers.regions, scene.style.region_outline, scene.world.midline_x);
        three3.add(layers.outlines.object);
      }
      layers.regions.setPanel(panel);
      layers.outlines?.setPanel(panel);
      geometryBounds = geometry.manifest.bounds;
      three3.add(layers.regions.object, layers.shell.object);
      if (display) {
        layers.regions.apply(display.regions, regionFocusSet());
        layers.outlines?.apply(display.outlines, display.one_dataset ?? null);
        applySlice();
        layers.shell.apply(display.shell, themeOf(background));
      }
      geometryStatus = 'ready';
      geometryKey = geometry.key;
      const { center, radius } = sceneBounds();
      controller.setBounds(center, radius);
      needs3D = true;
      renderer.invalidate();
    },

    /** Apply a display packet (neuronode.display/1). The camera never changes here. */
    applyDisplay(next) {
      if (!scene) return;
      checkDisplay(next, scene);
      display = panelDisplay(next);
      controller.setPivot(turnPivot(scene.world, display.hemi_mode, panel));
      setProjection(display.figure?.frozen ? 'orthographic' : display.figure?.projection);
      const wanted = display.figure?.background ?? 'black';
      if (wanted !== background || themeRoot.dataset.figBackground !== wanted) applyBackground(wanted);
      if (layers.nodes.apply(display.nodes, display.node_style)) layers.edges.refreshEnds();
      layers.edges.setTrimEnds(display.node_style?.style === 'flat');
      layers.edges.setDashScale(display.figure?.edge_dash ?? 1);
      layers.edges.apply(edgesPacket());
      layers.arrows?.apply(edgesPacket());
      layers.regions?.apply(display.regions, regionFocusSet());
      layers.outlines?.apply(display.outlines, display.one_dataset ?? null);
      applySlice();
      layers.shell?.apply(display.shell, themeOf(background));
      lastSortedPose = null;
      if (hoverIndex >= 0 && !layers.nodes.visible[hoverIndex]) {
        hoverIndex = -1;
        onHover?.(null);
      }
      needs3D = true;
      renderer.invalidate();
    },

    /** @param {{acr: string, hemi: string}[]} list  the selected spheres */
    setSelection(list) {
      selected = selectionIndices(list);
      const regions = scene ? [...new Set(selected.map((i) => scene.nodes.region_index[i]))] : [];
      if (regions.join() !== regionFocus.join()) {
        regionFocus = regions;
        if (display) layers.regions?.apply(display.regions, regionFocusSet());
        layers.outlines?.refresh();
        needs3D = true;
      }
      renderer.invalidate();
    },

    /**
     * E27: emphasize one edge (every drawn copy of it): it draws at full alpha and wider, the other edges dim.
     * null ends it. The display packet's own values are kept; this only changes how they are drawn.
     */
    setEdgeFocus(edgeId) {
      const next = edgeId === null || edgeId === undefined ? null : Number(edgeId);
      if (next === edgeFocus) return;
      edgeFocus = next;
      if (display) {
        layers.edges.apply(edgesPacket());
        layers.arrows?.apply(edgesPacket());
        lastSortedPose = null;
        needs3D = true;
      }
      renderer.invalidate();
    },

    /** @param {{acr: string, hemi: string} | null} key */
    setHover(key) {
      const [index] = key ? selectionIndices([key]) : [];
      hoverIndex = index ?? -1;
      renderer.invalidate();
    },

    /**
     * Where a drawn sphere is on screen: its center and radius in CSS px of the
     * viewport ({x, y, r}), or null when it is not drawn or is behind the camera.
     * The hover chip sits beside it.
     */
    screenOf(key) {
      const [index] = key ? selectionIndices([key]) : [];
      if (index === undefined || !scene || !layers.nodes?.visible[index]) return null;
      syncCamera();
      const { width, height } = cssSize();
      const p = layers.nodes.positions;
      const center = new THREE.Vector3(p[3 * index], p[3 * index + 1], p[3 * index + 2]);
      const depth = -center.clone().applyMatrix4(camera.matrixWorldInverse).z;
      if (depth <= 0 && !camera.isOrthographicCamera) return null;
      const v = center.project(camera);
      const pxPerWorld = camera.isOrthographicCamera ? height / (camera.top - camera.bottom)
        : height / (2 * Math.tan((camera.fov * Math.PI) / 360) * depth);
      const place = { x: (v.x * 0.5 + 0.5) * width, y: (0.5 - v.y * 0.5) * height, r: layers.nodes.radius[index] * pxPerWorld };
      const b = letterbox(); // on the host, where the hover chip is placed
      return b ? { x: b.x + place.x * b.k, y: b.y + place.y * b.k, r: place.r * b.k } : place;
    },

    getCamera() {
      return controller.pose;
    },

    /** The point turns pivot on now (turnPivot): Slice view's plane starts through it. */
    pivot() {
      return scene ? turnPivot(scene.world, display?.hemi_mode ?? 'B', panel) : null;
    },

    /** Set the camera; animate: move there smoothly (about 0.3 s). */
    setCamera(pose, { animate = false, end = true } = {}) {
      if (!scene) return;
      if (animate && controller.pose) {
        pendingAnimation = { from: controller.pose, to: copyPose(pose), start: performance.now(), ms: 300 };
        syncContinuous();
        renderer.invalidate();
        return;
      }
      controller.set(copyPose(pose), { end });
    },

    /** A camera preset of the scene: left, right, top, bottom, anterior, posterior (core/camera.py). */
    preset(name) {
      const pose = scene?.world?.presets?.[name];
      if (pose) controller.preset(copyPose(pose));
    },

    /** Move to a pose as a preset does (Spin stops; split.js's half-centered presets). */
    presetPose(pose) {
      if (scene && pose) controller.preset(copyPose(pose));
    },

    /** The start camera (core/camera.py default_pose). */
    reset() {
      if (scene) controller.preset(copyPose(scene.world.default_camera));
    },

    /** Keep the direction; move so the whole brain fits (VTK's ResetCamera). */
    fit() {
      controller.fit();
    },

    /**
     * Fit sizes to labels: for every drawn sphere (not a hollow one), its key, its radius (µm), its radius on
     * screen now (CSS px) and the screen radius its acronym needs to fit inside it at labelPx (the labels'
     * cap-height and width rules, and the smallest labeled size). In Slice view only the spheres in the slice.
     */
    labelFit(labelPx) {
      if (!scene || !layers.nodes) return [];
      const { height } = cssSize();
      const pose = controller.pose;
      const nodes = layers.nodes;
      const labels = scene.labels;
      const out = [];
      for (let i = 0; i < nodes.count; i += 1) {
        if (!nodes.visible[i] || nodes.hollow[i] || !(nodes.radius[i] > 0)) continue;
        if (display?.slice && !display.slice.inside[i]) continue;
        if (display?.nodes?.named && !display.nodes.named[i]) continue; // Named spheres in front: the named only
        const dx = nodes.positions[3 * i] - pose.position[0];
        const dy = nodes.positions[3 * i + 1] - pose.position[1];
        const dz = nodes.positions[3 * i + 2] - pose.position[2];
        const distance = projection === 'orthographic' ? cameraFrame(pose).distance : Math.hypot(dx, dy, dz);
        const rPx = screenRadius(nodes.radius[i], distance, height, scene.world.fov_deg);
        const width = measure(scene.nodes.acr[i], { px: labelPx, mono: false, weight: LABEL_FONT_WEIGHT });
        const needPx = Math.max(labels.min_screen_px, (labelPx * CAP_HEIGHT_EM) / labels.height_to_radius,
          width / (2 * labels.max_width_fraction));
        const key = keyOf(i);
        out.push({ key: [key.acr, key.hemi], radiusUm: nodes.radius[i], rPx, needPx });
      }
      return out;
    },

    /** How many drawn spheres the label threshold lets be labeled, and how many the last frame labeled. */
    labelReport() {
      const nodes = layers.nodes;
      const least = Number(display?.figure?.label_min_degree) || 0;
      const degree = display?.nodes?.label_degree ?? [];
      let drawn = 0;
      for (let i = 0; i < (nodes?.count ?? 0); i += 1) {
        if (!nodes.visible[i] || nodes.hollow[i] || (display?.slice && !display.slice.inside[i])) continue;
        if (least <= 0 || (Number(degree[i]) || 0) >= least) drawn += 1;
      }
      const inside = display?.slice?.inside;
      return { labeled: lastLayout.labels.filter((i) => !inside || inside[i]).length, drawn };
    },

    /** The panels over the view ({left, bottom} CSS px): on screen the marker and scale bar sit above the bottom one. */
    setInsets(next) {
      insets = { left: Number(next?.left) || 0, bottom: Number(next?.bottom) || 0 };
      renderer.invalidate();
    },

    /** Turn a drag and Spin about a world axis ('x', 'y' or 'z'; the marker shows it locked), or null. */
    lockAxis(axis) {
      controller.lock(axis);
      renderer.invalidate();
    },

    spin(on) {
      controller.spin(on);
      lastTime = null;
      syncContinuous();
    },

    /** Stop drawing (a hidden tab) or draw again; a recording's clock pauses too. */
    pause(on) {
      paused = Boolean(on);
      lastTime = null;
      syncRecorderPause();
      syncContinuous();
      if (!paused) {
        needs3D = true;
        renderer.invalidate();
      }
    },

    /**
     * The view's size now (renderer.js Size): the drawing buffer in device px, which is a capture's size, and
     * the CSS size. A hidden view is 1 x 1, and it gets its size back about a frame after it shows again.
     */
    size() {
      return renderer.size();
    },

    /**
     * Draw now and return a PNG (Blob) of the 3D view with its overlay (labels, glow, ring and tag,
     * marker, scale bar) and, with the furniture option on, the legend (G2), at the view's size in
     * device px: no other page chrome. G1, D45 (k = 1).
     */
    async capturePng() {
      return pngBlob(this.captureCanvas());
    },

    /** capturePng's picture as a canvas (split.js puts two side by side). */
    captureCanvas() {
      if (!scene || !layers.nodes) throw new Error('There is no scene to capture yet.');
      if (paused) throw new Error('The 3D view is not showing.');
      renderer.renderNow();
      const s = renderer.size();
      return frameCanvas(glCanvas, captureItems(captureLayout().items), {
        width: s.width, height: s.height, scale: s.width / Math.max(1, s.cssWidth), palette,
        alpha: background === 'transparent',
      });
    },

    /** An export of width x height px composed whole, as a canvas (split.js); throws when it is too large. */
    async exportCanvas({ width, height, maxTile = EXPORT_MAX_TILE, look = {} } = {}) {
      if (!scene || !layers.nodes) throw new Error('There is no scene to export yet.');
      if (paused) throw new Error('The 3D view is not showing.');
      return drawExport({ width: Math.round(width), height: Math.round(height), maxTile, look,
        whole: (canvas) => canvas });
    },

    /**
     * A high-resolution export (P8, D45) of width x height px as a PNG Blob, drawn in tiles of at most
     * maxTile px. Returns {blob} when the page could compose it whole; otherwise each band of rows is handed
     * to onBand(rgba Uint8ClampedArray, y, height) in order (the server stitches them) and it returns
     * {bands}. bands: true always hands over bands (a test of the stitching path).
     */
    async exportImage({ width, height, maxTile = EXPORT_MAX_TILE, bands = false, onBand = null, look = {} } = {}) {
      if (!scene || !layers.nodes) throw new Error('There is no scene to export yet.');
      if (paused) throw new Error('The 3D view is not showing.');
      if (recorder) throw new Error('Stop the recording before exporting.');
      const w = Math.round(Number(width));
      const h = Math.round(Number(height));
      if (!(w >= 2 && h >= 2)) throw new Error('The export size is not valid.');
      let count = 0;
      const blob = await drawExport({
        width: w, height: h, maxTile, bands, look,
        whole: (canvas) => pngBlob(canvas),
        band: onBand ? async (canvas, y) => {
          const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          count += 1;
          await onBand(data, y, canvas.height);
        } : null,
      });
      const transparent = (look.background ?? background) === 'transparent';
      return blob ? { blob, width: w, height: h, transparent } : { bands: count, width: w, height: h, transparent };
    },

    /** Whether a recording of the view at its current size can be encoded: {ok, codec, reason, width, height}. */
    async recordingSupport({ maxFps = RECORD_MAX_FPS } = {}) {
      const s = renderer.size();
      const [width, height] = evenFrameSize(s.width, s.height);
      return { ...(await encoderSupport({ width, height, fps: maxFps })), width, height };
    },

    /**
     * Start recording what the view draws (capture/video.js). sink: {open, put, finish, abort}
     * (the server's recording routes); onError(message, kept): the recording failed while it ran,
     * and kept is the server's answer for what was saved of it (null when nothing was). Resolves
     * once the first bytes are written; throws with a plain reason.
     */
    async startRecording({ sink, maxFps = RECORD_MAX_FPS, onError: onRecordingError } = {}) {
      if (recorder) throw new Error('A recording is already running.');
      if (!scene || !layers.nodes) throw new Error('There is no scene to record yet.');
      const s = renderer.size();
      const [width, height] = evenFrameSize(s.width, s.height);
      const support = await encoderSupport({ width, height, fps: maxFps });
      if (!support.ok) throw new Error(support.reason);
      const ratio = s.width / Math.max(1, s.cssWidth);
      const next = createRecorder({
        width, height, scale: ratio, codec: support.codec, sink, maxFps,
        onError: (message) => {
          if (recorder !== next) return;
          endRecording();
          next.salvage().then((kept) => onRecordingError?.(message, kept), () => onRecordingError?.(message, null));
        },
      });
      await next.start();
      if (disposed) {
        await next.cancel();
        throw new Error('The 3D view closed.');
      }
      recorder = next;
      recorderPaused = false;
      renderer.lockSize({ width, height, cssWidth: width / ratio, cssHeight: height / ratio, pixelRatio: ratio });
      host.classList.add('is-recording');
      syncRecorderPause();
      needs3D = true;
      syncContinuous();
      renderer.invalidate();
      return { width, height, codec: support.codec };
    },

    /** Seconds recorded so far (paused time left out), or null when not recording. */
    recordingElapsed() {
      return recorder ? recorder.elapsed(performance.now()) : null;
    },

    /**
     * Stop and keep the recording: the server's finish answer plus {duration_s, fps, counts}; null if
     * none. A failure throws; its `kept` is what was saved anyway (up to the last complete fragment).
     */
    async stopRecording() {
      const done = recorder;
      if (!done) return null;
      endRecording();
      return done.stop();
    },

    /** Drop a running recording (nothing is kept). */
    async cancelRecording() {
      const done = recorder;
      if (!done) return;
      endRecording();
      await done.cancel();
    },

    /** The view's background theme now: 'black', 'white' or 'transparent'. */
    get background() {
      return background;
    },

    /** Read the design tokens again (after a theme change) and redraw the overlay. */
    refreshPalette() {
      palette = readPalette(host);
      measure = createMeasure(ctx2d, palette);
      renderer.invalidate();
    },

    dispose() {
      disposed = true;
      if (recorder) {
        // The page should have stopped it (tab close, pair change, quit); keep what was recorded anyway.
        const done = recorder;
        endRecording();
        done.stop().catch(() => {});
      }
      document.removeEventListener('visibilitychange', syncRecorderPause);
      clearTimeout(fadeTimer);
      controller.dispose();
      disposeLayers();
      transparency.dispose();
      // Give the context back now: a page that opens many pairs would otherwise hit the browser's context limit.
      three.forceContextLoss();
      renderer.dispose();
      glCanvas.remove();
      overlay.remove();
    },
  };

  // ------------------------------------------------------------ debug hooks (window.__nn.debug)
  api.debug = {
    /** Slice view's drawn cut segments {outline, regions}, and the projection now. */
    slice: () => ({ ...(layers.shell?.sliceCounts() ?? {}), projection }),
    /** What is drawn now: spheres, edge copies, region meshes loaded and drawn, arrows, labels. */
    counts() {
      return {
        spheres: layers.nodes?.drawnCount() ?? 0,
        edge_copies: layers.edges?.drawnCount() ?? 0,
        edge_segments: layers.edges?.segmentCount() ?? 0,
        regions: scene ? scene.regions.geo_range.filter((r) => r).length * (layers.regions ? 1 : 0) : 0,
        regions_drawn: layers.regions?.drawnCount() ?? 0,
        arrows: layers.arrows?.drawnCount() ?? 0,
        labels: lastLayout.labels.length,
        shell_edges: layers.shell?.edgeCount ?? 0,
        shell: Boolean(layers.shell?.visible),
        // D31: region outline segments on the silhouette for the camera now, in the regions drawn (0: none drawn).
        outline_segments: outlineCount().segments,
      };
    },
    /** D46: a comparison's hollow spheres shown now (the overlay draws them) and hollow region halves. */
    hollow() {
      return { spheres: layers.nodes?.hollowCount() ?? 0, halves: layers.regions?.hollowShown ?? 0 };
    },
    /**
     * D31: the region outlines drawn now: {on, segments, edges, regions: [{index, acr, segments, dimmed}]} (scene
     * region index; dimmed: drawn at the Q23 dim alpha), from the same test the GPU makes.
     */
    outlines() {
      const { segments, regions, dimmed } = outlineCount();
      const sceneOf = new Map((layers.regions?.geometryIds() ?? []).map((id, i) => [id, i]));
      const list = [...regions].map(([id, n]) => ({ index: sceneOf.get(id), acr: scene.regions.acr?.[sceneOf.get(id)],
        segments: n, dimmed: dimmed.has(id) })).sort((a, b) => a.index - b.index);
      return { on: Boolean(layers.outlines?.visible), segments, edges: layers.outlines?.edgeCount ?? 0, regions: list };
    },
    /**
     * Projected positions in CSS px of the viewport, from what the GPU was given:
     * each drawn sphere's instance center, each arrowhead's apex and the turns' pivot (with its world point).
     */
    projected() {
      if (!scene || !layers.nodes) return null;
      syncCamera();
      const { width, height } = cssSize();
      const project = (p) => {
        const v = new THREE.Vector3(p[0], p[1], p[2]).project(camera);
        return { x: (v.x * 0.5 + 0.5) * width, y: (0.5 - v.y * 0.5) * height, ndc_z: v.z };
      };
      const nodes = layers.nodes.drawn().map((i) => {
        const c = layers.nodes.drawnCenter(i);
        return { index: i, acr: scene.nodes.acr[i], hemi: keyHemis[i], ...project([c.x, c.y, c.z]) };
      });
      const arrows = (layers.arrows?.drawnTips() ?? []).map(({ copy, tip }) => ({ copy, ...project(tip) }));
      const point = controller.pivot;
      return { width, height, nodes, arrows, pivot: point && { point, ...project(point) } };
    },
    /** The emphasized edge (E27): its id, its copies with their drawn width and alpha, and the others' top alpha. */
    edgeFocus() {
      if (edgeFocus === null || !display) return null;
      const packet = edgesPacket();
      const copies = [];
      let others = 0;
      scene.edges.edge_id.forEach((id, k) => {
        if (id === edgeFocus) copies.push({ copy: k, width: packet.width_px[k], alpha: packet.alpha[k],
          base_width: display.edges.width_px[k] });
        else if (display.edges.visible[k]) others = Math.max(others, packet.alpha[k]);
      });
      return { edge_id: edgeFocus, copies, others_alpha: others };
    },
    /** Q23: the regions kept bright in Meshes mode (scene region indices), or null. */
    regionFocus() {
      const focus = regionFocusSet();
      return focus ? [...focus] : null;
    },
    /** Drawn edge copies: [copy index, width in app px] in draw order. */
    edgeWidths() {
      return (layers.edges?.drawOrder() ?? []).map((k) => [k, layers.edges.drawnWidth(k)]);
    },
    camera() {
      return controller.pose;
    },
    size() {
      return renderer.size();
    },
    /** The running recording's state, counts and kept frame times, or null. */
    recording() {
      return recorder ? recorder.debug() : null;
    },
    status() {
      return {
        scene: Boolean(scene),
        display: Boolean(display),
        geometry: geometryStatus,
        geometry_key: geometryKey,
        frames: renderer.frames,
        first_frame_at: firstFrameAt,
        full_frame_at: fullFrameAt,
        render_path: lastPath,
        spinning: controller.spinning,
        label_opacity: labelOpacity,
        edge_alpha_cap: edgeAlphaCap,
        interacting,
        context_lost: renderer.contextLost,
        context_losses: renderer.contextLosses,
      };
    },
    /** The last overlay display list. */
    layout() {
      return lastLayout;
    },
    /** The edge id under (x, y) CSS px of the viewport, or null (E27). */
    edgeAt(x, y) {
      return pickEdgeAt({ x, y });
    },
    /**
     * Where an edge copy's middle is on screen, CSS px of the viewport, or null when it is behind the camera.
     * A curved copy's middle is its path's middle point.
     */
    edgeMiddle(copy) {
      if (!scene || !layers.nodes) return null;
      syncCamera();
      const { width, height } = cssSize();
      const p = layers.nodes.positions;
      const [a, b] = [scene.edges.s[copy], scene.edges.t[copy]];
      const path = layers.edges?.pathOf(copy);
      const i = path ? 3 * Math.floor(path.length / 6) : 0;
      const mid = path ? new THREE.Vector3(path[i], path[i + 1], path[i + 2])
        : new THREE.Vector3((p[3 * a] + p[3 * b]) / 2, (p[3 * a + 1] + p[3 * b + 1]) / 2,
          (p[3 * a + 2] + p[3 * b + 2]) / 2);
      if (-mid.clone().applyMatrix4(camera.matrixWorldInverse).z <= 0) return null;
      const v = mid.project(camera);
      return { x: (v.x * 0.5 + 0.5) * width, y: (0.5 - v.y * 0.5) * height };
    },
    /** Pick at (x, y) CSS px of the viewport. */
    pickAt(x, y) {
      const result = pick({ x, y });
      return { ...result, key: result.index >= 0 ? keyOf(result.index) : null };
    },
    hoverPickStats() {
      return summarize(hoverPickMs);
    },
    /** Draw now and return the 3D canvas alone (no overlay) as a PNG data URL. */
    canvasPng() {
      renderer.renderNow();
      return glCanvas.toDataURL('image/png');
    },
    /** Draw now and return the overlay canvas as a PNG data URL. */
    overlayPng() {
      renderer.renderNow();
      return overlay.toDataURL('image/png');
    },
    /**
     * Frame times (plan section 6, P3a budgets): each frame is an orbit step,
     * the 3D render, the overlay (unless overlay is false), then gl.finish and a
     * 1-pixel readback so the GPU has finished.
     */
    bench({ frames = 120, warmup = 30, overlay: withOverlay = true } = {}) {
      const start = controller.pose;
      const step = 360 / (frames + warmup);
      const result = measureRenderTimes({
        gl: renderer.gl,
        frames,
        warmup,
        step: () => {
          controller.set(azimuth(controller.pose, step));
        },
        render: () => {
          three.info.reset();
          syncCamera();
          render3D();
          if (withOverlay) paint2D();
        },
      });
      controller.set(start);
      const info = three.info.render;
      return { ...result, calls: info.calls, triangles: info.triangles, path: lastPath, buffer: renderer.size() };
    },
  };
  return api;
}

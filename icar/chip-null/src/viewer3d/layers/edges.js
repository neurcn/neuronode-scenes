/**
 * The edge lines (plan 3.8 viewer3d/layers/edges.js): every drawn edge copy in
 * one instanced draw with edge_material.js. One copy per entry of the static
 * scene's edges (s, t are node indices); visibility, width (app px), color and
 * alpha come from the display packet (D28, D43, D44): JavaScript decides none
 * of them. A curved copy (display edges.path, core/edge_paths.py) is a chain
 * of segments through its interior points, mitered where they meet.
 *
 * Named spheres in front (display edges.dashed): an edge with a muted end is
 * dashed, its dashes scaled by the figure's edge_dash and its width. With
 * flat spheres (setTrimEnds) an edge stops at its two spheres' borders on
 * screen, so no line runs into a disc.
 *
 * The visible copies are packed back to front for the camera (sorted blending,
 * plan 3.8), so a nearer line blends over a farther one. sort() runs when the
 * camera moved.
 *
 * Plain ES module: imports three only.
 */

import * as THREE from 'three';
import { createEdgeMaterial, createSegmentGeometry } from '../edge_material.js';

/**
 * @param {{s: number[], t: number[]}} sceneEdges  the static scene's edge copies
 * @param {Float64Array} nodePositions  world µm, 3 per node
 * @param {Float64Array} nodeRadius  world µm, per node (the spheres' drawn radii)
 */
export function createEdgesLayer(sceneEdges, nodePositions, nodeRadius) {
  const n = sceneEdges.s.length;
  const size = Math.max(1, n);
  const geometry = createSegmentGeometry({ caps: true });
  const attrs = {};
  let capacity = 0; // instance slots allocated
  const SPECS = [['aStart', 3, Float32Array], ['aEnd', 3, Float32Array], ['aPrev', 3, Float32Array],
    ['aNext', 3, Float32Array], ['aJoin', 2, Uint8Array], ['aColor', 3, Uint8Array, true],
    ['aAlpha', 1, Float32Array], ['aWidth', 1, Float32Array], ['aCenterA', 3, Float32Array],
    ['aCenterB', 3, Float32Array], ['aRadius', 2, Float32Array], ['aDash', 1, Uint8Array]];
  function ensureCapacity(slots) {
    if (slots <= capacity) return;
    capacity = Math.max(slots, 2 * capacity, size);
    if (attrs.aStart) geometry.dispose(); // the old buffers go; the next render uploads the new ones
    for (const [name, width, ArrayType, normalized] of SPECS) {
      const a = new THREE.InstancedBufferAttribute(new ArrayType(capacity * width), width, Boolean(normalized));
      a.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, a);
      attrs[name] = a;
    }
  }
  ensureCapacity(size);
  const material = createEdgeMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'edges';
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;

  // Per copy: ends (world µm) and midpoint, from the spheres' positions (refreshEnds when they move).
  const ends = new Float64Array(6 * size);
  const mid = new Float64Array(3 * size);
  // Per copy: a curved path's interior points (world µm, core/edge_paths.py), or null for a straight copy.
  let interior = new Array(n).fill(null);
  function refreshMid(k) {
    const path = interior[k];
    for (let j = 0; j < 3; j += 1) {
      if (path) {
        const i = 3 * Math.floor(path.length / 6);
        mid[3 * k + j] = path[i + j];
      } else {
        mid[3 * k + j] = 0.5 * (ends[6 * k + j] + ends[6 * k + 3 + j]);
      }
    }
  }
  function refreshEnds() {
    for (let k = 0; k < n; k += 1) {
      const s = sceneEdges.s[k];
      const t = sceneEdges.t[k];
      for (let j = 0; j < 3; j += 1) {
        ends[6 * k + j] = nodePositions[3 * s + j];
        ends[6 * k + 3 + j] = nodePositions[3 * t + j];
      }
      refreshMid(k);
    }
  }
  refreshEnds();
  // Per copy, from the display packet.
  const width = new Float32Array(size);
  const alpha = new Float32Array(size);
  const color = new Uint8Array(3 * size);
  const dashed = new Uint8Array(size);
  let shown = []; // visible copy indices
  let order = []; // visible copy indices in draw order
  let slotCopy = new Int32Array(0); // copy index of each instance slot

  /** Point i of copy k's polyline (0: the source sphere, last: the target sphere) into out at o. */
  function point(k, i, last, out, o) {
    const path = interior[k];
    for (let j = 0; j < 3; j += 1) {
      if (i === 0) out[o + j] = ends[6 * k + j];
      else if (i === last) out[o + j] = ends[6 * k + 3 + j];
      else out[o + j] = path[3 * (i - 1) + j];
    }
  }

  function pack(list) {
    order = list;
    let slots = 0;
    for (const k of list) slots += interior[k] ? interior[k].length / 3 + 1 : 1;
    ensureCapacity(slots);
    slotCopy = new Int32Array(slots);
    const { aStart, aEnd, aPrev, aNext, aJoin, aColor, aAlpha, aWidth, aCenterA, aCenterB, aRadius, aDash } = attrs;
    let slot = 0;
    for (const k of list) {
      const last = interior[k] ? interior[k].length / 3 + 1 : 1; // index of the target point
      for (let i = 0; i < last; i += 1) {
        point(k, i, last, aStart.array, 3 * slot);
        point(k, i + 1, last, aEnd.array, 3 * slot);
        point(k, Math.max(i - 1, 0), last, aPrev.array, 3 * slot);
        point(k, Math.min(i + 2, last), last, aNext.array, 3 * slot);
        aJoin.array[2 * slot] = i > 0 ? 1 : 0;
        aJoin.array[2 * slot + 1] = i < last - 1 ? 1 : 0;
        for (let j = 0; j < 3; j += 1) aColor.array[3 * slot + j] = color[3 * k + j];
        aAlpha.array[slot] = alpha[k];
        aWidth.array[slot] = width[k];
        for (let j = 0; j < 3; j += 1) {
          aCenterA.array[3 * slot + j] = ends[6 * k + j];
          aCenterB.array[3 * slot + j] = ends[6 * k + 3 + j];
        }
        aRadius.array[2 * slot] = nodeRadius ? nodeRadius[sceneEdges.s[k]] : 0;
        aRadius.array[2 * slot + 1] = nodeRadius ? nodeRadius[sceneEdges.t[k]] : 0;
        aDash.array[slot] = dashed[k];
        slotCopy[slot] = k;
        slot += 1;
      }
    }
    for (const a of Object.values(attrs)) {
      a.needsUpdate = true;
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(1, slots) * a.itemSize);
    }
    geometry.instanceCount = slots;
    mesh.visible = slots > 0;
  }

  /** Apply a display packet's edges {visible, width_px, color, alpha, path, dashed?}. */
  function apply(packet) {
    shown = [];
    const paths = packet.path || null;
    for (let k = 0; k < n; k += 1) {
      const a = Number(packet.alpha[k]) || 0;
      width[k] = Number(packet.width_px[k]) || 0;
      alpha[k] = a;
      color[3 * k] = packet.color[3 * k];
      color[3 * k + 1] = packet.color[3 * k + 1];
      color[3 * k + 2] = packet.color[3 * k + 2];
      dashed[k] = packet.dashed?.[k] ? 1 : 0;
      const path = paths?.[k];
      const next = path && path.length >= 3 ? Float64Array.from(path) : null;
      if (next !== interior[k]) {
        interior[k] = next;
        refreshMid(k);
      }
      if (packet.visible[k] && a > 0 && width[k] > 0) shown.push(k);
    }
    pack(shown);
  }

  // Sort keys: the quantized view depth (high bits) and the copy index (low 24 bits) in one float64, so the
  // native numeric sort of a Float64Array orders the copies; a key is exact below 2^53.
  const INDEX_BITS = 2 ** 24;
  const DEPTH_STEPS = 2 ** 28;
  const keys = new Float64Array(size);
  /** Pack the visible copies back to front for this camera (by the midpoint's view depth). */
  function sort(camera) {
    const m = shown.length;
    if (m < 2) return;
    const e = camera.matrixWorldInverse.elements;
    const near = camera.near;
    const span = Math.max(camera.far - near, 1e-9);
    for (let i = 0; i < m; i += 1) {
      const k = shown[i];
      const z = e[2] * mid[3 * k] + e[6] * mid[3 * k + 1] + e[10] * mid[3 * k + 2] + e[14]; // view z, negative ahead
      // Farther first: the distance beyond the near plane, reversed, in [0, DEPTH_STEPS).
      const t = Math.min(Math.max((-z - near) / span, 0), 1);
      keys[i] = Math.floor((1 - t) * (DEPTH_STEPS - 1)) * INDEX_BITS + k;
    }
    const sorted = keys.subarray(0, m).sort();
    const next = new Array(m);
    for (let i = 0; i < m; i += 1) next[i] = sorted[i] % INDEX_BITS;
    pack(next);
  }

  return {
    object: mesh,
    material,
    count: n,
    apply,
    /** The spheres moved (a comparison's midline spheres, D46): take the new ends; the next apply packs them. */
    refreshEnds,
    sort,
    /** Copies drawn now. */
    drawnCount: () => shown.length,
    /** Segments drawn now (one per straight copy). */
    segmentCount: () => slotCopy.length,
    /** Copy indices in draw order. */
    drawOrder: () => Array.from(order),
    /** The width (app px) the instances of copy k carry, or null when it is not drawn. */
    drawnWidth(k) {
      const slot = slotCopy.indexOf(k);
      return slot < 0 ? null : attrs.aWidth.array[slot];
    },
    /** Copy k's curved path's interior points (world µm), or null for a straight copy. */
    pathOf: (k) => interior[k],
    /** Size the lines for a drawing buffer of width x height device px at pxPerAppPx device px per app px. */
    setResolution(widthPx, heightPx, pxPerAppPx) {
      material.uniforms.uResolution.value.set(widthPx, heightPx);
      material.uniforms.uPxPerAppPx.value = pxPerAppPx;
    },
    /** While dragging, every edge is drawn at most this opaque (style.drag_edge_alpha); 1 otherwise. */
    setAlphaCap(cap) {
      material.uniforms.uAlphaCap.value = cap;
    },
    /** Flat spheres: edges stop at their spheres' borders on screen. */
    setTrimEnds(on) {
      material.uniforms.uTrimEnds.value = on ? 1 : 0;
    },
    /** The dashes' scale (display.figure.edge_dash). */
    setDashScale(scale) {
      material.uniforms.uDashScale.value = Number(scale) || 1;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * Hover and click picking of the spheres (plan 3.8 viewer3d/picking.js),
 * today's rule (viewer.py _pick_node_at_display_pos), independent of the shell:
 * 1. the drawn sphere whose projected center is nearest the pointer, within
 *    style.pick_radius_px app px (24: 12 CSS px, 24 device px on a 2x display);
 * 2. otherwise the nearest sphere the pointer's ray hits (an analytic
 *    ray-sphere test; today's fallback is a VTK prop pick on the surfaces).
 * Dimmed spheres (outside a network highlight) can be picked; hidden ones
 * cannot. Meshes mode has no spheres, so nothing is picked there.
 *
 * Plain ES module: imports three only.
 */

import * as THREE from 'three';

/**
 * @param {{x: number, y: number}} point  CSS px from the viewport's top left
 * @param {{camera: THREE.PerspectiveCamera, width: number, height: number,
 *          positions: Float64Array, radius: Float64Array, visible: Uint8Array,
 *          pickRadiusPx: number}} spec  pickRadiusPx in CSS px
 * @returns {{index: number, how: 'center'|'ray'|null, ms: number}}
 */
export function pickSphere(point, { camera, width, height, positions, radius, visible, pickRadiusPx }) {
  const started = performance.now();
  const n = visible.length;
  const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const e = m.elements;
  const limit = pickRadiusPx * pickRadiusPx;
  let best = -1;
  let bestD2 = Infinity;
  for (let i = 0; i < n; i += 1) {
    if (!visible[i]) continue;
    const x = positions[3 * i];
    const y = positions[3 * i + 1];
    const z = positions[3 * i + 2];
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (w <= 0) continue; // behind the camera
    const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w * 0.5 + 0.5) * width;
    const sy = (0.5 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / w * 0.5) * height;
    const dx = sx - point.x;
    const dy = sy - point.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= limit && d2 < bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  if (best >= 0) return { index: best, how: 'center', ms: performance.now() - started };

  // The pointer's ray, in world coordinates.
  const ndc = new THREE.Vector3((point.x / width) * 2 - 1, 1 - (point.y / height) * 2, 0.5);
  let origin = camera.position;
  let dir;
  if (camera.isOrthographicCamera) { // parallel rays: from the near plane along the view direction
    origin = new THREE.Vector3(ndc.x, ndc.y, -1).unproject(camera);
    dir = new THREE.Vector3(0, 0, -1).transformDirection(camera.matrixWorld);
  } else {
    dir = ndc.unproject(camera).sub(origin).normalize();
  }
  let bestT = Infinity;
  for (let i = 0; i < n; i += 1) {
    if (!visible[i]) continue;
    const ox = origin.x - positions[3 * i];
    const oy = origin.y - positions[3 * i + 1];
    const oz = origin.z - positions[3 * i + 2];
    const b = ox * dir.x + oy * dir.y + oz * dir.z;
    const c = ox * ox + oy * oy + oz * oz - radius[i] * radius[i];
    const disc = b * b - c;
    if (disc < 0) continue;
    const t = -b - Math.sqrt(disc);
    if (t > 0 && t < bestT) {
      bestT = t;
      best = i;
    }
  }
  return { index: best, how: best >= 0 ? 'ray' : null, ms: performance.now() - started };
}

/**
 * E27: the drawn edge copy nearest the pointer on screen, within half its
 * drawn width plus slopPx (CSS px), or -1. A copy is its polyline as edges.js
 * draws it: its spheres' centers, through its path's interior points when
 * curved; a point behind the camera ends the test of that copy.
 * @param {{x: number, y: number}} point  CSS px from the viewport's top left
 * @param {{camera: THREE.PerspectiveCamera, width: number, height: number, positions: Float64Array,
 *          s: number[], t: number[], drawn: (k: number) => boolean, widthCss: (k: number) => number,
 *          slopPx: number, pathOf?: (k: number) => ArrayLike<number>|null}} spec
 * @returns {number} the copy index, or -1
 */
export function pickEdge(point, { camera, width, height, positions, s, t, drawn, widthCss, slopPx, pathOf = null }) {
  const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const e = m.elements;
  const screen = (arr, o) => {
    const x = arr[o];
    const y = arr[o + 1];
    const z = arr[o + 2];
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (w <= 0) return null;
    return [((e[0] * x + e[4] * y + e[8] * z + e[12]) / w * 0.5 + 0.5) * width,
      (0.5 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / w * 0.5) * height];
  };
  const distance = (a, b) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const u = len2 > 0 ? Math.max(0, Math.min(1, ((point.x - a[0]) * dx + (point.y - a[1]) * dy) / len2)) : 0;
    return Math.hypot(point.x - (a[0] + u * dx), point.y - (a[1] + u * dy));
  };
  let best = -1;
  let bestD = Infinity;
  for (let k = 0; k < s.length; k += 1) {
    if (!drawn(k)) continue;
    const path = pathOf?.(k) || null;
    const pts = [screen(positions, 3 * s[k])];
    for (let i = 0; path && i < path.length; i += 3) pts.push(screen(path, i));
    pts.push(screen(positions, 3 * t[k]));
    if (pts.some((p) => !p)) continue;
    let d = Infinity;
    for (let i = 0; i + 1 < pts.length; i += 1) d = Math.min(d, distance(pts[i], pts[i + 1]));
    if (d <= widthCss(k) / 2 + slopPx && d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

/**
 * The 2D overlay's layout (plan 3.8 viewer3d/overlay/layout.js): a pure
 * function from the camera, the drawn spheres and the scene's label rules to
 * a display list, which overlay/paint2d.js paints on the live overlay canvas
 * and, later, into screenshots and video frames (so captures equal the screen).
 * Every size is in CSS px; the painter scales.
 *
 * Node labels, inside the spheres with today's rule (viewer.py 3527-3616; Q10):
 * - only in Nodes mode with labels on (display.labels.enabled);
 * - a sphere is a candidate when its screen radius is at least
 *   labels.min_screen_px (8); screen radius = radius x height /
 *   (2 x distance to the camera x tan(fov / 2)), or in an orthographic view
 *   (camera.orthographic) the focal distance for every sphere, with depth
 *   along the view direction ordering them;
 * - priority = screen radius + per_degree (0.015) x the sphere's total degree
 *   in the stats scope, + hover (10000) for the hovered sphere and + selected
 *   (5000) for a selected one; the first max_visible (120) are kept;
 * - the text's cap height is height_to_radius (0.62) x the screen radius, its
 *   width at most 2 x max_width_fraction (0.82) x the screen radius; centered
 *   on the sphere;
 * - a label takes its sphere's alpha (dimmed outside a network highlight) and
 *   the fade the view runs while the camera moves;
 * - its text is dark on a light fill and light on a dark one (`dark`: the
 *   fill's relative luminance above LABEL_DARK_ABOVE, where dark text has the
 *   higher contrast).
 * Figure options (display.figure): labelMinDegree labels only spheres whose
 * total degree in scope is at least N (the hovered and selected spheres stay
 * labeled); labelSize 'fixed' draws every label at labelPx CSS px, whatever
 * its sphere's size, centered on it with a halo (`halo`), instead of fitting
 * it inside the sphere. A style group's label mode (nodes.labelMode, per
 * sphere): 'always' labels its spheres as the selected ones are (whatever the
 * threshold and the declutter mode), 'hidden' never labels them unless they
 * are hovered or selected.
 * Declutter modes (E7 v1, display.label_mode; the spike's auto/all/off):
 * - auto: as above, so labels never overlap;
 * - all: every candidate that fits its sphere is labeled: no overlap test and
 *   no max_visible cap (the depth test stays, as today's depth buffer hid
 *   covered labels);
 * - off: only the hovered and the selected spheres are labeled.
 * Added here because the labels are drawn in 2D, not as depth-tested 3D text:
 * a label whose sphere's center is covered by a nearer sphere is left out (the
 * depth test hid it today), a label that would overlap one already placed is
 * left out (E7: labels never overlap), and a label shown in the last frame
 * gets HYSTERESIS_PX more priority so labels do not flicker as the view moves.
 *
 * Also: the hover glow (style.hover_glow), the selection halo
 * (style.selection_halo) with the white ring and the tag of the mockup
 * (kit.selection_mark), the anatomical orientation marker (E22, kit.orientation;
 * the axis a drag is locked to, spec.lockAxis, is marked `locked`, and
 * markerLetterAt finds the letter under a point)
 * and the scale bar (kit.scale_bar, today's 1-2-5 rule: viewer_ui.py
 * ScaleBarOverlay, 140 px preferred, 70-360 px).
 *
 * Plain ES module; no imports.
 */

export const LABEL_MODES = ['auto', 'all', 'off'];
export const CAP_HEIGHT_EM = 0.698;   // IBM Plex Sans cap height, in em
export const HYSTERESIS_PX = 2;
export const LABEL_FONT_WEIGHT = 600;
export const LABEL_DARK_ABOVE = 0.18;  // fill luminance above which dark text has the higher contrast (WCAG 2)

/** Relative luminance (WCAG 2) of an 8-bit sRGB color. */
export function luminance(r, g, b) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
export const MONO_PX = 12;           // kit: marker letters, scale bar label and tag, 12 px mono
export const TAG = { padX: 6, padY: 1, lineHeight: 16, gap: 6, rise: 14, border: 1, radius: 4 };
export const RING = { minRadius: 14, extra: 4, lineWidth: 2 };
export const PAD = 16;
export const MARKER = { width: 70, height: 64, origin: [28, 38], length: 23, letterGap: 9, lineWidth: 1.5, dot: 1.8,
  oblique: [-0.53, 0.49], obliqueFrom: 0.6, inset: PAD + 4, gap: 20 };
export const SCALE_BAR = { preferredPx: 140, minPx: 70, maxPx: 360, tick: 10, rule: 2, ruleTop: 4, labelGap: 5,
  labelHeight: 14 };

const OPPOSITE = { left: 'right', right: 'left', dorsal: 'ventral', ventral: 'dorsal', anterior: 'posterior',
  posterior: 'anterior' };

/**
 * Project world points with a column-major 4x4 view-projection matrix.
 * @param {ArrayLike<number>} m  projection x view, column-major (three.js Matrix4.elements)
 * @param {ArrayLike<number>} positions  x, y, z per point (world µm)
 * @returns {{x: Float64Array, y: Float64Array, ok: Uint8Array}}  CSS px from the top left; ok: in front of the camera
 */
export function projectPoints(m, positions, width, height) {
  const n = positions.length / 3;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const ok = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const px = positions[3 * i];
    const py = positions[3 * i + 1];
    const pz = positions[3 * i + 2];
    const w = m[3] * px + m[7] * py + m[11] * pz + m[15];
    ok[i] = w > 0 ? 1 : 0;
    x[i] = ((m[0] * px + m[4] * py + m[8] * pz + m[12]) / w * 0.5 + 0.5) * width;
    y[i] = (0.5 - (m[1] * px + m[5] * py + m[9] * pz + m[13]) / w * 0.5) * height;
  }
  return { x, y, ok };
}

/** today's _estimate_node_screen_radius_px: radius x height / (2 x distance x tan(fov / 2)). */
export function screenRadius(radius, distance, height, fovDeg) {
  return (radius * height) / (2 * Math.max(distance, 1e-6) * Math.tan((fovDeg * Math.PI) / 360));
}

/** Today's 1-2-5 values the bar can draw between minPx and maxPx at umPerPx. */
export function scaleBarValues(umPerPx, { minPx = SCALE_BAR.minPx, maxPx = SCALE_BAR.maxPx } = {}) {
  const lo = minPx * umPerPx;
  const hi = maxPx * umPerPx;
  const out = [];
  if (!(lo > 0) || !Number.isFinite(hi)) return out;
  for (let exp = Math.floor(Math.log10(lo)) - 1; exp <= Math.ceil(Math.log10(hi)) + 1; exp += 1) {
    for (const base of [1, 2, 5]) {
      const v = Number(`${base}e${exp}`);
      if (v >= lo && v <= hi) out.push(v);
    }
  }
  return out.sort((a, b) => a - b);
}

/**
 * The scale bar for umPerPx µm per CSS px at the focal plane: the 1-2-5 value
 * whose drawn length is nearest preferredPx by ratio, its length (rounded
 * px) and its label, as today's ScaleBarOverlay.
 */
export function scaleBar(umPerPx, { preferredPx = SCALE_BAR.preferredPx } = {}) {
  const values = scaleBarValues(umPerPx);
  if (!values.length) return null;
  let best = values[0];
  for (const v of values) {
    if (Math.abs(Math.log(v / umPerPx / preferredPx)) < Math.abs(Math.log(best / umPerPx / preferredPx))) best = v;
  }
  const px = Math.round(best / umPerPx);
  const text = `${best >= 1 ? String(Math.round(best)) : String(Number(best.toPrecision(3)))} µm`;
  return { um: best, px, text };
}

/**
 * The orientation marker's axes for a camera frame {right, up, vpn} (unit world
 * vectors; vpn points toward the viewer). Each world axis is drawn toward the
 * side that faces the viewer (the positive side when it is edge-on) and named
 * by that anatomical side; an axis that points mostly at the viewer leans to
 * the lower left, as kit.orientation draws 'L toward the viewer'.
 * @param {{x: string, y: string, z: string}} axes  scene.world.axes: the anatomical side of each positive axis
 */
export function markerAxes(cameraFrame, axes = { x: 'left', y: 'dorsal', z: 'anterior' }) {
  const out = [];
  const unitAxes = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  for (const key of ['x', 'y', 'z']) {
    let a = unitAxes[key];
    let side = axes[key];
    const toward = a[0] * cameraFrame.vpn[0] + a[1] * cameraFrame.vpn[1] + a[2] * cameraFrame.vpn[2];
    if (toward < -1e-6) {
      a = a.map((v) => -v);
      side = OPPOSITE[side] ?? side;
    }
    const t = Math.abs(toward);
    let dx = a[0] * cameraFrame.right[0] + a[1] * cameraFrame.right[1] + a[2] * cameraFrame.right[2];
    let dy = -(a[0] * cameraFrame.up[0] + a[1] * cameraFrame.up[1] + a[2] * cameraFrame.up[2]);
    const lean = Math.max(0, Math.min(1, (t - MARKER.obliqueFrom) / (1 - MARKER.obliqueFrom)));
    dx += lean * MARKER.oblique[0];
    dy += lean * MARKER.oblique[1];
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    out.push({ axis: key, side, letter: side[0].toUpperCase(), dx, dy, toward: t });
  }
  return out;
}

export const LETTER_HIT_PX = 11;
export const TITLE_PX = 18;          // a comparison's side titles   // a press this near a marker letter's center takes it

/** The world axis ('x', 'y' or 'z') of the marker letter at point {x, y} (CSS px) in a layout's items, or null. */
export function markerLetterAt(items, point) {
  const marker = items.find((item) => item.kind === 'marker');
  if (!marker || !point) return null;
  let best = null;
  let bestD = LETTER_HIT_PX;
  for (const a of marker.axes) {
    const d = Math.hypot(point.x - a.lx, point.y - a.ly);
    if (d <= bestD) {
      bestD = d;
      best = a.axis;
    }
  }
  return best;
}

function rectsOverlap(a, b) {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

/**
 * The display list of one frame.
 * @param {object} spec
 * @param {number} spec.width   viewport CSS px
 * @param {number} spec.height
 * @param {number} spec.fovDeg
 * @param {{position: number[], frame: {right: number[], up: number[], vpn: number[]}, umPerPx: number}} spec.camera
 * @param {{x: Float64Array, y: Float64Array, ok: Uint8Array}} spec.projected  sphere centers
 * @param {{positions: Float64Array, radius: Float64Array, visible: Uint8Array, alpha: Float32Array,
 *          acr: string[], hemi: string[], degree: (number|null)[], color?: number[],
 *          labelMode?: ('auto'|'always'|'hidden')[]}} spec.nodes
 *        color: the display packet's flat 8-bit fills; labelMode: each sphere's style group's
 * @param {object} spec.labels  scene.labels
 * @param {boolean} spec.labelsOn
 * @param {'auto'|'all'|'off'} [spec.labelMode]  E7's declutter mode (default auto)
 * @param {number} spec.labelOpacity  0-1, the fade while the camera moves
 * @param {number} [spec.labelMinDegree]  label only spheres of at least this total degree (default 0)
 * @param {'fit'|'fixed'} [spec.labelSize]  fit inside the sphere (default) or labelPx CSS px
 * @param {number} [spec.labelPx]
 * @param {object} spec.style  scene.style
 * @param {number} spec.hover  sphere index or -1
 * @param {number[]} spec.selected  sphere indices
 * @param {Set<number>} [spec.previous]  labels shown in the last frame
 * @param {(text: string, font: {px: number, mono: boolean, weight: number}) => number} spec.measure  text width, CSS px
 * @param {{x: string, y: string, z: string}} [spec.axes]
 * @param {boolean} [spec.marker]
 * @param {'x'|'y'|'z'|null} [spec.lockAxis]  the world axis rotation is locked to
 * @param {number} [spec.insetBottom]  CSS px of the bottom under a panel (the data table): the marker and the
 *        scale bar sit above it
 * @param {{text: string, x: number}[]} [spec.titles]  a comparison's side titles, centered at x near the top
 * @param {boolean} [spec.scaleBar]
 * @returns {{items: object[], labels: number[], candidates: number}}
 */
export function layoutOverlay(spec) {
  const { width, height, fovDeg, camera, projected, nodes, labels, style, measure } = spec;
  const items = [];
  const n = nodes.visible.length;
  const r = new Float64Array(n);
  const dist = new Float64Array(n);
  const cam = camera.position;
  for (let i = 0; i < n; i += 1) {
    if (!nodes.visible[i] || !projected.ok[i]) continue;
    const dx = nodes.positions[3 * i] - cam[0];
    const dy = nodes.positions[3 * i + 1] - cam[1];
    const dz = nodes.positions[3 * i + 2] - cam[2];
    if (camera.orthographic) {
      const vpn = camera.frame.vpn;
      dist[i] = -(dx * vpn[0] + dy * vpn[1] + dz * vpn[2]);
      r[i] = screenRadius(nodes.radius[i], camera.focalDistance, height, fovDeg);
    } else {
      dist[i] = Math.hypot(dx, dy, dz);
      r[i] = screenRadius(nodes.radius[i], dist[i], height, fovDeg);
    }
  }
  const drawn = (i) => i >= 0 && i < n && nodes.visible[i] && projected.ok[i];
  const selected = new Set((spec.selected || []).filter(drawn));
  const hover = drawn(spec.hover) ? spec.hover : -1;

  // ---- hollow spheres (D46): a region in the other dataset only, its outline alone, under the rest
  if (nodes.hollow) {
    for (let i = 0; i < n; i += 1) {
      if (!drawn(i) || !nodes.hollow[i]) continue;
      items.push({ kind: 'hollow', x: projected.x[i], y: projected.y[i], r: r[i], lineWidth: spec.hollowWidth ?? 1.1,
        alpha: Math.max(0, Math.min(1, nodes.alpha[i])) });
    }
  }

  // ---- hover glow and selection halo (under the labels)
  if (hover >= 0 && !selected.has(hover)) {
    items.push({ kind: 'glow', x: projected.x[hover], y: projected.y[hover], r: r[hover] * style.hover_glow.radius_scale,
      alpha: style.hover_glow.alpha });
  }
  for (const i of selected) {
    items.push({ kind: 'glow', x: projected.x[i], y: projected.y[i], r: r[i] * style.selection_halo.radius_scale,
      alpha: style.selection_halo.alpha });
  }

  // ---- labels
  const shown = [];
  let candidates = 0;
  const labelMode = LABEL_MODES.includes(spec.labelMode) ? spec.labelMode : 'auto';
  if (spec.labelsOn && spec.labelOpacity > 0) {
    const pri = labels.priority;
    const fixed = spec.labelSize === 'fixed' && Number(spec.labelPx) > 0;
    const minDegree = Number(spec.labelMinDegree) || 0;
    const list = [];
    for (let i = 0; i < n; i += 1) {
      if (!drawn(i) || (!fixed && r[i] < labels.min_screen_px)) continue;
      const own = nodes.labelMode?.[i];
      const always = i === hover || selected.has(i) || own === 'always';
      if (own === 'hidden' && i !== hover && !selected.has(i)) continue;
      if (labelMode === 'off' && !always) continue;
      if (minDegree > 0 && !always && !((Number(nodes.degree?.[i]) || 0) >= minDegree)) continue;
      let p = r[i] + pri.per_degree * (Number(nodes.degree?.[i]) || 0);
      if (i === hover) p += pri.hover;
      if (selected.has(i) || own === 'always') p += pri.selected;
      if (spec.previous?.has(i)) p += HYSTERESIS_PX;
      list.push([p, i]);
    }
    candidates = list.length;
    list.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    const kept = (labelMode === 'all' ? list : list.slice(0, labels.max_visible)).map(([, i]) => i);
    const placed = [];
    for (const i of kept) {
      // Covered by a nearer sphere: today's depth test hid this label.
      let covered = false;
      for (let j = 0; j < n && !covered; j += 1) {
        if (j === i || !drawn(j) || dist[j] >= dist[i]) continue;
        const ddx = projected.x[j] - projected.x[i];
        const ddy = projected.y[j] - projected.y[i];
        if (ddx * ddx + ddy * ddy < r[j] * r[j]) covered = true;
      }
      if (covered) continue;
      const text = nodes.acr[i];
      let px = fixed ? Number(spec.labelPx) : (labels.height_to_radius * r[i]) / CAP_HEIGHT_EM;
      const font = { px, mono: false, weight: LABEL_FONT_WEIGHT };
      let w = measure(text, font);
      const maxW = 2 * labels.max_width_fraction * r[i];
      if (!fixed && w > maxW && w > 0) {
        px *= maxW / w;
        w = maxW;
      }
      const cap = px * CAP_HEIGHT_EM;
      const rect = { x0: projected.x[i] - w / 2, x1: projected.x[i] + w / 2, y0: projected.y[i] - cap / 2,
        y1: projected.y[i] + cap / 2 };
      if (labelMode !== 'all' && placed.some((other) => rectsOverlap(rect, other))) continue;
      placed.push(rect);
      shown.push(i);
      const c = nodes.color;
      const dark = Boolean(c) && luminance(c[3 * i], c[3 * i + 1], c[3 * i + 2]) > LABEL_DARK_ABOVE;
      items.push({ kind: 'label', index: i, text, x: projected.x[i], y: projected.y[i] + cap / 2, px, width: w, r: r[i],
        alpha: Math.max(0, Math.min(1, nodes.alpha[i])) * spec.labelOpacity, dark, halo: fixed });
    }
  }

  // ---- selection ring and tag (kit.selection_mark)
  for (const i of selected) {
    const ringR = Math.max(RING.minRadius, r[i] * style.selection_halo.radius_scale + RING.extra);
    items.push({ kind: 'ring', x: projected.x[i], y: projected.y[i], r: ringR - RING.lineWidth / 2,
      lineWidth: RING.lineWidth });
    const text = nodes.hemi[i] === 'C' ? nodes.acr[i] : `${nodes.acr[i]} ${nodes.hemi[i]}`;
    const textW = measure(text, { px: MONO_PX, mono: true, weight: 500 });
    items.push({ kind: 'tag', text, x: projected.x[i] + ringR + TAG.gap, y: projected.y[i] - ringR - TAG.rise,
      width: textW + 2 * TAG.padX + 2 * TAG.border, height: TAG.lineHeight + 2 * TAG.padY + 2 * TAG.border });
  }

  // ---- bottom right: the orientation marker, then the scale bar at the edge (kit.viewport)
  let right = width - MARKER.inset;
  if (spec.scaleBar !== false && camera.umPerPx > 0) {
    const bar = scaleBar(camera.umPerPx);
    if (bar) {
      const textW = measure(bar.text, { px: MONO_PX, mono: true, weight: 400 });
      const boxW = Math.max(bar.px, textW);
      const bottom = height - PAD - (Number(spec.insetBottom) || 0);
      const cx = right - boxW / 2;
      const top = bottom - SCALE_BAR.labelHeight - SCALE_BAR.labelGap - SCALE_BAR.tick;
      items.push({ kind: 'scalebar', x0: cx - bar.px / 2, x1: cx + bar.px / 2, top, labelX: cx, labelY: bottom,
        text: bar.text, um: bar.um, px: bar.px });
      right -= boxW + MARKER.gap;
    }
  }
  if (spec.marker !== false) {
    const ox = right - MARKER.width + MARKER.origin[0];
    const oy = height - PAD - (Number(spec.insetBottom) || 0) - MARKER.height + MARKER.origin[1];
    const axes = markerAxes(camera.frame, spec.axes).map((a) => {
      const len = Math.hypot(a.dx, a.dy);
      const ux = len > 1e-9 ? a.dx / len : 0;
      const uy = len > 1e-9 ? a.dy / len : 0;
      const reach = len * MARKER.length;
      return { ...a, x1: ox + a.dx * MARKER.length, y1: oy + a.dy * MARKER.length,
        lx: ox + ux * (reach + MARKER.letterGap), ly: oy + uy * (reach + MARKER.letterGap),
        locked: a.axis === spec.lockAxis };
    });
    items.push({ kind: 'marker', x: ox, y: oy, axes });
  }
  // ---- top: a comparison's side titles (each centered over its side, kept inside the view)
  for (const title of spec.titles || []) {
    const w = measure(title.text, { px: TITLE_PX, mono: false, weight: 600 });
    const x = Math.max(PAD + w / 2, Math.min(width - PAD - w / 2, title.x));
    items.push({ kind: 'title', text: title.text, x, y: PAD + TITLE_PX, px: TITLE_PX });
  }
  return { items, labels: shown, candidates };
}

/**
 * Slice view's planes and slab rule in the page (core/slicing.py), for the phone page of a web scene, which has
 * no server to ask. PLANES are the anatomical planes, NORMALS their normals (toward dorsal, anterior and left)
 * and VIEWS the camera preset that looks straight at each (the app's Slice view uses them too). planes,
 * evaluate, applyToNodes and edgeFactor follow slicing.planes, evaluate, apply_to_nodes and edge_factor; label
 * and legendNote say where the slice is in the words of slicing.label and texts.legend_slice_note; offsetRange
 * keeps the plane within the brain's bounds (the position sliders, Shift+scroll).
 * test_web_share runs the same cases through both, so the two cannot drift apart.
 *
 * slice: {plane, point, offset, thickness, out, fade, floor}; positions are flat [x, y, z, ...] in world µm.
 * Plain ES module; no imports.
 */

export const PLANES = ['axial', 'coronal', 'sagittal'];
export const NORMALS = { axial: [0, 1, 0], coronal: [0, 0, 1], sagittal: [1, 0, 0] };
export const VIEWS = { axial: 'top', coronal: 'anterior', sagittal: 'left' };
const AT_UM = 5; // a plane this close to the midline or the brain's center is at it

/** µm as Python's f'{v / 1000:.2f}': an exact tie (8x odd) goes to the even hundredth; toFixed takes the larger. */
function mm(um) {
  const x = Math.abs(Number(um)) / 1000;
  if (Number.isInteger(x * 8) && (x * 8) % 2 === 1) {
    const low = Math.floor(x * 100);
    return ((low % 2 === 0 ? low : low + 1) / 100).toFixed(2);
  }
  return x.toFixed(2);
}

/** {L: {normal, point}, R: its mirror across x = midline}: each split panel's plane (L also serves a full view). */
export function planes(slice, midline) {
  const n = NORMALS[slice.plane];
  const p = slice.point.map((v, i) => Number(v) + Number(slice.offset) * n[i]);
  return { L: { normal: n, point: p }, R: { normal: [-n[0], n[1], n[2]], point: [2 * midline - p[0], p[1], p[2]] } };
}

/**
 * The slice of the spheres: {distance, inside, factor}, each sphere's signed distance from its plane, whether it
 * lies within half the thickness, and its opacity factor (0: hidden). panels: per sphere 'L', 'R' or 'C', or null.
 */
export function evaluate(slice, positions, panels, midline) {
  const pl = planes(slice, midline);
  const count = Math.floor(positions.length / 3);
  const half = Number(slice.thickness) / 2;
  const floor = Number(slice.floor);
  const fade = Math.max(Number(slice.fade), 1e-9);
  const distance = new Array(count);
  const inside = new Array(count);
  const factor = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const { normal, point } = pl[panels && panels[i] === 'R' ? 'R' : 'L'];
    let d = 0;
    for (let k = 0; k < 3; k += 1) d += (Number(positions[3 * i + k]) - point[k]) * normal[k];
    const beyond = Math.abs(d) - half;
    distance[i] = d;
    inside[i] = beyond <= 0;
    if (slice.out === 'show') factor[i] = 1;
    else if (slice.out === 'hide') factor[i] = inside[i] ? 1 : 0;
    else factor[i] = inside[i] ? 1 : Math.max(floor, 1 - beyond / fade);
  }
  return { distance, inside, factor };
}

/** The offsets that keep the plane through `point` within the world's bounds ([xmin, xmax, ymin, ...]), whole µm. */
export function offsetRange(plane, point, bounds) {
  const axis = NORMALS[plane].indexOf(1);
  return [Math.ceil(Number(bounds[2 * axis]) - Number(point[axis])),
    Math.floor(Number(bounds[2 * axis + 1]) - Number(point[axis]))];
}

/** Hide or dim the spheres outside the slice (the arrays changed in place). */
export function applyToNodes(sl, visible, alpha) {
  if (!sl) return;
  sl.factor.forEach((f, i) => {
    if (!visible[i]) return;
    if (f <= 0) {
      visible[i] = false;
      alpha[i] = 0;
    } else alpha[i] = Math.min(alpha[i], f);
  });
}

/** An edge's opacity factor: the fainter of its two ends (1 without a slice). */
export function edgeFactor(sl, s, t) {
  return sl ? Math.min(sl.factor[s], sl.factor[t]) : 1;
}

/** Where the slice is, in words: 'Sagittal, 1.20 mm left of the midline', 'Axial, at the brain's center'. */
export function label(slice, midline, center) {
  const p = planes(slice, midline).L.point;
  if (slice.plane === 'sagittal') {
    const off = p[0] - midline;
    return Math.abs(off) < AT_UM ? 'Sagittal, at the midline'
      : `Sagittal, ${mm(off)} mm ${off > 0 ? 'left' : 'right'} of the midline`;
  }
  const [axis, more, less] = slice.plane === 'coronal' ? [2, 'anterior', 'posterior'] : [1, 'dorsal', 'ventral'];
  const off = p[axis] - Number(center[axis]);
  const name = slice.plane[0].toUpperCase() + slice.plane.slice(1);
  return Math.abs(off) < AT_UM ? `${name}, at the brain's center`
    : `${name}, ${mm(off)} mm ${off > 0 ? more : less} of the brain's center`;
}

/** The legend's line of Slice view (texts.legend_slice_note, one view): outside is LEGEND_SLICE_OUTSIDE's words. */
export function legendNote(where, thickness, outside) {
  return `Slice: ${where}, ${mm(thickness)} mm thick; ${outside}`;
}

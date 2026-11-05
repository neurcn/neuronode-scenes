/**
 * The brain shell (plan 3.8 viewer3d/layers/shell.js): the atlas 'root' surface,
 * styled live from the display packet's shell block (core/scene.py shell_block).
 * - Styles: glass (unlit fill at the packet's alpha, as VTK drew it), outline
 *   (the contour alone), frosted (the fill lit by the headlight), x-ray (the
 *   fill's opacity rises toward the contour by the rim strength). Colors are
 *   the packet's, else the background theme's (palette.THEMES).
 * - Front surface only (the default; packet.inner_surfaces false): a depth
 *   pass of the shell alone (renderFrontDepth, before each frame or export
 *   tile) keeps only the nearest layer of the fill and the contours that lie
 *   on it, so folds behind the front surface draw neither lighter sheets nor
 *   dark lines through the see-through fill. With inner surfaces on, every
 *   layer and contour draws, as before.
 * - Half: packet.half L or R keeps the side of the midline (world x >=
 *   midline_x is the left half, as layers/regions.js tests it); the cut is
 *   outlined by the shell's cross-section at the midline, found from its
 *   triangles when the layer is made.
 * - Silhouette: drawn on the GPU from the geometry's shell edge list, each
 *   edge with the outward normals of its two faces. An edge is drawn when one
 *   face looks toward the camera and the other away (along the view direction
 *   in an orthographic view), or when it has one face (a border edge). Lines
 *   of packet.silhouette_width_px app px at packet.silhouette_alpha, pulled
 *   slightly toward the camera as VTK's polygon offset does for lines on a
 *   surface.
 * - Contours "outer" (packet.contours): the outer outline only, found on
 *   screen from the front surface's depth pass (a pixel of the shell next to
 *   one without, within half the outline's width), so no inner fold or crease
 *   draws; it replaces the silhouette and the midline cut, and the spheres and
 *   edges draw over it.
 * - Slice view (setSlice): the fill, contours and midline cut give way to the
 *   plane's cut through the surface, one continuous outline in the
 *   silhouette's style, and, when asked, each listed region's cut in its own
 *   color (thinner); a split panel keeps its half.
 * Translucent fill: transparency.js depth-peels it in Meshes mode and blends it
 * after the lines in Nodes mode.
 *
 * Plain ES module: imports three only.
 */

import * as THREE from 'three';
import { createSegmentGeometry, SEGMENT_EXPAND_GLSL } from '../edge_material.js';
import { PEEL_PARS_FRAGMENT, PEEL_TEST_FRAGMENT, TRANSLUCENT_LAYER, translucentMaterials } from '../transparency.js';

export const SILHOUETTE_DEPTH_BIAS = 1e-4; // NDC depth units toward the camera (about 1 µm at the default view)
export const FRONT_DEPTH_SLACK = 2e-5;     // window depth a fragment may lie behind the front surface and still draw
export const SHELL_STYLES = { glass: 0, outline: 0, frosted: 1, xray: 2 };
const SIDE = { B: 0, L: 1, R: -1 };
const REGION_CUT_WIDTH = 0.5; // a region's cut in Slice view, as a share of the outline's width

// The outer outline: a pixel draws when the shell covers it and a point within half the width does not, or the
// other way round (16 directions); the share of such points softens the line's edges.
const OUTER_FRAG = /* glsl */ `
uniform sampler2D uFrontDepth;
uniform vec2 uFrontRes;
uniform float uWidthPx;
uniform vec3 uColor;
uniform float uAlpha;
void main() {
  vec2 uv = gl_FragCoord.xy / uFrontRes;
  bool inside = texture2D(uFrontDepth, uv).r < 1.0;
  float reach = max(0.5 * uWidthPx, 0.75);
  float other = 0.0;
  for (int i = 0; i < 16; i++) {
    float a = float(i) * 0.39269908;
    vec2 at = uv + vec2(cos(a), sin(a)) * reach / uFrontRes;
    if ((texture2D(uFrontDepth, at).r < 1.0) != inside) other += 1.0;
  }
  if (other < 0.5) discard;
  gl_FragColor = vec4(uColor, uAlpha * min(1.0, other / 4.0));
}
`;

// The side test and the front-surface test every shell shader shares.
const HALF_PARS = /* glsl */ `
uniform float uMidline;
uniform float uSide;          // 0 both halves, 1 the left (x >= midline), -1 the right
uniform sampler2D uFrontDepth;
uniform vec2 uFrontRes;
uniform float uFrontOnly;
bool outsideHalf(float x) {
  return (uSide > 0.5 && x < uMidline) || (uSide < -0.5 && x > uMidline);
}
bool behindFront(float slack) {
  if (uFrontOnly < 0.5) return false;
  return gl_FragCoord.z > texture2D(uFrontDepth, gl_FragCoord.xy / uFrontRes).r + slack;
}`;

// SHADED (the frosted and x-ray styles) adds the normal and the view vector; glass and outline go without them,
// as they cost about 0.6 ms a frame in the eight peel passes of Meshes mode.
const FILL_VERT = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
varying float vWorldX;
#ifdef SHADED
varying vec3 vNormalV;
varying vec3 vViewPos;
#endif
void main() {
  vWorldX = (modelMatrix * vec4(position, 1.0)).x;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  #ifdef SHADED
  vNormalV = normalize(normalMatrix * normal);
  vViewPos = mvPosition.xyz;
  #endif
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}
`;

const FILL_FRAG = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>
uniform vec3 uColor;
uniform float uAlpha;
uniform float uStyle;   // 0 unlit, 1 lit by the headlight, 2 rim
uniform float uRim;
varying float vWorldX;
#ifdef SHADED
varying vec3 vNormalV;
varying vec3 vViewPos;
#endif
${HALF_PARS}
${PEEL_PARS_FRAGMENT}
void main() {
  #include <clipping_planes_fragment>
  if (outsideHalf(vWorldX) || behindFront(${FRONT_DEPTH_SLACK.toExponential()})) discard;
  ${PEEL_TEST_FRAGMENT}
  vec3 color = uColor;
  float alpha = uAlpha;
  #ifdef SHADED
  vec3 view = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(-vViewPos);
  float ndv = abs(dot(normalize(vNormalV), view));
  if (uStyle < 1.5) {
    color = uColor * (0.25 + 0.75 * ndv);
  } else {
    alpha = clamp(uAlpha + uRim * pow(1.0 - ndv, 2.0), 0.0, 1.0);
  }
  #endif
  #ifdef PEEL
    gl_FragColor = vec4(color * alpha, alpha);
  #else
    gl_FragColor = vec4(color, alpha);
  #endif
}
`;

const DEPTH_FRAG = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>
uniform float uMidline;
uniform float uSide;
varying float vWorldX;
void main() {
  #include <clipping_planes_fragment>
  if ((uSide > 0.5 && vWorldX < uMidline) || (uSide < -0.5 && vWorldX > uMidline)) discard;
  gl_FragColor = vec4(1.0);
}
`;

const SILHOUETTE_VERT = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
uniform float uWidthPx;
uniform float uDepthBias;
uniform float uMidline;
uniform float uSide;
uniform float uAlways;  // 1: every segment draws (the midline cut), 0: the facing test decides
attribute vec3 aStart;
attribute vec3 aEnd;
attribute vec3 aN0;
attribute vec3 aN1;
${SEGMENT_EXPAND_GLSL}
void main() {
  vec3 worldStart = (modelMatrix * vec4(aStart, 1.0)).xyz;
  vec3 worldEnd = (modelMatrix * vec4(aEnd, 1.0)).xyz;
  // Toward the camera: from the edge to the eye, or the view direction's reverse (the view matrix's third row)
  // in an orthographic view.
  vec3 toCamera = isOrthographic ? vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2])
    : cameraPosition - 0.5 * (worldStart + worldEnd);
  bool front0 = dot(aN0, toCamera) > 0.0;
  bool front1 = dot(aN1, toCamera) > 0.0;
  float midX = 0.5 * (worldStart.x + worldEnd.x);
  bool outside = (uSide > 0.5 && midX < uMidline) || (uSide < -0.5 && midX > uMidline);
  vec4 start = viewMatrix * vec4(worldStart, 1.0);
  vec4 end = viewMatrix * vec4(worldEnd, 1.0);
  vec4 mvPosition = (position.y < 0.5) ? start : end;
  if (outside || (uAlways < 0.5 && front0 == front1)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // not drawn: outside the clip volume
  } else {
    vec4 clip = expandSegment(start, end, uWidthPx, false);
    clip.z -= uDepthBias * clip.w;
    gl_Position = clip;
  }
  #include <clipping_planes_vertex>
}
`;

// A contour on the front surface has the surface's far side next to it (beyond the outline, or past a fold), so
// it is tested against the farthest front depth a line's width around it; one behind the surface is behind all.
const SILHOUETTE_FRAG = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>
uniform vec3 uColor;
uniform float uAlpha;
uniform float uWidthPx;
uniform sampler2D uFrontDepth;
uniform vec2 uFrontRes;
uniform float uFrontOnly;
float frontAt(vec2 p) {
  return texture2D(uFrontDepth, p / uFrontRes).r;
}
void main() {
  #include <clipping_planes_fragment>
  if (uFrontOnly > 0.5) {
    vec2 p = gl_FragCoord.xy;
    float r = 0.5 * uWidthPx + 1.5;
    float far = max(max(frontAt(p), frontAt(p + vec2(r, 0.0))), max(frontAt(p - vec2(r, 0.0)),
      max(frontAt(p + vec2(0.0, r)), frontAt(p - vec2(0.0, r)))));
    if (gl_FragCoord.z > far + ${FRONT_DEPTH_SLACK.toExponential()}) discard;
  }
  gl_FragColor = vec4(uColor, uAlpha);
}
`;

/**
 * Where triangles start..start+count cross the plane {p : normal . p = offset}: segment ends (two per segment,
 * xyz). Exported for tests.
 */
export function planeSegments(positions, indices, start, count, normal, offset) {
  const [nx, ny, nz] = normal;
  const out = [];
  const d = [0, 0, 0];
  const v = [0, 0, 0];
  for (let t = start; t < start + count; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const i = 3 * indices[3 * t + k];
      v[k] = i;
      d[k] = nx * positions[i] + ny * positions[i + 1] + nz * positions[i + 2] - offset;
    }
    let found = 0;
    for (let e = 0; e < 3 && found < 2; e += 1) {
      const da = d[e];
      const db = d[(e + 1) % 3];
      if ((da < 0 && db >= 0) || (da >= 0 && db < 0)) {
        const a = v[e];
        const b = v[(e + 1) % 3];
        const s = da / (da - db);
        out.push(positions[a] + (positions[b] - positions[a]) * s, positions[a + 1] + (positions[b + 1] - positions[a + 1]) * s,
          positions[a + 2] + (positions[b + 2] - positions[a + 2]) * s);
        found += 1;
      }
    }
    if (found === 1) out.length -= 3; // a vertex on the plane: no segment
  }
  return new Float32Array(out);
}

/** The shell's cross-section at x = midline (planeSegments). Exported for tests. */
export function midlineSegments(positions, indices, start, count, midline) {
  return planeSegments(positions, indices, start, count, [1, 0, 0], midline);
}

/** Segment ends from planeSegments' flat list: [starts, ends], three floats per segment each. */
function splitEnds(cut) {
  const count = cut.length / 6;
  const a = new Float32Array(3 * count);
  const b = new Float32Array(3 * count);
  for (let s = 0; s < count; s += 1) {
    a.set(cut.subarray(6 * s, 6 * s + 3), 3 * s);
    b.set(cut.subarray(6 * s + 3, 6 * s + 6), 3 * s);
  }
  return [a, b];
}

function segmentMesh(startArray, endArray, n0, n1, uniforms, name) {
  const geometry = createSegmentGeometry({ caps: false });
  geometry.setAttribute('aStart', new THREE.InstancedBufferAttribute(startArray, 3));
  geometry.setAttribute('aEnd', new THREE.InstancedBufferAttribute(endArray, 3));
  geometry.setAttribute('aN0', new THREE.InstancedBufferAttribute(n0, 3));
  geometry.setAttribute('aN1', new THREE.InstancedBufferAttribute(n1, 3));
  geometry.instanceCount = startArray.length / 3;
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader: SILHOUETTE_VERT, fragmentShader: SILHOUETTE_FRAG,
    transparent: false, depthTest: true, depthWrite: true, clipping: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = 0;
  return mesh;
}

/**
 * @param {object} geometry  loader.js parseGeometry() result
 * @param {{color: string, alpha: number, silhouette: {color: string, width_px: number, alpha: number}}} style
 *        scene.style.shell
 * @param {object} peelUniforms  transparency's shared peel uniforms
 * @param {number} midlineX  scene.world.midline_x
 */
export function createShellLayer(geometry, style, peelUniforms, midlineX = 0) {
  const group = new THREE.Group();
  group.name = 'shell';
  const front = { target: null, width: 0, height: 0, on: false };
  const shared = {
    uMidline: { value: Number(midlineX) },
    uSide: { value: 0 },
    uFrontDepth: { value: null },
    uFrontRes: { value: new THREE.Vector2(1, 1) },
    uFrontOnly: { value: 0 },
  };

  // ---- fill
  const fillGeometry = new THREE.BufferGeometry();
  fillGeometry.setAttribute('position', geometry.positionAttribute);
  if (geometry.normalAttribute) fillGeometry.setAttribute('normal', geometry.normalAttribute);
  const start = 3 * geometry.shellTriangleStart;
  fillGeometry.setIndex(new THREE.BufferAttribute(geometry.indices.subarray(start, start + 3 * geometry.shellTriangles), 1));
  fillGeometry.boundingSphere = geometry.boundingSphere;
  const fillUniforms = {
    ...shared,
    uColor: { value: new THREE.Color(style.color) },
    uAlpha: { value: style.alpha },
    uStyle: { value: 0 },
    uRim: { value: 0 },
  };
  const fillMaterials = translucentMaterials(peelUniforms, {
    vertexShader: FILL_VERT, fragmentShader: FILL_FRAG, uniforms: fillUniforms,
  });
  const fill = new THREE.Mesh(fillGeometry, fillMaterials.blend);
  fill.name = 'shell-fill';
  fill.userData.materials = fillMaterials;
  fill.layers.set(TRANSLUCENT_LAYER);
  fill.renderOrder = 5;
  fill.frustumCulled = false;
  group.add(fill);

  // ---- the front surface's depth (a scene of its own: the fill alone, depth only)
  const depthMaterial = new THREE.ShaderMaterial({
    uniforms: { uMidline: shared.uMidline, uSide: shared.uSide },
    vertexShader: FILL_VERT, fragmentShader: DEPTH_FRAG, side: THREE.DoubleSide, colorWrite: false,
    depthWrite: true, depthTest: true, clipping: true,
  });
  const depthScene = new THREE.Scene();
  const depthMesh = new THREE.Mesh(fillGeometry, depthMaterial);
  depthMesh.frustumCulled = false;
  depthScene.add(depthMesh);

  // ---- silhouette
  const edges = geometry.shellEdges;
  const normals = geometry.shellEdgeNormals;
  const count = edges.length / 2;
  const startArray = new Float32Array(3 * count);
  const endArray = new Float32Array(3 * count);
  const n0 = new Float32Array(3 * count);
  const n1 = new Float32Array(3 * count);
  const pos = geometry.positions;
  for (let e = 0; e < count; e += 1) {
    const a = edges[2 * e];
    const b = edges[2 * e + 1];
    for (let j = 0; j < 3; j += 1) {
      startArray[3 * e + j] = pos[3 * a + j];
      endArray[3 * e + j] = pos[3 * b + j];
      n0[3 * e + j] = normals[6 * e + j];
      n1[3 * e + j] = normals[6 * e + 3 + j];
    }
  }
  const lineUniforms = {
    ...shared,
    uResolution: { value: new THREE.Vector2(1, 1) },
    uWidthPx: { value: 1 },
    uDepthBias: { value: SILHOUETTE_DEPTH_BIAS },
    uColor: { value: new THREE.Color(style.silhouette.color) },
    uAlpha: { value: style.silhouette.alpha },
    uAlways: { value: 0 },
  };
  const silhouette = segmentMesh(startArray, endArray, n0, n1, lineUniforms, 'shell-silhouette');
  group.add(silhouette);

  // ---- the midline cut's outline, shown with a half
  const cut = midlineSegments(pos, geometry.indices, geometry.shellTriangleStart, geometry.shellTriangles, midlineX);
  const cutCount = cut.length / 6;
  const [cutStart, cutEnd] = splitEnds(cut);
  // A cut segment lies on the midline itself, so it skips the side test (uSide 0) and the facing test (uAlways).
  const cutUniforms = { ...lineUniforms, uAlways: { value: 1 }, uSide: { value: 0 } };
  const cutLine = segmentMesh(cutStart, cutEnd, new Float32Array(3 * cutCount), new Float32Array(3 * cutCount),
    cutUniforms, 'shell-midline');
  cutLine.visible = false;
  group.add(cutLine);

  let widthAppPx = Number(style.silhouette.width_px);
  let pxPerApp = 1;
  const lineMaterials = [silhouette.material, cutLine.material];

  // ---- the outer outline only (contours "outer"): a screen pass over the front surface's depth
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: { uFrontDepth: shared.uFrontDepth, uFrontRes: shared.uFrontRes, uWidthPx: lineUniforms.uWidthPx,
      uColor: lineUniforms.uColor, uAlpha: lineUniforms.uAlpha },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: OUTER_FRAG,
    depthTest: false,
    depthWrite: false,
    // Drawn with the opaque objects (before the spheres, which cover it), yet blended so its edges stay soft.
    transparent: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  }));
  outer.name = 'shell-outer';
  outer.frustumCulled = false;
  outer.renderOrder = -10; // before the spheres and edges, which draw over it
  outer.visible = false;
  group.add(outer);
  let contours = 'all';

  // ---- Slice view: the plane's cut through the surface and, when asked, through the listed regions
  let slice = null; // {normal, point} while Slice view is on
  let sliceKey = '';
  let sliceMeshes = [];
  let packetShown = false;
  // Slice lines lie on the plane: no facing test, no front-surface test; the panel's half still applies.
  const sliceUniforms = { ...lineUniforms, uAlways: { value: 1 }, uFrontOnly: { value: 0 } };
  const regionWidth = { value: 1 };

  function sliceMesh(cutSegments, uniforms, name) {
    const [a, b] = splitEnds(cutSegments);
    const zeros = new Float32Array(a.length);
    const mesh = segmentMesh(a, b, zeros, zeros, uniforms, name);
    mesh.visible = a.length > 0;
    group.add(mesh);
    sliceMeshes.push(mesh);
    return mesh;
  }

  function clearSlice() {
    for (const mesh of sliceMeshes) {
      group.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    sliceMeshes = [];
  }

  /**
   * Slice view on ({normal, point}) or off (null). regions: [{color: '#RRGGBB', first, count}] triangle ranges
   * of the geometry whose cuts are drawn too, in their colors (an empty list: the surface's outline alone).
   */
  function setSlice(plane, regions = []) {
    const key = plane ? JSON.stringify([plane.normal, plane.point, regions.map((r) => [r.color, r.first])]) : '';
    if (key === sliceKey) return;
    sliceKey = key;
    clearSlice();
    slice = plane;
    if (plane) {
      const n = plane.normal;
      const offset = n[0] * plane.point[0] + n[1] * plane.point[1] + n[2] * plane.point[2];
      const byColor = new Map();
      for (const r of regions) {
        const cutSegments = planeSegments(pos, geometry.indices, r.first, r.count, n, offset);
        if (cutSegments.length) byColor.set(r.color, [...(byColor.get(r.color) || []), cutSegments]);
      }
      for (const [color, parts] of byColor) {
        const all = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
        let at = 0;
        for (const part of parts) {
          all.set(part, at);
          at += part.length;
        }
        sliceMesh(all, { ...sliceUniforms, uColor: { value: new THREE.Color(color) }, uAlpha: { value: 1 },
          uWidthPx: regionWidth }, 'slice-region');
      }
      const outline = planeSegments(pos, geometry.indices, geometry.shellTriangleStart, geometry.shellTriangles, n,
        offset);
      sliceMesh(outline, sliceUniforms, 'slice-outline').renderOrder = 1;
    }
    syncSlice();
  }

  function syncSlice() {
    regionWidth.value = REGION_CUT_WIDTH * widthAppPx * pxPerApp;
    const outline = sliceMeshes[sliceMeshes.length - 1];
    if (outline) outline.visible = packetShown && lineUniforms.uAlpha.value > 0;
    for (const mesh of sliceMeshes) {
      const translucent = mesh === outline && lineUniforms.uAlpha.value < 0.999;
      if (mesh.material.transparent !== translucent) {
        mesh.material.transparent = translucent;
        mesh.material.needsUpdate = true;
      }
    }
    if (slice) {
      fill.visible = false;
      silhouette.visible = false;
      cutLine.visible = false;
      outer.visible = false;
      front.on = false;
    }
  }

  /**
   * Apply a display packet's shell (scene.shell_block) on a background theme's colors ({shell, silhouette};
   * the packet's own colors win when set).
   */
  function apply(packet, theme = null) {
    const alpha = Number(packet.alpha) || 0;
    const lineAlpha = Number(packet.silhouette_alpha) || 0;
    fillUniforms.uColor.value.set(packet.color ?? theme?.shell ?? style.color);
    fillUniforms.uAlpha.value = alpha;
    fillUniforms.uStyle.value = SHELL_STYLES[packet.style] ?? 0;
    const shaded = fillUniforms.uStyle.value > 0;
    for (const material of [fillMaterials.blend, fillMaterials.peel]) {
      if (Boolean(material.defines.SHADED) === shaded) continue;
      if (shaded) material.defines.SHADED = 1;
      else delete material.defines.SHADED;
      material.needsUpdate = true;
    }
    fillUniforms.uRim.value = Number(packet.rim) || 0;
    lineUniforms.uColor.value.set(packet.silhouette_color ?? theme?.silhouette ?? style.silhouette.color);
    lineUniforms.uAlpha.value = lineAlpha;
    if (packet.silhouette_width_px !== undefined) widthAppPx = Number(packet.silhouette_width_px);
    lineUniforms.uWidthPx.value = widthAppPx * pxPerApp;
    shared.uSide.value = SIDE[packet.half] ?? 0;
    contours = packet.contours === 'outer' ? 'outer' : 'all';
    front.on = Boolean(packet.visible) && (!packet.inner_surfaces || contours === 'outer');
    shared.uFrontOnly.value = front.on ? 1 : 0;
    fill.visible = Boolean(packet.visible) && alpha > 0;
    silhouette.visible = Boolean(packet.visible) && lineAlpha > 0 && widthAppPx > 0;
    cutLine.visible = silhouette.visible && shared.uSide.value !== 0;
    outer.visible = contours === 'outer' && silhouette.visible;
    if (outer.visible) {
      silhouette.visible = false;
      cutLine.visible = false; // the outline of a half already runs along its cut
    }
    packetShown = Boolean(packet.visible);
    syncSlice();
    const translucent = lineAlpha < 0.999;
    for (const material of lineMaterials) {
      if (material.transparent !== translucent) {
        material.transparent = translucent;
        material.needsUpdate = true;
      }
    }
  }

  return {
    object: group,
    fill,
    silhouette,
    cutLine,
    edgeCount: count,
    cutCount,
    apply,
    setSlice,
    /** Segments drawn by Slice view now: {outline, regions} (tests). */
    sliceCounts() {
      const outline = sliceMeshes[sliceMeshes.length - 1];
      return { outline: outline ? outline.geometry.instanceCount : 0,
        regions: sliceMeshes.slice(0, -1).reduce((sum, m) => sum + m.geometry.instanceCount, 0) };
    },
    get visible() {
      return fill.visible || silhouette.visible;
    },
    /** Size the lines for a drawing buffer of width x height device px. */
    setResolution(widthPx, heightPx, pxPerAppPx) {
      pxPerApp = pxPerAppPx;
      lineUniforms.uResolution.value.set(widthPx, heightPx);
      lineUniforms.uWidthPx.value = widthAppPx * pxPerAppPx;
      regionWidth.value = REGION_CUT_WIDTH * widthAppPx * pxPerAppPx;
    },
    /**
     * Before a frame (or an export tile): draw the shell alone, depth only, into a texture of the drawing
     * buffer's size, which the fill and the lines test against (front surface only). Nothing when off.
     */
    renderFrontDepth(three, camera) {
      if (!front.on) return;
      const size = three.getDrawingBufferSize(new THREE.Vector2());
      const w = Math.max(1, size.x);
      const h = Math.max(1, size.y);
      if (!front.target || front.width !== w || front.height !== h) {
        front.target?.dispose();
        front.target = new THREE.WebGLRenderTarget(w, h, {
          minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, stencilBuffer: false,
        });
        front.target.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
        front.width = w;
        front.height = h;
      }
      const previous = three.getRenderTarget();
      const autoClear = three.autoClear;
      const mask = camera.layers.mask;
      camera.layers.set(0);
      three.autoClear = true;
      three.setRenderTarget(front.target);
      three.clear(false, true, false);
      three.render(depthScene, camera);
      three.setRenderTarget(previous);
      three.autoClear = autoClear;
      camera.layers.mask = mask;
      shared.uFrontDepth.value = front.target.depthTexture;
      shared.uFrontRes.value.set(w, h);
    },
    dispose() {
      fillGeometry.dispose();
      fillMaterials.blend.dispose();
      fillMaterials.peel.dispose();
      depthMaterial.dispose();
      silhouette.geometry.dispose();
      cutLine.geometry.dispose();
      outer.geometry.dispose();
      outer.material.dispose();
      clearSlice();
      for (const material of lineMaterials) material.dispose();
      front.target?.dispose();
    },
  };
}

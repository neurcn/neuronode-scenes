/**
 * Region outlines in Meshes mode (D31, P8): each shown region's silhouette,
 * drawn on the GPU with the shell's technique (layers/shell.js) from the
 * geometry's per-region edge lists (core/geometry.py GEOMETRY_VERSION 2). An
 * edge is drawn when one of its faces looks toward the camera and the other
 * away, or when it has one face. The style is the one today's code sets but
 * never draws (brain_data.py: black, 2.2 px, alpha 0.9): scene
 * style.region_outline, the color from palette.SILHOUETTE.
 *
 * The outlines read the regions layer's own texture (layers/regions.js), so
 * they follow exactly what that layer draws: a region's outline shows only
 * when the region is drawn, only on the drawn side of the midline in the
 * hemisphere modes, and at FOCUS_DIM_FACTOR of its alpha while the region is
 * dimmed by a selection (Q23).
 *
 * A comparison (D46) also draws the halves the regions layer marks hollow
 * (regions.HOLLOW_BYTE): a region its side's dataset lacks, its outline alone,
 * in the one-dataset color and opacity (display.one_dataset), whether or not
 * the Outlines switch is on.
 *
 * countSegments() repeats the GPU's test on the CPU for __nn.debug.counts().
 *
 * Plain ES module: imports three only.
 */

import * as THREE from 'three';
import { createSegmentGeometry, SEGMENT_EXPAND_GLSL } from '../edge_material.js';
import { FOCUS_DIM_FACTOR } from './regions.js';
import { SILHOUETTE_DEPTH_BIAS } from './shell.js';

const OUTLINE_VERT = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
uniform float uWidthPx;
uniform float uDepthBias;
uniform sampler2D uRegionTex;
uniform int uRegionCount;
uniform int uTexWidth;
attribute vec3 aStart;
attribute vec3 aEnd;
attribute vec3 aN0;
attribute vec3 aN1;
attribute float aRegion;
varying vec4 vB;
varying vec4 vL;
varying vec4 vR;
varying float vWorldX;
${SEGMENT_EXPAND_GLSL}
vec4 regionTexel(int t) { return texelFetch(uRegionTex, ivec2(t % uTexWidth, t / uTexWidth), 0); }
void main() {
  int id = int(aRegion + 0.5);
  vB = regionTexel(id);
  vL = regionTexel(uRegionCount + id);
  vR = regionTexel(2 * uRegionCount + id);
  vec3 worldStart = (modelMatrix * vec4(aStart, 1.0)).xyz;
  vec3 worldEnd = (modelMatrix * vec4(aEnd, 1.0)).xyz;
  vWorldX = (position.y < 0.5) ? worldStart.x : worldEnd.x;
  vec3 toCamera = isOrthographic ? vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2])
    : cameraPosition - 0.5 * (worldStart + worldEnd);
  bool front0 = dot(aN0, toCamera) > 0.0;
  bool front1 = dot(aN1, toCamera) > 0.0;
  vec4 start = viewMatrix * vec4(worldStart, 1.0);
  vec4 end = viewMatrix * vec4(worldEnd, 1.0);
  vec4 mvPosition = (position.y < 0.5) ? start : end;
  bool shown = vB.a > 0.05 || vL.a > 0.05 || vR.a > 0.05;   // drawn, or hollow (D46)
  if (front0 == front1 || !shown) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // not drawn: outside the clip volume
  } else {
    vec4 clip = expandSegment(start, end, uWidthPx, false);
    clip.z -= uDepthBias * clip.w;
    gl_Position = clip;
  }
  #include <clipping_planes_vertex>
}
`;

const OUTLINE_FRAG = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>
uniform vec3 uColor;
uniform float uAlpha;
uniform float uMidline;
uniform float uPanel;
uniform float uOutlinesOn;
uniform vec3 uHollowColor;
uniform float uHollowAlpha;
varying vec4 vB;
varying vec4 vL;
varying vec4 vR;
varying float vWorldX;
void main() {
  #include <clipping_planes_fragment>
  if ((uPanel > 0.5 && vWorldX < uMidline) || (uPanel < -0.5 && vWorldX > uMidline)) discard;   // split view
  vec4 c = vB.a > 0.5 ? vB : (vWorldX >= uMidline ? vL : vR);
  if (c.a < 0.05) discard;
  if (c.a < 0.5) {   // hollow (D46)
    if (uHollowAlpha <= 0.0) discard;
    gl_FragColor = vec4(uHollowColor, uHollowAlpha);
    return;
  }
  if (uOutlinesOn < 0.5) discard;
  float alpha = c.a > 0.99 ? uAlpha : uAlpha * ${FOCUS_DIM_FACTOR.toFixed(2)};
  gl_FragColor = vec4(uColor, alpha);
}
`;

/**
 * @param {object} geometry  loader.js parseGeometry() result
 * @param {object} regionsLayer  layers/regions.js createRegionsLayer() result (its texture is shared)
 * @param {{color: string, width_px: number, alpha: number}} style  scene.style.region_outline
 * @param {number} midlineX  scene.world.midline_x
 */
export function createOutlinesLayer(geometry, regionsLayer, style, midlineX) {
  const edges = geometry.regionEdges;
  const normals = geometry.regionEdgeNormals;
  const count = edges.length / 2;
  const pos = geometry.positions;
  const startArray = new Float32Array(3 * count);
  const endArray = new Float32Array(3 * count);
  const n0 = new Float32Array(3 * count);
  const n1 = new Float32Array(3 * count);
  const regionOf = new Float32Array(count);
  for (let e = 0; e < count; e += 1) {
    const a = edges[2 * e];
    const b = edges[2 * e + 1];
    for (let j = 0; j < 3; j += 1) {
      startArray[3 * e + j] = pos[3 * a + j];
      endArray[3 * e + j] = pos[3 * b + j];
      n0[3 * e + j] = normals[6 * e + j];
      n1[3 * e + j] = normals[6 * e + 3 + j];
    }
    regionOf[e] = geometry.regionIds[a];
  }
  const lineGeometry = createSegmentGeometry({ caps: false });
  lineGeometry.setAttribute('aStart', new THREE.InstancedBufferAttribute(startArray, 3));
  lineGeometry.setAttribute('aEnd', new THREE.InstancedBufferAttribute(endArray, 3));
  lineGeometry.setAttribute('aN0', new THREE.InstancedBufferAttribute(n0, 3));
  lineGeometry.setAttribute('aN1', new THREE.InstancedBufferAttribute(n1, 3));
  lineGeometry.setAttribute('aRegion', new THREE.InstancedBufferAttribute(regionOf, 1));
  lineGeometry.instanceCount = count;
  const alpha = Number(style.alpha);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uResolution: { value: new THREE.Vector2(1, 1) },
      uWidthPx: { value: 1 },
      uDepthBias: { value: SILHOUETTE_DEPTH_BIAS },
      uColor: { value: new THREE.Color(style.color) },
      uAlpha: { value: alpha },
      uMidline: { value: midlineX },
      uPanel: { value: 0 },
      uRegionTex: { value: regionsLayer.texture },
      uRegionCount: { value: regionsLayer.textureCount },
      uTexWidth: { value: regionsLayer.textureWidth },
      uOutlinesOn: { value: 0 },
      uHollowColor: { value: new THREE.Color(style.color) },
      uHollowAlpha: { value: 0 },
    },
    vertexShader: OUTLINE_VERT,
    fragmentShader: OUTLINE_FRAG,
    transparent: alpha < 0.999,
    depthTest: true,
    depthWrite: true,
    clipping: true,
  });
  const mesh = new THREE.Mesh(lineGeometry, material);
  mesh.name = 'region-outlines';
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  mesh.visible = false;

  const widthAppPx = Number(style.width_px);
  let on = false;

  function showWhat() {
    const hollow = regionsLayer.hollowShown > 0 && material.uniforms.uHollowAlpha.value > 0;
    mesh.visible = (on && regionsLayer.visible) || hollow;
  }

  /**
   * Apply a display packet's outlines {visible, alpha}; what is drawn follows the regions layer. hollow: a
   * comparison's display.one_dataset {color, opacity} for its hollow halves (D46), or null.
   */
  function apply(packet, hollow = null) {
    on = Boolean(packet?.visible);
    material.uniforms.uOutlinesOn.value = on ? 1 : 0;
    material.uniforms.uHollowAlpha.value = hollow?.shown === false ? 0 : Number(hollow?.opacity ?? 0);
    if (hollow?.color) material.uniforms.uHollowColor.value.set(hollow.color);
    showWhat();
  }

  /**
   * The GPU's test on the CPU: {segments, regions: Map(geometry id -> segments), dimmed: Set(geometry id)} for a
   * camera at `eye` (world), or looking along -toward (an orthographic view: toward is the unit vector to the
   * camera); dimmed holds the regions drawn at FOCUS_DIM_FACTOR (Q23). Zero while not drawn.
   */
  function countSegments(eye, toward = null) {
    const perRegion = new Map();
    const dimmed = new Set();
    let segments = 0;
    if (!mesh.visible || !on) return { segments, regions: perRegion, dimmed };
    for (let e = 0; e < count; e += 1) {
      const id = regionOf[e];
      const side = regionsLayer.sides(id);
      if (!side) continue;
      const mx = 0.5 * (startArray[3 * e] + endArray[3 * e]);
      const my = 0.5 * (startArray[3 * e + 1] + endArray[3 * e + 1]);
      const mz = 0.5 * (startArray[3 * e + 2] + endArray[3 * e + 2]);
      const tx = toward ? toward[0] : eye.x - mx;
      const ty = toward ? toward[1] : eye.y - my;
      const tz = toward ? toward[2] : eye.z - mz;
      const f0 = n0[3 * e] * tx + n0[3 * e + 1] * ty + n0[3 * e + 2] * tz > 0;
      const f1 = n1[3 * e] * tx + n1[3 * e + 1] * ty + n1[3 * e + 2] * tz > 0;
      if (f0 === f1) continue;
      const drawn = side.B || (mx >= midlineX ? side.L : side.R)
        || (startArray[3 * e] >= midlineX ? side.L : side.R) || (endArray[3 * e] >= midlineX ? side.L : side.R);
      if (!drawn) continue;
      segments += 1;
      perRegion.set(id, (perRegion.get(id) ?? 0) + 1);
      if (side.dim) dimmed.add(id);
    }
    return { segments, regions: perRegion, dimmed };
  }

  return {
    object: mesh,
    edgeCount: count,
    apply,
    countSegments,
    /** A split view's panel: 'L' keeps the left half (x >= midline), 'R' the right, null both. */
    setPanel(side) {
      material.uniforms.uPanel.value = side === 'L' ? 1 : side === 'R' ? -1 : 0;
    },
    get visible() {
      return mesh.visible;
    },
    /** Called after the regions layer changed what it draws (a region may be gone, so may the layer). */
    refresh() {
      showWhat();
    },
    /** Size the lines for a drawing buffer of width x height device px. */
    setResolution(widthPx, heightPx, pxPerAppPx) {
      material.uniforms.uResolution.value.set(widthPx, heightPx);
      material.uniforms.uWidthPx.value = widthAppPx * pxPerAppPx;
    },
    dispose() {
      lineGeometry.dispose();
      material.dispose();
    },
  };
}

/**
 * The region meshes of Meshes mode (plan 3.8 viewer3d/layers/regions.js): one
 * merged geometry for every region, with a per-vertex region id, and a
 * DataTexture holding each region's color and visibility for the whole mesh
 * (B) and for its left (L) and right (R) halves. The fragment shader tests
 * the side of the midline (world x >= midline_x is the left half, as today's
 * cut_with_plane keeps it), so the hemisphere modes and the per-half Δ colors
 * of lateralized data cost one draw. The halves are open at the cut, as
 * today's clipped meshes are.
 *
 * Today's look: unlit, the region's color, alpha 0.6 (display.regions.alpha),
 * both faces drawn; translucent, so transparency.js depth-peels it.
 *
 * Texture layout: texel (id) for B, (count + id) for L, (2 x count + id) for
 * R, where id is the region's value in the geometry blob (scene
 * regions.geo_range[i][0]); RGB is the color, A is 255 when drawn.
 *
 * Plain ES module: imports three only.
 */

import * as THREE from 'three';
import { PEEL_PARS_FRAGMENT, PEEL_TEST_FRAGMENT, TRANSLUCENT_LAYER, translucentMaterials } from '../transparency.js';

export const TEXTURE_WIDTH = 256;
const VIEWS = ['B', 'L', 'R'];
/** Q23: in Meshes mode the selected regions stay; the others draw at this fraction of the region alpha. */
export const FOCUS_DIM_FACTOR = 0.25;
const FOCUS_DIM_BYTE = 160; // a texel alpha above 0.5 (drawn) and below 0.99 (dimmed)
// D46: a comparison's half of a region its side's dataset lacks: outline only. Below 0.5, so the fill discards it;
// layers/outlines.js draws it.
export const HOLLOW_BYTE = 32;

const REGION_VERT = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
attribute float regionId;
uniform sampler2D uRegionTex;
uniform int uRegionCount;
uniform int uTexWidth;
varying vec4 vB;
varying vec4 vL;
varying vec4 vR;
varying float vWorldX;
vec4 regionTexel(int t) { return texelFetch(uRegionTex, ivec2(t % uTexWidth, t / uTexWidth), 0); }
void main() {
  int id = int(regionId + 0.5);
  vB = regionTexel(id);
  vL = regionTexel(uRegionCount + id);
  vR = regionTexel(2 * uRegionCount + id);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldX = world.x;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}
`;

const REGION_FRAG = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>
uniform float uAlpha;
uniform float uMidline;
uniform float uPanel;
${PEEL_PARS_FRAGMENT}
varying vec4 vB;
varying vec4 vL;
varying vec4 vR;
varying float vWorldX;
void main() {
  #include <clipping_planes_fragment>
  if ((uPanel > 0.5 && vWorldX < uMidline) || (uPanel < -0.5 && vWorldX > uMidline)) discard;   // split view
  vec4 c = vB.a > 0.5 ? vB : (vWorldX >= uMidline ? vL : vR);
  if (c.a < 0.5) discard;
  ${PEEL_TEST_FRAGMENT}
  float alpha = c.a > 0.99 ? uAlpha : uAlpha * ${FOCUS_DIM_FACTOR.toFixed(2)};   // Q23: a dimmed region
  #ifdef PEEL
    gl_FragColor = vec4(c.rgb * alpha, alpha);   // premultiplied, composited front to back
  #else
    gl_FragColor = vec4(c.rgb, alpha);
  #endif
}
`;

/**
 * @param {object} geometry  loader.js parseGeometry() result
 * @param {{geo_range: (number[]|null)[]}} sceneRegions  scene.regions
 * @param {number} midlineX  scene.world.midline_x
 * @param {object} peelUniforms  transparency's shared peel uniforms
 */
export function createRegionsLayer(geometry, sceneRegions, midlineX, peelUniforms) {
  const count = Math.max(1, geometry.regionCount);
  const height = Math.ceil((3 * count) / TEXTURE_WIDTH);
  const data = new Uint8Array(TEXTURE_WIDTH * height * 4);
  const texture = new THREE.DataTexture(data, TEXTURE_WIDTH, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', geometry.positionAttribute);
  g.setAttribute('regionId', geometry.regionIdAttribute);
  g.setIndex(new THREE.BufferAttribute(geometry.indices.subarray(0, 3 * geometry.regionTriangles), 1));
  g.boundingSphere = geometry.boundingSphere;

  const uniforms = {
    uRegionTex: { value: texture },
    uRegionCount: { value: count },
    uTexWidth: { value: TEXTURE_WIDTH },
    uAlpha: { value: 0.6 },
    uMidline: { value: midlineX },
    uPanel: { value: 0 },
  };
  const materials = translucentMaterials(peelUniforms, { vertexShader: REGION_VERT, fragmentShader: REGION_FRAG, uniforms });
  const mesh = new THREE.Mesh(g, materials.blend);
  mesh.name = 'regions';
  mesh.userData.materials = materials;
  mesh.layers.set(TRANSLUCENT_LAYER);
  mesh.renderOrder = 3;
  mesh.frustumCulled = false;
  mesh.visible = false;

  // Scene region i -> geometry id (null: no mesh).
  const ids = sceneRegions.geo_range.map((range) => (range ? range[0] : null));
  let shown = 0;
  let hollowShown = 0;

  /**
   * Apply a display packet's regions {visible: {B, L, R}, color: {B, L, R}, alpha}. focus (Q23): a Set of
   * scene region indices that stay as they are while every other drawn region dims, or null.
   */
  function apply(packet, focus = null) {
    data.fill(0);
    shown = 0;
    hollowShown = 0;
    ids.forEach((id, i) => {
      if (id === null || id === undefined) return;
      let any = false;
      VIEWS.forEach((view, v) => {
        if (!packet.visible[view][i]) return;
        const t = 4 * (v * count + id);
        data[t] = packet.color[view][3 * i];
        data[t + 1] = packet.color[view][3 * i + 1];
        data[t + 2] = packet.color[view][3 * i + 2];
        data[t + 3] = focus && !focus.has(i) ? FOCUS_DIM_BYTE : 255;
        any = true;
      });
      if (any) shown += 1;
      for (const view of ['L', 'R']) {
        if (!packet.hollow?.[view]?.[i] || packet.visible[view][i]) continue;
        data[4 * (VIEWS.indexOf(view) * count + id) + 3] = HOLLOW_BYTE;
        hollowShown += 1;
      }
    });
    texture.needsUpdate = true;
    uniforms.uAlpha.value = Number(packet.alpha);
    mesh.visible = shown > 0;
  }

  return {
    object: mesh,
    apply,
    /** A split view's panel: 'L' keeps the left half (x >= midline), 'R' the right, null both. */
    setPanel(side) {
      uniforms.uPanel.value = side === 'L' ? 1 : side === 'R' ? -1 : 0;
    },
    /** Regions with at least one drawn view. */
    drawnCount: () => shown,
    /** D31: the texture and its layout, shared with layers/outlines.js. */
    texture,
    textureCount: count,
    textureWidth: TEXTURE_WIDTH,
    /**
     * The drawn views {B, L, R, dim} of the region with geometry id `id` (dim: Q23), or null when none is drawn;
     * hollowL and hollowR: a half drawn as its outline only (D46).
     */
    sides(id) {
      const a = [data[4 * id + 3], data[4 * (count + id) + 3], data[4 * (2 * count + id) + 3]];
      if (!(a[0] || a[1] || a[2])) return null;
      const on = (v) => v > HOLLOW_BYTE;
      return { B: on(a[0]), L: on(a[1]), R: on(a[2]), dim: a.some((v) => on(v) && v < 255),
        hollowL: a[1] === HOLLOW_BYTE, hollowR: a[2] === HOLLOW_BYTE };
    },
    /** Halves drawn hollow now (D46). */
    get hollowShown() {
      return hollowShown;
    },
    /** Scene region index -> geometry id (null: no mesh). */
    geometryIds: () => ids.slice(),
    get visible() {
      return mesh.visible;
    },
    dispose() {
      g.dispose();
      texture.dispose();
      materials.blend.dispose();
      materials.peel.dispose();
    },
  };
}

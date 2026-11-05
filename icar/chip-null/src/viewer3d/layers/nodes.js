/**
 * The node spheres (plan 3.8 viewer3d/layers/nodes.js): instanced spheres,
 * visible instances packed first, one draw for the opaque spheres and one for
 * the dimmed ones (alpha below 1: outside a network highlight).
 *
 * Positions come from the static scene (nodes.pos, world µm); visibility,
 * radius, color and alpha from the display packet. JavaScript decides none of
 * them (plan 3.6). A comparison's display packet (D46) also carries
 * nodes.pos, since its midline spheres move with the size multiplier, and
 * nodes.hollow: a hollow sphere is not drawn here but stays visible, so it
 * picks and is labeled; the 2D overlay draws its outline (overlay/layout.js).
 *
 * The look is today's VTK sphere (vedo Sphere: ambient 0, diffuse 1, specular
 * 0, Phong interpolation) under VTK's headlight: Lambert shading per fragment,
 * lit along the view direction (viewer3d/index.js adds the light).
 * The display packet's node_style (figure fields) changes it live: flat (the
 * fill unlit), glossy (a headlight highlight added), an outline ring of a
 * constant width in px in each sphere's nodes.outline color (drawn in the
 * sphere's own pixels, so a nearer sphere hides a farther one's ring; at most
 * half the sphere's radius), and an opacity for every sphere. Style groups
 * (core/node_styles.py) send nodes.opacity and nodes.outline_px per sphere,
 * which then replace the style's. Spheres drawn translucent are sorted back
 * to front (sort()).
 *
 * Plain ES module: imports three only.
 */

import * as THREE from 'three';

// 32 x 16: the same picture as vedo's 48 x 24 at the reference size (P3a), with half the triangles.
export const SPHERE_SEGMENTS = [32, 16];
const OPAQUE = 0.999;

export const NODE_STYLES = { shaded: 0, flat: 1, glossy: 2 };
const GLOSS = { strength: 0.45, shininess: 40 };
const OUTLINE_MAX_FRACTION = 0.5; // a ring covers at most half a sphere's radius

const STYLE_VERTEX = /* glsl */ `
vInstanceAlpha = aAlpha;
vOutlineColor = aOutline;
vOutlinePx = aOutlinePx * uPxPerApp;
{
  vec4 centerView = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float worldRadius = length(instanceMatrix[0].xyz);
  float depth = isOrthographic ? 1.0 : max(-centerView.z, 1e-6);
  vRadiusPx = worldRadius * projectionMatrix[1][1] * 0.5 * uViewportHeight / depth;
}`;

const STYLE_FRAGMENT = /* glsl */ `
if (uStyle > 0.5 && uStyle < 1.5) {
  outgoingLight = diffuseColor.rgb;
} else if (uStyle > 1.5) {
  float ndv = max(dot(normalize(normal), geometryViewDir), 0.0);
  outgoingLight += vec3(${GLOSS.strength.toFixed(2)} * pow(ndv, ${GLOSS.shininess.toFixed(1)}));
}
if (vOutlinePx > 0.0) {
  float c = dot(normalize(normal), geometryViewDir);
  float s = sqrt(max(0.0, 1.0 - c * c));                    // distance from the center over the radius
  float edge = max(1.0 - vOutlinePx / max(vRadiusPx, 1e-3), ${(1 - OUTLINE_MAX_FRACTION).toFixed(2)});
  float aa = max(fwidth(s), 1e-4);
  outgoingLight = mix(outgoingLight, vOutlineColor, smoothstep(edge - aa, edge + aa, s));
}
#include <opaque_fragment>`;

/**
 * MeshLambertMaterial (VTK's diffuse-only spheres) with a per-instance alpha (attribute aAlpha), outline
 * color (aOutline) and outline width in app px (aOutlinePx), and the node style's uniforms (shared by both meshes).
 */
function sphereMaterial(transparent, uniforms) {
  const material = new THREE.MeshLambertMaterial({
    transparent,
    depthWrite: !transparent,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aAlpha;
attribute vec3 aOutline;
attribute float aOutlinePx;
uniform float uViewportHeight;
uniform float uPxPerApp;
varying float vInstanceAlpha;
varying vec3 vOutlineColor;
varying float vOutlinePx;
varying float vRadiusPx;`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${STYLE_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uStyle;
varying float vInstanceAlpha;
varying vec3 vOutlineColor;
varying float vOutlinePx;
varying float vRadiusPx;`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( diffuse, opacity * vInstanceAlpha );')
      .replace('#include <opaque_fragment>', STYLE_FRAGMENT);
  };
  material.customProgramCacheKey = () => 'neuronode-sphere-style';
  return material;
}

/**
 * @param {{acr: string[], hemi: string[], pos: number[]}} sceneNodes  the static scene's nodes
 */
export function createNodesLayer(sceneNodes) {
  const n = sceneNodes.acr.length;
  const base = Float64Array.from(sceneNodes.pos); // the static scene's places; a packet's pos may move them
  const positions = Float64Array.from(base);
  const geometry = new THREE.SphereGeometry(1, SPHERE_SEGMENTS[0], SPHERE_SEGMENTS[1]);
  const group = new THREE.Group();
  group.name = 'nodes';
  const styleUniforms = {
    uStyle: { value: 0 },
    uPxPerApp: { value: 1 },
    uViewportHeight: { value: 1 },
  };
  let style = { style: 'shaded', outline: false, outline_width_px: 1.5, opacity: 1 };
  let pxPerApp = 1;

  function makeMesh(transparent) {
    const mesh = new THREE.InstancedMesh(geometry, sphereMaterial(transparent, styleUniforms), Math.max(1, n));
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const alpha = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n)), 1);
    alpha.setUsage(THREE.DynamicDrawUsage);
    mesh.geometry = geometry.clone(); // each mesh needs its own aAlpha and aOutline attributes
    mesh.geometry.setAttribute('aAlpha', alpha);
    const outline = new THREE.InstancedBufferAttribute(new Float32Array(3 * Math.max(1, n)), 3);
    outline.setUsage(THREE.DynamicDrawUsage);
    mesh.geometry.setAttribute('aOutline', outline);
    const outlinePx = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n)), 1);
    outlinePx.setUsage(THREE.DynamicDrawUsage);
    mesh.geometry.setAttribute('aOutlinePx', outlinePx);
    mesh.setColorAt(0, new THREE.Color(0, 0, 0)); // creates instanceColor
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.renderOrder = transparent ? 2 : 0;
    group.add(mesh);
    return mesh;
  }
  const solid = makeMesh(false);
  const dim = makeMesh(true);

  // Per node, as the last display packet set it.
  const visible = new Uint8Array(n);
  const hollow = new Uint8Array(n);
  const radius = new Float64Array(n);
  const alpha = new Float32Array(n);
  const color = new Uint8Array(3 * n);
  const outlineColor = new Uint8Array(3 * n);
  const opacity = new Float32Array(n); // the style's, or the sphere's group's
  const outlineWidth = new Float32Array(n); // app px, 0 without a ring
  const slotOf = new Int32Array(n).fill(-1); // instance slot in its mesh, or -1
  const meshOf = new Int8Array(n).fill(-1); // 0 solid, 1 dim
  const order = { solid: [], dim: [] };

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const c = new THREE.Color();

  function place(mesh, slot, i) {
    const r = radius[i];
    p.set(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]);
    mesh.setMatrixAt(slot, m4.compose(p, q, s.set(r, r, r)));
    mesh.setColorAt(slot, c.setRGB(color[3 * i] / 255, color[3 * i + 1] / 255, color[3 * i + 2] / 255));
    mesh.geometry.attributes.aAlpha.array[slot] = alpha[i] * opacity[i];
    mesh.geometry.attributes.aOutlinePx.array[slot] = outlineWidth[i];
    const o = mesh.geometry.attributes.aOutline.array;
    for (let j = 0; j < 3; j += 1) o[3 * slot + j] = outlineColor[3 * i + j] / 255;
  }

  function syncStyle() {
    styleUniforms.uStyle.value = NODE_STYLES[style.style] ?? 0;
    styleUniforms.uPxPerApp.value = pxPerApp;
  }

  /**
   * Apply a display packet's nodes {visible, radius, color, alpha, outline?, pos?, hollow?, opacity?,
   * outline_px?} drawn in the packet's node_style. Returns true when pos moved a sphere (the edges then take the new ends).
   */
  function apply(packet, nodeStyle = null) {
    if (nodeStyle) style = { ...style, ...nodeStyle };
    syncStyle();
    order.solid = [];
    order.dim = [];
    let moved = false;
    const source = packet.pos ?? base; // Distribute's or a comparison's places, else the scene's own
    for (let j = 0; j < 3 * n; j += 1) {
      const v = Number(source[j]);
      if (positions[j] !== v) {
        positions[j] = v;
        moved = true;
      }
    }
    for (let i = 0; i < n; i += 1) {
      const a = Number(packet.alpha[i]) || 0;
      const r = packet.radius[i];
      const shown = Boolean(packet.visible[i]) && a > 0 && r !== null && r > 0;
      visible[i] = shown ? 1 : 0;
      radius[i] = shown ? Number(r) : 0;
      alpha[i] = a;
      color[3 * i] = packet.color[3 * i];
      color[3 * i + 1] = packet.color[3 * i + 1];
      color[3 * i + 2] = packet.color[3 * i + 2];
      for (let j = 0; j < 3; j += 1) outlineColor[3 * i + j] = packet.outline ? packet.outline[3 * i + j] : 0;
      opacity[i] = packet.opacity ? Number(packet.opacity[i]) : style.opacity;
      outlineWidth[i] = packet.outline_px ? Number(packet.outline_px[i])
        : (style.outline ? Number(style.outline_width_px) : 0);
      slotOf[i] = -1;
      meshOf[i] = -1;
      hollow[i] = packet.hollow?.[i] ? 1 : 0;
      if (!shown || hollow[i]) continue;
      (a * opacity[i] >= OPAQUE ? order.solid : order.dim).push(i);
    }
    order.solid.forEach((i, slot) => {
      place(solid, slot, i);
      slotOf[i] = slot;
      meshOf[i] = 0;
    });
    order.dim.forEach((i, slot) => {
      place(dim, slot, i);
      slotOf[i] = slot;
      meshOf[i] = 1;
    });
    for (const [mesh, list] of [[solid, order.solid], [dim, order.dim]]) {
      mesh.count = list.length;
      mesh.visible = list.length > 0;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      mesh.geometry.attributes.aAlpha.needsUpdate = true;
      mesh.geometry.attributes.aOutline.needsUpdate = true;
      mesh.geometry.attributes.aOutlinePx.needsUpdate = true;
    }
    return moved;
  }

  /** Draw the translucent spheres back to front for this camera (after a move or a new packet). */
  function sort(camera) {
    if (order.dim.length < 2) return;
    const view = camera.matrixWorldInverse.elements;
    const depth = (i) => view[2] * positions[3 * i] + view[6] * positions[3 * i + 1] + view[10] * positions[3 * i + 2];
    order.dim.sort((a, b) => depth(a) - depth(b));
    order.dim.forEach((i, slot) => {
      place(dim, slot, i);
      slotOf[i] = slot;
    });
    dim.instanceMatrix.needsUpdate = true;
    dim.instanceColor.needsUpdate = true;
    dim.geometry.attributes.aAlpha.needsUpdate = true;
    dim.geometry.attributes.aOutline.needsUpdate = true;
    dim.geometry.attributes.aOutlinePx.needsUpdate = true;
  }

  const center = new THREE.Vector3();
  return {
    object: group,
    count: n,
    positions,
    visible,
    hollow,
    radius,
    alpha,
    /** Hollow spheres shown now (the overlay draws them; D46). */
    hollowCount: () => hollow.reduce((sum, h, i) => sum + (h && visible[i] ? 1 : 0), 0),
    /** Spheres drawn now. */
    drawnCount: () => order.solid.length + order.dim.length,
    /** The drawn spheres' node indices, opaque first. */
    drawn: () => [...order.solid, ...order.dim],
    /**
     * Center of sphere i as its instance matrix places it (what the GPU draws), or null when hidden.
     * @returns {THREE.Vector3 | null}
     */
    drawnCenter(i) {
      if (meshOf[i] < 0) return null;
      const mesh = meshOf[i] === 0 ? solid : dim;
      mesh.getMatrixAt(slotOf[i], m4);
      return center.setFromMatrixPosition(m4).clone();
    },
    apply,
    sort,
    /** Size the outline ring for a drawing buffer of height device px (pxPerAppPx: device px per app px). */
    setResolution(heightPx, pxPerAppPx) {
      styleUniforms.uViewportHeight.value = heightPx;
      pxPerApp = pxPerAppPx;
      syncStyle();
    },
    dispose() {
      for (const mesh of [solid, dim]) {
        mesh.geometry.dispose();
        mesh.material.dispose();
        mesh.dispose();
      }
      geometry.dispose();
    },
  };
}

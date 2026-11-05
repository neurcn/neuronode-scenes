/**
 * Arrowheads of directed data (plan 3.8 viewer3d/layers/arrows.js): instanced
 * cones placed from the display packet's edges.arrow {tip, axis, radius,
 * height} (core/scene.py with today's vl.arrowhead_size and place_arrowhead):
 * the tip on the target sphere's surface, the cone along the edge, its center
 * half a height behind the tip. Unlit, in the edge's color and alpha, as
 * today's cones are (lighting off, alpha 0.9).
 *
 * Plain ES module: imports three only.
 */

import * as THREE from 'three';

export const CONE_SEGMENTS = 16; // vedo Cone(res=16), as today

const ARROW_VERT = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
attribute vec3 aColor;
attribute float aAlpha;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}
`;

const ARROW_FRAG = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>
varying vec3 vColor;
varying float vAlpha;
void main() {
  #include <clipping_planes_fragment>
  gl_FragColor = vec4(vColor, vAlpha);
}
`;

/** The local tip of the unit cone (ConeGeometry along +Y, apex at y = +0.5, as vedo's Cone along its axis). */
export const CONE_TIP = Object.freeze([0, 0.5, 0]);

/** @param {number} copies  edge copies in the static scene */
export function createArrowsLayer(copies) {
  const size = Math.max(1, copies);
  const geometry = new THREE.ConeGeometry(1, 1, CONE_SEGMENTS, 1, false);
  const aColor = new THREE.InstancedBufferAttribute(new Uint8Array(3 * size), 3, true);
  const aAlpha = new THREE.InstancedBufferAttribute(new Float32Array(size), 1);
  aColor.setUsage(THREE.DynamicDrawUsage);
  aAlpha.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aColor', aColor);
  geometry.setAttribute('aAlpha', aAlpha);
  const material = new THREE.ShaderMaterial({
    vertexShader: ARROW_VERT,
    fragmentShader: ARROW_FRAG,
    transparent: true,
    depthWrite: true,
    side: THREE.DoubleSide,
    clipping: true,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, size);
  mesh.name = 'arrows';
  mesh.count = 0;
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  let drawnCopies = [];
  const m4 = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const axis = new THREE.Vector3();
  const centerV = new THREE.Vector3();
  const scaleV = new THREE.Vector3();

  /** Apply a display packet's edges; arrows are drawn for visible copies with an arrowhead. */
  function apply(edges) {
    drawnCopies = [];
    const arrow = edges.arrow;
    if (arrow) {
      for (let k = 0; k < copies; k += 1) {
        const r = arrow.radius[k];
        const h = arrow.height[k];
        const a = Number(edges.alpha[k]) || 0;
        if (!edges.visible[k] || a <= 0 || r === null || h === null || arrow.tip[3 * k] === null) continue;
        const slot = drawnCopies.length;
        axis.set(arrow.axis[3 * k], arrow.axis[3 * k + 1], arrow.axis[3 * k + 2]).normalize();
        rotation.setFromUnitVectors(yAxis, axis);
        centerV.set(arrow.tip[3 * k], arrow.tip[3 * k + 1], arrow.tip[3 * k + 2]).addScaledVector(axis, -0.5 * h);
        mesh.setMatrixAt(slot, m4.compose(centerV, rotation, scaleV.set(r, h, r)));
        for (let j = 0; j < 3; j += 1) aColor.array[3 * slot + j] = edges.color[3 * k + j];
        aAlpha.array[slot] = a;
        drawnCopies.push(k);
      }
    }
    mesh.count = drawnCopies.length;
    mesh.visible = drawnCopies.length > 0;
    mesh.instanceMatrix.needsUpdate = true;
    aColor.needsUpdate = true;
    aAlpha.needsUpdate = true;
  }

  return {
    object: mesh,
    apply,
    drawnCount: () => drawnCopies.length,
    /** [{copy, tip: [x, y, z]}]: each drawn cone's apex as its instance matrix places it. */
    drawnTips() {
      const out = [];
      const tip = new THREE.Vector3();
      drawnCopies.forEach((k, slot) => {
        mesh.getMatrixAt(slot, m4);
        tip.set(CONE_TIP[0], CONE_TIP[1], CONE_TIP[2]).applyMatrix4(m4);
        out.push({ copy: k, tip: [tip.x, tip.y, tip.z] });
      });
      return out;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}

/**
 * Screen-space wide lines in one instanced draw (plan D28, 3.8 viewer3d/edge_material.js).
 *
 * Derived from three.js r186's LineMaterial and LineSegmentsGeometry
 * (examples/jsm/lines/, vendored beside this app in three@0.186.1): the same
 * eight-vertex segment with round end caps, the same trim of segments that
 * cross the camera plane and the same expansion in normalized device
 * coordinates. Changed for Neuronode:
 * - every instance carries its own width (aWidth, in app px), color (aColor,
 *   8-bit RGB) and alpha (aAlpha), so all edges are one draw call;
 * - the width is in device pixels: aWidth x uPxPerAppPx, where uPxPerAppPx is
 *   style.edge_css_px_per_app_px (0.5) x the device pixel ratio x the export
 *   scale k (D45). On a 2x display an app px is one device px, as today;
 * - uAlphaCap lowers every edge to style.drag_edge_alpha while the camera is
 *   dragged, as today's viewer does;
 * - no world units, dashes, fog or alpha to coverage.
 * The silhouette of the shell (layers/shell.js) uses the same expansion
 * without caps.
 *
 * Portions: The MIT License. Copyright © 2010-2026 three.js authors.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions: The above
 * copyright notice and this permission notice shall be included in all copies
 * or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
 * WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
 * TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 * CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * Plain ES module: imports three only.
 */

import * as THREE from 'three';

// LineSegmentsGeometry's segment: x = side (-1, 1); y = 1 at the end, 0 at the start, 2 and -1 the round caps.
const CAPPED = {
  positions: [-1, 2, 0, 1, 2, 0, -1, 1, 0, 1, 1, 0, -1, 0, 0, 1, 0, 0, -1, -1, 0, 1, -1, 0],
  uvs: [-1, 2, 1, 2, -1, 1, 1, 1, -1, -1, 1, -1, -1, -2, 1, -2],
  index: [0, 2, 1, 2, 3, 1, 2, 4, 3, 4, 5, 3, 4, 6, 5, 6, 7, 5],
};
// The plain quad (no caps): the middle part of the same segment.
const PLAIN = {
  positions: [-1, 1, 0, 1, 1, 0, -1, 0, 0, 1, 0, 0],
  uvs: [-1, 1, 1, 1, -1, -1, 1, -1],
  index: [0, 2, 1, 2, 3, 1],
};

/**
 * An InstancedBufferGeometry holding one segment; instance attributes are added by the layer.
 * @param {{caps?: boolean}} [options]
 */
export function createSegmentGeometry({ caps = true } = {}) {
  const shape = caps ? CAPPED : PLAIN;
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex(shape.index);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(shape.positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(shape.uvs, 2));
  geometry.instanceCount = 0;
  return geometry;
}

/**
 * GLSL: the clip-space position of this segment vertex, from the segment's
 * ends in view space and its full width in device pixels (LineMaterial's
 * screen-space branch).
 */
export const SEGMENT_EXPAND_GLSL = /* glsl */ `
uniform vec2 uResolution;   // drawing buffer, device px

float trimSegmentAlpha(const in vec4 start, const in vec4 end) {
  float a = projectionMatrix[2][2];
  float b = projectionMatrix[3][2];
  float nearEstimate = (a > 0.0) ? (-b / (a + 1.0)) : (-0.5 * b / a);
  return (nearEstimate - start.z) / (end.z - start.z);
}

vec4 expandSegment(vec4 start, vec4 end, float widthPx, bool caps) {
  float aspect = uResolution.x / uResolution.y;
  bool perspective = (projectionMatrix[2][3] == -1.0);
  if (perspective) {
    if (start.z < 0.0 && end.z >= 0.0) {
      end.xyz = mix(start.xyz, end.xyz, trimSegmentAlpha(start, end));
    } else if (end.z < 0.0 && start.z >= 0.0) {
      start.xyz = mix(end.xyz, start.xyz, trimSegmentAlpha(end, start));
    }
  }
  vec4 clipStart = projectionMatrix * start;
  vec4 clipEnd = projectionMatrix * end;
  vec3 ndcStart = clipStart.xyz / clipStart.w;
  vec3 ndcEnd = clipEnd.xyz / clipEnd.w;
  vec2 dir = ndcEnd.xy - ndcStart.xy;
  dir.x *= aspect;
  dir = length(dir) > 1e-12 ? normalize(dir) : vec2(1.0, 0.0);
  vec2 offset = vec2(dir.y, -dir.x);
  dir.x /= aspect;
  offset.x /= aspect;
  if (position.x < 0.0) offset *= -1.0;
  if (caps) {
    if (position.y < 0.0) {
      offset += -dir;
    } else if (position.y > 1.0) {
      offset += dir;
    }
  }
  offset *= widthPx;
  offset /= uResolution.y;
  vec4 clip = (position.y < 0.5) ? clipStart : clipEnd;
  offset *= clip.w;
  clip.xy += offset;
  return clip;
}
`;

/**
 * GLSL: a segment of a curved edge (a path of segments). Where a segment
 * meets its neighbor, both use the miter of the two screen directions, so the
 * joint has no gap and no doubled alpha; only the path's two free ends get
 * round caps. join.x / join.y: a segment before / after this one.
 */
const PATH_EXPAND_GLSL = /* glsl */ `
vec2 screenDir(vec4 a, vec4 b, float aspect) {
  vec4 ca = projectionMatrix * a;
  vec4 cb = projectionMatrix * b;
  vec2 d = cb.xy / cb.w - ca.xy / ca.w;
  d.x *= aspect;
  return length(d) > 1e-12 ? normalize(d) : vec2(1.0, 0.0);
}

vec4 expandPathSegment(vec4 prev, vec4 start, vec4 end, vec4 next, float widthPx, vec2 join) {
  float aspect = uResolution.x / uResolution.y;
  vec2 dir = screenDir(start, end, aspect);
  vec2 normal = vec2(dir.y, -dir.x);
  bool atStart = position.y < 0.5;
  vec2 offset = normal;
  if ((atStart ? join.x : join.y) > 0.5) {
    vec2 other = atStart ? screenDir(prev, start, aspect) : screenDir(end, next, aspect);
    vec2 miter = normal + vec2(other.y, -other.x);
    if (length(miter) > 1e-6) {
      miter = normalize(miter);
      offset = miter / max(dot(miter, normal), 0.5);   // the miter at most twice the half width
    }
  }
  if (position.x < 0.0) offset *= -1.0;
  if (position.y < 0.0 && join.x < 0.5) offset -= dir;   // round caps at the free ends only
  if (position.y > 1.0 && join.y < 0.5) offset += dir;
  offset.x /= aspect;
  offset *= widthPx;
  offset /= uResolution.y;
  vec4 clip = projectionMatrix * (atStart ? start : end);
  offset *= clip.w;
  clip.xy += offset;
  return clip;
}
`;

const EDGE_VERT = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
uniform float uPxPerAppPx;
uniform float uAlphaCap;
uniform float uDashScale;
attribute vec3 aCenterA;
attribute vec3 aCenterB;
attribute vec2 aRadius;
attribute float aDash;
varying vec2 vCenterA;
varying vec2 vCenterB;
varying vec2 vRadiusPx;
varying float vLengthPx;
varying float vDashPx;
attribute vec3 aStart;
attribute vec3 aEnd;
attribute vec3 aPrev;
attribute vec3 aNext;
attribute vec2 aJoin;
attribute vec3 aColor;
attribute float aAlpha;
attribute float aWidth;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
${SEGMENT_EXPAND_GLSL}
${PATH_EXPAND_GLSL}
vec2 toPx(vec4 view) {
  vec4 clip = projectionMatrix * view;
  return (clip.xy / clip.w * 0.5 + 0.5) * uResolution;
}
float radiusPx(vec4 view, float radius) {
  float depth = (projectionMatrix[2][3] == -1.0) ? max(-view.z, 1e-6) : 1.0;
  return radius * projectionMatrix[1][1] * 0.5 * uResolution.y / depth;
}
void main() {
  vColor = aColor;
  vAlpha = min(aAlpha, uAlphaCap);
  vUv = uv;
  vec4 start = modelViewMatrix * vec4(aStart, 1.0);
  vec4 end = modelViewMatrix * vec4(aEnd, 1.0);
  // The copy's two spheres on screen (an edge may stop at their borders), and this segment's length for dashes.
  vec4 centerA = modelViewMatrix * vec4(aCenterA, 1.0);
  vec4 centerB = modelViewMatrix * vec4(aCenterB, 1.0);
  vCenterA = toPx(centerA);
  vCenterB = toPx(centerB);
  vRadiusPx = vec2(radiusPx(centerA, aRadius.x), radiusPx(centerB, aRadius.y));
  vLengthPx = length(toPx(end) - toPx(start));
  vDashPx = aDash > 0.5 ? uDashScale * max(4.0, 2.5 * aWidth) * uPxPerAppPx : 0.0;
  if (aJoin.x < 0.5 && aJoin.y < 0.5) {
    gl_Position = expandSegment(start, end, aWidth * uPxPerAppPx, true);
  } else {
    gl_Position = expandPathSegment(modelViewMatrix * vec4(aPrev, 1.0), start, end,
      modelViewMatrix * vec4(aNext, 1.0), aWidth * uPxPerAppPx, aJoin);
  }
  vec4 mvPosition = (position.y < 0.5) ? start : end;
  #include <clipping_planes_vertex>
}
`;

const EDGE_FRAG = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>
uniform float uTrimEnds;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying vec2 vCenterA;
varying vec2 vCenterB;
varying vec2 vRadiusPx;
varying float vLengthPx;
varying float vDashPx;
void main() {
  #include <clipping_planes_fragment>
  // Flat spheres: an edge stops at its spheres' borders on screen.
  if (uTrimEnds > 0.5 && (distance(gl_FragCoord.xy, vCenterA) < vRadiusPx.x
      || distance(gl_FragCoord.xy, vCenterB) < vRadiusPx.y)) discard;
  // Dashed (an edge to a muted sphere): dashes and gaps of vDashPx along the segment.
  if (vDashPx > 0.0 && mod(vUv.y * vLengthPx, 2.0 * vDashPx) > vDashPx) discard;
  if (abs(vUv.y) > 1.0) {
    float a = vUv.x;
    float b = (vUv.y > 0.0) ? vUv.y - 1.0 : vUv.y + 1.0;
    if (a * a + b * b > 1.0) discard;   // round end caps
  }
  gl_FragColor = vec4(vColor, vAlpha);
}
`;

/**
 * The edges' material: blended, depth-tested and depth-writing, as the
 * prototype's lines were (it matched today's picture, P0 gate).
 */
export function createEdgeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uResolution: { value: new THREE.Vector2(1, 1) },
      uPxPerAppPx: { value: 1 },
      uAlphaCap: { value: 1 },
      uDashScale: { value: 1 },
      uTrimEnds: { value: 0 },
    },
    vertexShader: EDGE_VERT,
    fragmentShader: EDGE_FRAG,
    transparent: true,
    depthTest: true,
    depthWrite: true,
    clipping: true,
  });
}

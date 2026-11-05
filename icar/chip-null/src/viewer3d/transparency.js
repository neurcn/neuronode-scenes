/**
 * Translucent meshes: depth peeling or sorted blending (plan 3.8 viewer3d/transparency.js).
 *
 * Lifted from the prototype's peel (proto.js 269-337), which matched today's
 * VTK picture (P0 gate). Depth peeling, front to back:
 * 1. the opaque things (layer 0: spheres, edges) are drawn once into a
 *    multisampled target that keeps its depth;
 * 2. the translucent meshes (TRANSLUCENT_LAYER) are drawn `layers` times, each
 *    pass keeping only the nearest surface behind the previous pass's depth,
 *    and each layer is composited under the ones before it;
 * 3. the translucent result goes over the opaque picture.
 * Layers are RGBA8 and composited with ordinary blending, so no float
 * blending is needed (EXT_float_blend is on only 56% of Safari devices).
 * The depth targets are float depth textures.
 *
 * Peel only when meshes are visible; otherwise three.js's sorted blending is
 * enough. An adaptive layer count is P10 work.
 *
 * Plain ES module: imports three only.
 */

import * as THREE from 'three';

export const TRANSLUCENT_LAYER = 1;
export const DEFAULT_LAYERS = 8;

/** GLSL: the peel inputs, compiled in only when PEEL is defined. */
export const PEEL_PARS_FRAGMENT = /* glsl */ `
#ifdef PEEL
uniform sampler2D uPrevDepth;
uniform sampler2D uOpaqueDepth;
uniform vec2 uRes;
uniform float uFirst;
#endif
`;

/** GLSL: keep only the nearest surface behind the last peeled layer and in front of the opaque scene. */
export const PEEL_TEST_FRAGMENT = /* glsl */ `
#ifdef PEEL
  vec2 peelUv = gl_FragCoord.xy / uRes;
  if (gl_FragCoord.z >= texture2D(uOpaqueDepth, peelUv).r) discard;
  if (uFirst < 0.5 && gl_FragCoord.z <= texture2D(uPrevDepth, peelUv).r + 4e-7) discard;
#endif
`;

/** The uniforms every peel material shares; the peeler sets them per pass. */
export function createPeelUniforms() {
  return {
    uPrevDepth: { value: null },
    uOpaqueDepth: { value: null },
    uRes: { value: new THREE.Vector2(1, 1) },
    uFirst: { value: 1 },
  };
}

/**
 * A blend material and its peel twin from one shader pair. The fragment shader
 * must include PEEL_PARS_FRAGMENT and PEEL_TEST_FRAGMENT and, under PEEL,
 * write premultiplied color with its alpha.
 * @param {object} peelUniforms  from createPeelUniforms()
 * @param {{vertexShader: string, fragmentShader: string, uniforms: object, side?: number}} spec
 * @returns {{blend: THREE.ShaderMaterial, peel: THREE.ShaderMaterial, uniforms: object}}
 */
export function translucentMaterials(peelUniforms, { vertexShader, fragmentShader, uniforms, side = THREE.DoubleSide }) {
  const blend = new THREE.ShaderMaterial({
    uniforms, vertexShader, fragmentShader, transparent: true, depthWrite: false, side, clipping: true,
  });
  const peel = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, ...peelUniforms },
    vertexShader,
    fragmentShader,
    defines: { PEEL: 1 },
    transparent: false,
    blending: THREE.NoBlending,
    depthWrite: true,
    side,
    clipping: true,
  });
  return { blend, peel, uniforms };
}

const FILL_RIM_VERT = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}`;

const FILL_RIM_FRAG = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>
uniform vec3 uColor;
uniform float uAlpha;
uniform float uRimPx;
uniform float uRimAlpha;
uniform float uPx;
${PEEL_PARS_FRAGMENT}
varying vec3 vN;
varying vec3 vV;
void main() {
  #include <clipping_planes_fragment>
  ${PEEL_TEST_FRAGMENT}
  float ndv = abs(dot(normalize(vN), normalize(vV)));
  float d = ndv / (2.0 * max(fwidth(ndv), 1e-5));   // about the distance from the contour, in device pixels
  float w = uRimPx * uPx;
  float rim = w > 0.0 ? 1.0 - smoothstep(w - 0.75, w + 0.75, d) : 0.0;
  float a = mix(uAlpha, uRimAlpha, rim);             // fill and contour mixed in premultiplied form
  vec3 pre = uColor * uAlpha * (1.0 - rim);
  #ifdef PEEL
    gl_FragColor = vec4(pre, a);                     // premultiplied, composited front to back later
  #else
    gl_FragColor = vec4(pre / max(a, 1e-4), a);
  #endif
}`;

/**
 * The prototype's translucent mesh look: an unlit fill with a dark screen-space
 * contour (the stand-in for VTK's silhouette in P1's bench; P3a draws the real
 * GPU silhouette and the regions layer).
 * @param {object} peelUniforms
 * @param {{color: THREE.ColorRepresentation, alpha: number, rimPx: number, rimAlpha: number,
 *          pixelRatio: {value: number}}} look
 */
export function fillRimMaterials(peelUniforms, { color, alpha, rimPx, rimAlpha, pixelRatio }) {
  const uniforms = {
    uColor: { value: new THREE.Color(color) },
    uAlpha: { value: alpha },
    uRimPx: { value: rimPx },
    uRimAlpha: { value: rimAlpha },
    uPx: pixelRatio,
  };
  return translucentMaterials(peelUniforms, { vertexShader: FILL_RIM_VERT, fragmentShader: FILL_RIM_FRAG, uniforms });
}

// An empty peel target: every channel 0 and alpha 0 (nothing peeled yet), not a drawn color.
const EMPTY = new THREE.Color(0, 0, 0);

const QUAD_VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/**
 * The depth peeler for one WebGLRenderer. The opaque pass and the final picture are cleared to the
 * renderer's clear color and alpha (the background: alpha 0 when transparent, so the final alpha is what
 * was drawn); the peel targets are cleared to EMPTY at alpha 0.
 * @param {THREE.WebGLRenderer} three
 * @param {{layers?: number, peelUniforms?: object}} [options]
 */
export function createTransparency(three, { layers = DEFAULT_LAYERS, peelUniforms = createPeelUniforms() } = {}) {
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.PlaneGeometry(2, 2);
  const underMaterial = new THREE.ShaderMaterial({
    uniforms: { tLayer: { value: null } },
    vertexShader: QUAD_VERT,
    fragmentShader: 'uniform sampler2D tLayer; varying vec2 vUv; void main() { gl_FragColor = texture2D(tLayer, vUv); }',
    depthTest: false,
    depthWrite: false,
    transparent: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneMinusDstAlphaFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneMinusDstAlphaFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const finalMaterial = new THREE.ShaderMaterial({
    uniforms: { tOpaque: { value: null }, tAccum: { value: null } },
    vertexShader: QUAD_VERT,
    fragmentShader: `uniform sampler2D tOpaque; uniform sampler2D tAccum; varying vec2 vUv;
      void main() { vec4 o = texture2D(tOpaque, vUv); vec4 a = texture2D(tAccum, vUv);
                    gl_FragColor = vec4(a.rgb + (1.0 - a.a) * o.rgb, a.a + (1.0 - a.a) * o.a); }`,
    depthTest: false,
    depthWrite: false,
  });
  const underScene = new THREE.Scene();
  underScene.add(new THREE.Mesh(quad, underMaterial));
  const finalScene = new THREE.Scene();
  finalScene.add(new THREE.Mesh(quad, finalMaterial));

  let targets = null;
  let layerCount = layers;
  let lastPath = 'none';

  function makeTarget(width, height, samples, depthType) {
    const target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      samples,
      depthBuffer: Boolean(depthType),
      stencilBuffer: false,
    });
    if (depthType) {
      target.depthTexture = new THREE.DepthTexture(width, height, depthType);
      target.depthTexture.minFilter = THREE.NearestFilter;
      target.depthTexture.magFilter = THREE.NearestFilter;
    }
    return target;
  }

  function disposeTargets() {
    if (!targets) return;
    for (const target of [targets.opaque, targets.accum, ...targets.layer]) {
      target.depthTexture?.dispose();
      target.dispose();
    }
    targets = null;
  }

  function ensureTargets() {
    const size = three.getDrawingBufferSize(new THREE.Vector2());
    if (targets && targets.width === size.x && targets.height === size.y) return targets;
    disposeTargets();
    targets = {
      width: size.x,
      height: size.y,
      opaque: makeTarget(size.x, size.y, 4, THREE.UnsignedIntType),
      accum: makeTarget(size.x, size.y, 0, null),
      layer: [makeTarget(size.x, size.y, 0, THREE.FloatType), makeTarget(size.x, size.y, 0, THREE.FloatType)],
    };
    return targets;
  }

  /**
   * Draw scene with camera to the current target (null = the canvas).
   * translucent: the meshes on TRANSLUCENT_LAYER, each with userData.materials {blend, peel}.
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {{peel: boolean, translucent: THREE.Mesh[], target?: THREE.WebGLRenderTarget | null}} how
   * @returns {string}  'sorted' or 'depth peeling, N layers'
   */
  function render(scene, camera, { peel, translucent, target = null }) {
    camera.layers.enable(0);
    camera.layers.enable(TRANSLUCENT_LAYER);
    if (!peel) {
      three.setRenderTarget(target);
      three.render(scene, camera);
      lastPath = 'sorted';
      return lastPath;
    }
    const t = ensureTargets();
    const autoClear = three.autoClear;
    const clearColor = three.getClearColor(new THREE.Color());
    const clearAlpha = three.getClearAlpha();
    three.autoClear = false;
    // 1. the opaque pass, multisampled, keeping its depth
    camera.layers.set(0);
    three.setRenderTarget(t.opaque);
    three.setClearColor(clearColor, clearAlpha);
    three.clear();
    three.render(scene, camera);
    // 2. peel the translucent meshes, nearest layer first, each composited under the ones before
    for (const mesh of translucent) mesh.material = mesh.userData.materials.peel;
    camera.layers.set(TRANSLUCENT_LAYER);
    peelUniforms.uOpaqueDepth.value = t.opaque.depthTexture;
    peelUniforms.uRes.value.set(t.width, t.height);
    three.setClearColor(EMPTY, 0);
    three.setRenderTarget(t.accum);
    three.clear();
    for (let i = 0; i < layerCount; i += 1) {
      const current = t.layer[i % 2];
      const previous = t.layer[(i + 1) % 2];
      peelUniforms.uFirst.value = i === 0 ? 1 : 0;
      peelUniforms.uPrevDepth.value = previous.depthTexture;
      three.setRenderTarget(current);
      three.clear();
      three.render(scene, camera);
      underMaterial.uniforms.tLayer.value = current.texture;
      three.setRenderTarget(t.accum);
      three.render(underScene, quadCamera);
    }
    // 3. the translucent result over the opaque picture
    finalMaterial.uniforms.tOpaque.value = t.opaque.texture;
    finalMaterial.uniforms.tAccum.value = t.accum.texture;
    three.setRenderTarget(target);
    three.setClearColor(clearColor, clearAlpha);
    three.clear();
    three.render(finalScene, quadCamera);
    for (const mesh of translucent) mesh.material = mesh.userData.materials.blend;
    camera.layers.set(0);
    camera.layers.enable(TRANSLUCENT_LAYER);
    three.setClearColor(clearColor, clearAlpha);
    three.autoClear = autoClear;
    lastPath = `depth peeling, ${layerCount} layers`;
    return lastPath;
  }

  return {
    peelUniforms,
    render,
    get layers() {
      return layerCount;
    },
    /** @param {number} n  1-32 */
    setLayers(n) {
      layerCount = Math.max(1, Math.min(32, Math.round(n)));
    },
    get lastPath() {
      return lastPath;
    },
    /** Drop the render targets (they come back at the next peeled frame). */
    releaseTargets: disposeTargets,
    dispose() {
      disposeTargets();
      quad.dispose();
      underMaterial.dispose();
      finalMaterial.dispose();
    },
  };
}

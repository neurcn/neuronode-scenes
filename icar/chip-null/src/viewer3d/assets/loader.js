/**
 * The 3D view's data (plan 3.8 viewer3d/assets/loader.js):
 * - the geometry of a pair's region meshes and shell, from the geometry route
 *   (GET /api/v1/geometry/{key}/manifest.json and mesh.bin, immutable): the
 *   manifest (neuronode.geometry/1, core/geometry.py) and one little-endian
 *   blob of positions, normals, indices, shell edges with their two face
 *   normals, per-vertex region ids, and (version 2, D31) each region's
 *   silhouette edges with their two face normals;
 * - checks of the static scene (neuronode.scene/1) and the display packet
 *   (neuronode.display/1) before the layers take them.
 *
 * The requests go through the page's api (actions.js passes its get), so the
 * viewer never calls fetch itself.
 *
 * Plain ES module: imports three only.
 */

import * as THREE from 'three';

export const SCENE_SCHEMA = 'neuronode.scene/1';
export const DISPLAY_SCHEMA = 'neuronode.display/1';
// A comparison's scene and display (core/compare_scene.py, D46): the same shapes, with sides.
export const COMPARE_SCENE_SCHEMA = 'neuronode.compare.scene/1';
export const COMPARE_DISPLAY_SCHEMA = 'neuronode.compare.display/1';
export const GEOMETRY_SCHEMA = 'neuronode.geometry/1';

const TYPES = { float32: Float32Array, uint32: Uint32Array, uint16: Uint16Array };
const BUFFERS = {
  positions: ['float32', 3],
  normals: ['float32', 3],
  indices: ['uint32', 3],
  shell_edges: ['uint32', 2],
  shell_edge_normals: ['float32', 6],
  region_ids: ['uint16', 1],
  region_edges: ['uint32', 2],          // GEOMETRY_VERSION 2 (P8, D31)
  region_edge_normals: ['float32', 6],
};

export class LoadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LoadError';
  }
}

/**
 * Typed views of a geometry blob, checked against its manifest.
 * @param {object} manifest
 * @param {ArrayBuffer} buffer
 */
export function parseGeometry(manifest, buffer) {
  if (!manifest || manifest.schema !== GEOMETRY_SCHEMA) {
    throw new LoadError('The region meshes have an unknown format.');
  }
  if (manifest.byte_order !== 'little') throw new LoadError('The region meshes are not little-endian.');
  if (buffer.byteLength !== manifest.bytes) {
    throw new LoadError(`The region meshes hold ${buffer.byteLength} bytes, not the ${manifest.bytes} their manifest says.`);
  }
  const views = {};
  for (const [name, [dtype, components]] of Object.entries(BUFFERS)) {
    const spec = manifest.buffers?.[name];
    if (!spec || spec.dtype !== dtype || spec.components !== components) {
      throw new LoadError(`The region meshes lack a usable ${name} buffer.`);
    }
    const Type = TYPES[dtype];
    if (spec.offset % Type.BYTES_PER_ELEMENT || spec.offset + spec.bytes > buffer.byteLength
        || spec.bytes !== spec.count * components * Type.BYTES_PER_ELEMENT) {
      throw new LoadError(`The ${name} buffer of the region meshes is out of bounds.`);
    }
    views[name] = new Type(buffer, spec.offset, spec.count * components);
  }
  const vertices = views.positions.length / 3;
  if (views.normals.length !== views.positions.length || views.region_ids.length !== vertices) {
    throw new LoadError('The region meshes have mismatched buffers.');
  }
  const shell = manifest.shell;
  const regionTriangles = shell.triangles[0];
  const positionAttribute = new THREE.BufferAttribute(views.positions, 3);
  const normalAttribute = new THREE.BufferAttribute(views.normals, 3);
  const regionIdAttribute = new THREE.BufferAttribute(views.region_ids, 1);
  const b = manifest.bounds;
  const center = new THREE.Vector3((b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2);
  const radius = 0.5 * Math.hypot(b[1] - b[0], b[3] - b[2], b[5] - b[4]);
  return {
    manifest,
    key: manifest.key,
    positions: views.positions,
    normals: views.normals,
    indices: views.indices,
    shellEdges: views.shell_edges,
    shellEdgeNormals: views.shell_edge_normals,
    regionIds: views.region_ids,
    regionEdges: views.region_edges,
    regionEdgeNormals: views.region_edge_normals,
    regionCount: manifest.regions.length,
    regionTriangles,
    shellTriangleStart: shell.triangles[0],
    shellTriangles: shell.triangles[1],
    positionAttribute,
    normalAttribute,
    regionIdAttribute,
    boundingSphere: new THREE.Sphere(center, radius),
  };
}

/**
 * Fetch and parse a pair's geometry.
 * @param {{key: string, manifest_url: string, bin_url: string}} ref  scene.geometry
 * @param {(path: string) => Promise<*>} get  JSON for JSON answers, else the Response (api.js)
 */
export async function fetchGeometry(ref, get) {
  if (!ref || !ref.manifest_url || !ref.bin_url) throw new LoadError('This scene has no region meshes.');
  const [manifest, response] = await Promise.all([get(ref.manifest_url), get(ref.bin_url)]);
  if (!response || typeof response.arrayBuffer !== 'function') throw new LoadError('The region meshes could not be read.');
  const buffer = await response.arrayBuffer();
  if (manifest.key !== ref.key) throw new LoadError('The region meshes do not belong to this scene.');
  return parseGeometry(manifest, buffer);
}

/** Throw a LoadError unless `scene` is a static scene the viewer can draw. */
export function checkScene(scene) {
  if (!scene || (scene.schema !== SCENE_SCHEMA && scene.schema !== COMPARE_SCENE_SCHEMA)) {
    throw new LoadError('The scene has an unknown format.');
  }
  if (typeof scene.style?.background !== 'string') throw new LoadError('The scene has no background color.');
  const n = scene.nodes?.acr?.length ?? -1;
  if (n < 0 || scene.nodes.pos.length !== 3 * n || scene.nodes.hemi.length !== n) {
    throw new LoadError('The scene lists its spheres inconsistently.');
  }
  const k = scene.edges?.s?.length ?? -1;
  if (k < 0 || scene.edges.t.length !== k) throw new LoadError('The scene lists its edges inconsistently.');
  for (let i = 0; i < k; i += 1) {
    if (!(scene.edges.s[i] >= 0 && scene.edges.s[i] < n && scene.edges.t[i] >= 0 && scene.edges.t[i] < n)) {
      throw new LoadError('An edge of the scene refers to a sphere it does not have.');
    }
  }
  return scene;
}

/** Throw a LoadError unless `display` is a display packet for `scene`. */
export function checkDisplay(display, scene) {
  const schema = scene.schema === COMPARE_SCENE_SCHEMA ? COMPARE_DISPLAY_SCHEMA : DISPLAY_SCHEMA;
  if (!display || display.schema !== schema) throw new LoadError('The view has an unknown format.');
  const n = scene.nodes.acr.length;
  const k = scene.edges.s.length;
  const nodes = display.nodes;
  const edges = display.edges;
  if (nodes.visible.length !== n || nodes.radius.length !== n || nodes.color.length !== 3 * n || nodes.alpha.length !== n
      || (nodes.pos && nodes.pos.length !== 3 * n) || (nodes.hollow && nodes.hollow.length !== n)) {
    throw new LoadError('The view does not match the scene’s spheres.');
  }
  if (edges.visible.length !== k || edges.width_px.length !== k || edges.color.length !== 3 * k || edges.alpha.length !== k) {
    throw new LoadError('The view does not match the scene’s edges.');
  }
  return display;
}

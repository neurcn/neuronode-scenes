/**
 * Open a sealed web scene (server/seal.py, server/web_share.py) in the browser.
 *
 * The file is MAGIC (8 bytes) | counter block (16) | AES-128-CTR body |
 * HMAC-SHA256 tag (32) over everything before it. The key is the link's
 * fragment, #k=<base64url of 32 bytes>: the AES key, then the HMAC key; it
 * never leaves the browser. WebCrypto checks the tag, then decrypts (counter
 * that block, length 64); DecompressionStream('deflate') inflates the zlib
 * body: u32 little-endian JSON length | the web scene JSON | the mesh blob.
 *
 * Plain ES module; no imports.
 */

export const MAGIC = 'NNSEAL01';
export const KEY_BYTES = 32;
export const SCENE_SCHEMA = 'neuronode.web_scene/1';
const BLOCK = 16;
const TAG_BYTES = 32;

/** A problem the page explains in words: code is no_key, bad_key, not_sealed, wrong_key, bad_scene or newer. */
export class ShareError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ShareError';
    this.code = code;
  }
}

/** What this browser lacks to show a scene, in words, or null. */
export function missingFeatures(win = window) {
  const missing = [];
  let gl = null;
  try {
    gl = win.document.createElement('canvas').getContext('webgl2');
  } catch {
    gl = null;
  }
  if (!gl) missing.push('WebGL 2');
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  if (typeof win.DecompressionStream !== 'function') missing.push('DecompressionStream');
  if (!win.crypto?.subtle) missing.push('Web Crypto (a secure https page)');
  return missing.length ? missing : null;
}

/** The 32-byte key from a location hash ('#k=...'); a ShareError when it is missing or not a key. */
export function keyFromHash(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const text = params.get('k');
  if (!text) throw new ShareError('no_key', 'no key');
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new ShareError('bad_key', 'not base64url');
  let binary;
  try {
    binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  } catch {
    throw new ShareError('bad_key', 'not base64url');
  }
  if (binary.length !== KEY_BYTES) throw new ShareError('bad_key', `a key is ${KEY_BYTES} bytes`);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** The sealed bytes' plain contents; a ShareError when they are not sealed or this key did not seal them. */
export async function openSealed(sealed, key) {
  const bytes = new Uint8Array(sealed);
  const head = MAGIC.length + BLOCK;
  const magic = String.fromCharCode(...bytes.subarray(0, MAGIC.length));
  if (bytes.length < head + TAG_BYTES || magic !== MAGIC) throw new ShareError('not_sealed', 'not a sealed file');
  const subtle = crypto.subtle;
  const macKey = await subtle.importKey('raw', key.slice(BLOCK), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const body = bytes.subarray(0, bytes.length - TAG_BYTES);
  const ok = await subtle.verify('HMAC', macKey, bytes.subarray(bytes.length - TAG_BYTES), body);
  if (!ok) throw new ShareError('wrong_key', 'the key does not open the file');
  const aesKey = await subtle.importKey('raw', key.slice(0, BLOCK), { name: 'AES-CTR' }, false, ['decrypt']);
  const counter = bytes.slice(MAGIC.length, head);
  return subtle.decrypt({ name: 'AES-CTR', counter, length: 64 }, aesKey, body.subarray(head));
}

/** zlib bytes inflated. */
export async function inflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Response(stream).arrayBuffer();
}

/** {packet, blob}: the web scene (with its geometry manifest) and the mesh blob, from the inflated bytes. */
export function unpack(raw) {
  if (raw.byteLength < 4) throw new ShareError('bad_scene', 'too short');
  const n = new DataView(raw).getUint32(0, true);
  if (4 + n > raw.byteLength) throw new ShareError('bad_scene', 'the JSON runs past the end');
  let packet;
  try {
    packet = JSON.parse(new TextDecoder().decode(new Uint8Array(raw, 4, n)));
  } catch {
    throw new ShareError('bad_scene', 'the JSON cannot be read');
  }
  if (packet?.schema !== SCENE_SCHEMA) {
    const newer = typeof packet?.schema === 'string' && packet.schema.startsWith('neuronode.web_scene/');
    throw new ShareError(newer ? 'newer' : 'bad_scene', `schema ${packet?.schema}`);
  }
  return { packet, blob: raw.slice(4 + n) };
}

/** Fetch, check, decrypt and unpack the scene at url with the key in hash. */
export async function loadScene(url, hash, fetcher = fetch) {
  const key = keyFromHash(hash);
  const response = await fetcher(url, { cache: 'no-cache' });
  if (!response.ok) throw new ShareError('missing', `HTTP ${response.status}`);
  const plain = await openSealed(await response.arrayBuffer(), key);
  let raw;
  try {
    raw = await inflate(plain);
  } catch {
    throw new ShareError('bad_scene', 'cannot be inflated');
  }
  return unpack(raw);
}

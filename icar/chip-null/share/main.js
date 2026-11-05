/**
 * The phone page of a web scene (server/web_share.py writes it beside scene.nnw).
 *
 * It checks the browser (WebGL 2, DecompressionStream, Web Crypto), opens
 * scene.nnw with the key in the link's fragment (unseal.js), and draws it
 * with the app's own 3D view (viewer3d/index.js), its meshes answered from
 * the opened file. One finger turns the view, two pinch and pan
 * (viewer3d/camera.js); a tap on a sphere selects it and opens its card. The
 * switches hide the shell, the edges or the labels by drawing the display
 * packet with that layer off; nothing is recomputed. Legend, Table and About
 * open sheets (sheets.js). The view starts, and Reset view returns, at the
 * figure's angle with the brain centered and whole on this screen
 * (camera.js framePose). A missing or wrong key, a missing file or a
 * browser that cannot draw the scene gets a plain message instead.
 *
 * Slice (display.slicing; viewer3d/slicing.js, the app's slab rule): a slab of
 * the brain, axial, coronal or sagittal, seen straight on from the plane's
 * preset, orthographic, with a position and a thickness slider; the phone
 * builds the display packet's slice block itself, so the shell's and the
 * regions' cuts come along. It starts as the exported view was: in Slice view
 * with its plane, position and thickness, or off with the axial plane through
 * the brain's center. Reset view in Slice view goes back to the plane's view.
 *
 * window.__nn = {page: 'share', debug, viewer, state()} for tests;
 * main[data-nn-state] is loading, ready or message.
 */

import { framePose } from '../src/viewer3d/camera.js';
import { createViewer, turnPivot } from '../src/viewer3d/index.js';
import { applyToNodes, edgeFactor, evaluate, label, legendNote, NORMALS, offsetRange, planes, VIEWS }
  from '../src/viewer3d/slicing.js';
import { aboutSheet, cardSheet, legendSheet, tableSheet } from './sheets.js';
import { loadScene, missingFeatures, ShareError } from './unseal.js';

const SCENE_FILE = 'scene.nnw';
// A finger is wider than a mouse pointer: the nearest sphere within twice the app's pick radius is picked.
const TOUCH_PICK_SCALE = 2;
const LAYERS = ['shell', 'edges', 'labels'];
const MESSAGES = {
  no_key: ['This link has no key',
    'Open the scene from its QR code, or copy the whole link, with the part after “#”.'],
  bad_key: ['This link’s key is not complete', 'Copy the whole link, or scan the QR code again.'],
  wrong_key: ['This key does not open this scene',
    'The link may be cut short or belong to another scene. Scan the QR code again.'],
  not_sealed: ['This is not a Neuronode scene', 'The scene file in this folder cannot be read.'],
  missing: ['The scene could not be loaded', 'The scene file is missing or the connection failed. Try again later.'],
  bad_scene: ['The scene could not be read', 'The scene file may be damaged.'],
  newer: ['This scene is too new for this page', 'Export the scene again from Neuronode.'],
  unsupported: ['This browser cannot show the 3D scene', ''],
};

const root = document.querySelector('[data-nn-share]');
const $ = (selector) => root.querySelector(selector);
const view = $('[data-nn-view]');
const sheet = $('[data-nn-sheet]');

function showMessage(code, detail = '') {
  const [title, text] = MESSAGES[code] ?? MESSAGES.missing;
  $('[data-nn-message-title]').textContent = title;
  $('[data-nn-message-text]').textContent = code === 'unsupported'
    ? `It needs ${detail}. Try a current version of Safari, Chrome or Firefox.` : text;
  $('[data-nn-message]').hidden = false;
  root.dataset.nnState = 'message';
  root.dataset.nnMessage = code;
}

function start({ packet, blob }) {
  const scene = packet.scene;
  const base = packet.display;
  scene.style = { ...scene.style, pick_radius_px: Number(scene.style.pick_radius_px) * TOUCH_PICK_SCALE };
  const getGeometry = async (path) => {
    if (path === scene.geometry.manifest_url) return packet.geometry;
    if (path === scene.geometry.bin_url) return { arrayBuffer: async () => blob };
    throw new Error(`This scene has no ${path}.`);
  };
  const cardIndex = new Map(packet.cards.map((card, i) => [`${card.acr}|${card.hemi}`, i]));
  let selected = null; // index into packet.cards
  let sheetKind = null;
  const can = { shell: Boolean(base.shell?.visible), edges: base.edges.visible.some(Boolean), labels: Boolean(base.labels?.enabled) };
  const layers = { ...can };
  const world = scene.world;
  const midline = Number(world.midline_x);
  // Slice view's settings, or null in a scene exported before the phone had it.
  const settings = base.slicing ?? null;
  const slab = settings && {
    plane: settings.on ? settings.plane : 'axial',
    point: settings.on ? settings.point.map(Number) : turnPivot(world, base.hemi_mode),
    offset: settings.on ? Number(settings.offset) : 0,
    thickness: Number(settings.thickness),
    out: settings.out,
    fade: Number(settings.fade),
    floor: Number(settings.floor),
  };
  if (slab) {
    const [low, high] = offsetRange(slab.plane, slab.point, world.bounds);
    slab.offset = Math.max(low, Math.min(high, slab.offset));
  }
  let slicing = Boolean(settings?.on);
  let before = null; // the camera Slice view was turned on from: turning it off goes back there
  let pendingFrame = 0;

  const viewer = createViewer(view, {
    themeRoot: view,
    getGeometry,
    onPick: ({ key }) => select(key ? cardIndex.get(`${key.acr}|${key.hemi}`) ?? null : null),
    onError: (message) => {
      const notice = $('[data-nn-notice]');
      notice.textContent = `The brain surface could not be drawn: ${message}`;
      notice.hidden = false;
    },
  });

  /** The display packet in Slice view, as the app's describe_display builds it (core/slicing.py). */
  function sliced(d) {
    const sl = evaluate(slab, scene.nodes.pos, null, midline);
    const visible = d.nodes.visible.slice();
    const alpha = d.nodes.alpha.slice();
    applyToNodes(sl, visible, alpha);
    const edgeVisible = d.edges.visible.slice();
    const edgeAlpha = d.edges.alpha.slice();
    edgeVisible.forEach((on, k) => {
      if (!on) return;
      const cut = edgeFactor(sl, scene.edges.s[k], scene.edges.t[k]);
      edgeVisible[k] = cut > 0;
      edgeAlpha[k] = cut > 0 ? Math.min(edgeAlpha[k], cut) : 0;
    });
    const where = label(slab, midline, world.center);
    const { normal, point } = planes(slab, midline).L;
    const hidden = Object.fromEntries(Object.entries(d.regions.visible).map(([k, v]) => [k, v.map(() => false)]));
    return {
      ...d,
      nodes: { ...d.nodes, visible, alpha },
      edges: { ...d.edges, visible: edgeVisible, alpha: edgeAlpha },
      regions: { ...d.regions, visible: hidden }, // a slice draws the regions' cuts instead
      figure: { ...d.figure, slice: { plane: slab.plane, normal, point, thickness: slab.thickness }, frozen: true },
      slice: { inside: sl.inside, distance: sl.distance, thickness: slab.thickness, offset: slab.offset, out: slab.out,
        distributed: false, regions: settings.regions, show_regions: settings.show_regions, label: where },
      legend: d.legend && { ...d.legend, slice_note: legendNote(where, slab.thickness, settings.outside) },
    };
  }

  function shown() {
    const d = slicing ? sliced(base) : base;
    return {
      ...d,
      shell: layers.shell ? d.shell : { ...d.shell, visible: false },
      edges: layers.edges ? d.edges : { ...d.edges, visible: d.edges.visible.map(() => false) },
      labels: layers.labels ? d.labels : { ...d.labels, enabled: false },
    };
  }

  function openSheet(kind, title, body) {
    sheetKind = kind;
    sheet.dataset.nnSheet = kind;
    $('[data-nn-sheet-title]').textContent = title;
    $('[data-nn-sheet-body]').replaceChildren(body);
    $('[data-nn-sheet-body]').scrollTop = 0;
    sheet.hidden = false;
    for (const b of root.querySelectorAll('[data-nn-open]')) b.setAttribute('aria-pressed', String(b.dataset.nnOpen === kind));
  }

  function closeSheet() {
    if (sheetKind === 'card') {
      selected = null;
      viewer.setSelection([]);
    }
    sheetKind = null;
    sheet.hidden = true;
    sheet.dataset.nnSheet = '';
    for (const b of root.querySelectorAll('[data-nn-open]')) b.setAttribute('aria-pressed', 'false');
  }

  function select(index) {
    if (index === null || index === undefined) {
      if (sheetKind === 'card') closeSheet();
      return;
    }
    selected = index;
    const card = packet.cards[index];
    viewer.setSelection([{ acr: card.acr, hemi: card.hemi }]);
    openSheet('card', card.acr, cardSheet(card));
  }

  /** A pose's angle with the brain centered and whole on this screen. */
  function showFramed(pose) {
    const aspect = view.clientWidth / Math.max(1, view.clientHeight);
    viewer.presetPose(framePose(pose, world.bounds.map(Number), turnPivot(world, base.hemi_mode),
      Number(world.fov_deg), aspect));
  }

  // The figure's angle with the brain centered and whole on this screen: its pan and zoom were for its own frame.
  function startView() {
    showFramed(world.default_camera);
  }

  /** Reset view: in Slice view the plane seen straight on from its preset (top, anterior, left), else the start. */
  function resetView() {
    if (slicing) showFramed(world.presets[VIEWS[slab.plane]]);
    else startView();
  }

  /** The Slice switch, its panel and sliders as the slab is now. */
  function syncSlice() {
    const button = $('[data-nn-switch="slice"]');
    button.setAttribute('aria-checked', String(slicing));
    button.disabled = !slab;
    $('[data-nn-slice-panel]').hidden = !slicing;
    if (!slab) return;
    for (const b of root.querySelectorAll('[data-nn-plane]')) {
      b.setAttribute('aria-checked', String(b.dataset.nnPlane === slab.plane));
    }
    const [low, high] = offsetRange(slab.plane, slab.point, world.bounds);
    Object.assign($('[data-nn-slice-offset]'), { min: low, max: high, value: slab.offset });
    $('[data-nn-slice-label]').textContent = label(slab, midline, world.center);
    const [thin, thick] = settings.thickness_range;
    Object.assign($('[data-nn-slice-thickness]'), { min: thin, max: thick, value: slab.thickness });
    $('[data-nn-slice-thickness-text]').textContent = `${Math.round(slab.thickness)} µm`;
  }

  /** Draw the slab as it is now, once a frame while a slider moves. */
  function redraw() {
    syncSlice();
    if (pendingFrame) return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = 0;
      viewer.applyDisplay(shown());
    });
  }

  function setSlicing(on) {
    if (!slab || on === slicing) return;
    slicing = on;
    if (on) {
      before = viewer.getCamera();
      $('[data-nn-hint]').hidden = true;
      resetView();
    } else if (before) {
      viewer.presetPose(before);
      before = null;
    }
    redraw();
  }

  /** A plane of the switch: through the brain's center again (offset 0), seen straight on. */
  function setPlane(plane) {
    if (!slicing || !NORMALS[plane] || plane === slab.plane) return;
    Object.assign(slab, { plane, point: turnPivot(world, base.hemi_mode), offset: 0 });
    resetView();
    redraw();
  }

  function setLayer(name, on) {
    if (!can[name]) return;
    layers[name] = Boolean(on);
    $(`[data-nn-layer="${name}"]`).setAttribute('aria-checked', String(layers[name]));
    viewer.applyDisplay(shown());
  }

  const open = {
    legend: () => openSheet('legend', 'Legend', legendSheet(shown().legend)),
    table: () => openSheet('table', 'Table', tableSheet(packet.table, (i) => select(i))),
    about: () => openSheet('about', 'About this scene', aboutSheet(packet)),
  };
  for (const button of root.querySelectorAll('[data-nn-open]')) {
    button.addEventListener('click', () => {
      const kind = button.dataset.nnOpen;
      if (sheetKind === kind) closeSheet();
      else {
        if (sheetKind === 'card') closeSheet();
        open[kind]();
      }
    });
    button.disabled = false;
  }
  for (const name of LAYERS) {
    const button = $(`[data-nn-layer="${name}"]`);
    button.setAttribute('aria-checked', String(layers[name]));
    button.disabled = !can[name];
    button.addEventListener('click', () => setLayer(name, !layers[name]));
  }
  $('[data-nn-action="reset"]').addEventListener('click', resetView);
  $('[data-nn-switch="slice"]').addEventListener('click', () => setSlicing(!slicing));
  for (const b of root.querySelectorAll('[data-nn-plane]')) b.addEventListener('click', () => setPlane(b.dataset.nnPlane));
  $('[data-nn-slice-offset]').addEventListener('input', (event) => {
    slab.offset = Number(event.target.value);
    redraw();
  });
  $('[data-nn-slice-thickness]').addEventListener('input', (event) => {
    slab.thickness = Number(event.target.value);
    redraw();
  });
  syncSlice();
  $('[data-nn-action="reset"]').disabled = false;
  $('[data-nn-close]').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && sheetKind) closeSheet();
  });

  const hint = $('[data-nn-hint]');
  hint.hidden = slicing;
  view.addEventListener('pointerdown', () => { hint.hidden = true; }, { once: true });

  if (packet.title) {
    $('[data-nn-title]').textContent = packet.title;
    document.title = packet.title;
  }
  $('[data-nn-layers]').hidden = false;
  $('[data-nn-message]').hidden = true;
  viewer.loadScene(scene);
  viewer.applyDisplay(shown());
  startView();
  window.__nn = {
    page: 'share',
    viewer,
    debug: viewer.debug,
    state: () => ({ selected, sheet: sheetKind, layers: { ...layers }, can: { ...can },
      slice: slab && { on: slicing, ...slab, point: [...slab.point] } }),
  };
  return viewer.loadGeometry(scene.geometry).then(() => {
    root.dataset.nnState = 'ready';
  });
}

async function boot() {
  // iOS Safari zooms the page on a pinch even where touch-action says no: the view takes pinches itself.
  document.addEventListener('gesturestart', (event) => event.preventDefault());
  window.addEventListener('hashchange', () => window.location.reload());
  const missing = missingFeatures();
  if (missing) {
    showMessage('unsupported', missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}` : missing[0]);
    return;
  }
  let opened;
  try {
    opened = await loadScene(SCENE_FILE, window.location.hash);
  } catch (error) {
    showMessage(error instanceof ShareError ? error.code : 'missing');
    return;
  }
  try {
    await start(opened);
  } catch (error) {
    console.error(error);
    showMessage('bad_scene');
  }
}

boot();

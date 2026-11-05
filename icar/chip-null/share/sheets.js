/**
 * The phone page's sheets, built as plain DOM from the web scene (core/web_share.py):
 * - cardSheet(card): a sphere's card (packet.cards) under its acronym (the
 *   sheet's title), as the app's inspector shows it; its texts are already
 *   rounded, and effect_text, sig_text and
 *   effect_mean_text are null when the scene holds no numbers;
 * - legendSheet(legend): the display packet's legend model (core/legend.py),
 *   as the app's docked legend draws it (nn-legend-dock.js);
 * - tableSheet(table, onNode): the spheres and edges tables (packet.table),
 *   two tabs; a sphere row calls onNode(index);
 * - aboutSheet(packet): the title, the owner's words, what the page shows,
 *   how to move the view and the atlas's citation.
 * Data colors are the packet's, set as CSS custom properties; every other
 * color is a token (tokens.css).
 *
 * Plain ES module; no imports.
 */

const ROLE_CLASS = { increase: 'inc', decrease: 'dec', zero: 'zero' };
export const CCF_CITATION = 'Wang Q, Ding S-L, Li Y, et al. The Allen Mouse Brain Common Coordinate Framework: '
  + 'a 3D reference atlas. Cell 181(4):936–953 (2020). doi:10.1016/j.cell.2020.04.007';
export const HOW_TO = 'Drag with one finger to turn the brain, pinch to zoom, and drag with two fingers to move it. '
  + 'Tap a sphere for its card. Reset view goes back to the figure’s view. Slice shows a slab of the brain, axial, '
  + 'coronal or sagittal: its sliders move it and set its thickness, and one finger then moves the view.';

/** An element: h('p', {class: 'x', data: {nnCard: 'acr'}}, 'text', child, ...). Null and '' children are left out. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'class') el.className = value;
    else if (name === 'data') Object.assign(el.dataset, value);
    else if (name === 'vars') for (const [prop, v] of Object.entries(value)) { if (v) el.style.setProperty(prop, v); }
    else if (name.startsWith('on')) el.addEventListener(name.slice(2), value);
    else el.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === '' || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const dot = (color, cls = 'nn-share-dot') => h('span', { class: cls, 'aria-hidden': 'true', vars: { '--nn-dot': color } });
const roleDot = (role) => (ROLE_CLASS[role]
  ? h('span', { class: `nn-share-dot nn-share-dot--sm nn-share-dot--${ROLE_CLASS[role]}`, 'aria-hidden': 'true' }) : null);

/** A sphere's card. */
export function cardSheet(card) {
  const stats = [h('div', { class: 'nn-share-card__stat' }, h('span', { class: 'nn-share-label' }, 'Degree'),
    h('span', { class: 'nn-share-card__value', data: { nnCard: 'degree' } }, card.degree_text))];
  if (card.effect_mean_text !== null && card.effect_mean_text !== undefined) {
    stats.push(h('div', { class: 'nn-share-card__stat' }, h('span', { class: 'nn-share-label' }, 'Mean effect'),
      h('span', { class: 'nn-share-card__value' }, roleDot(card.effect_mean_role),
        h('span', { data: { nnCard: 'effect_mean' } }, card.effect_mean_text))));
  }
  const edges = card.edges.length ? h('div', { class: 'nn-share-card__section' },
    h('div', { class: 'nn-share-card__edges-head' },
      h('span', { class: 'nn-share-label' }, card.edges_heading),
      h('span', { class: 'nn-share-label', data: { nnCard: 'edges_count' } }, card.edges_count_text)),
    h('ul', { class: 'nn-share-card__edges' }, card.edges.map((e) => h('li', { class: 'nn-share-card__edge', data: { nnCardEdge: e.edge } },
      h('span', { class: `nn-share-swatch${ROLE_CLASS[e.role] ? ` nn-share-swatch--${ROLE_CLASS[e.role]}` : ''}`, 'aria-hidden': 'true' }),
      h('span', { class: 'nn-share-card__partner' }, e.partner),
      e.effect_text !== null ? h('span', { class: 'nn-share-card__num' }, e.effect_text) : null,
      e.sig_text !== null ? h('span', { class: 'nn-share-card__num nn-share-card__sig' }, e.sig_text) : null))))
    : h('p', { class: 'nn-share-note', data: { nnCard: 'edges_count' } }, `${card.edges_count_text} shown here`);
  return h('div', { class: 'nn-share-card', data: { nnCardKey: `${card.acr}|${card.hemi}` } },
    h('p', { class: 'nn-share-card__name', data: { nnCard: 'title' } }, card.title),
    h('div', { class: 'nn-share-card__meta' }, dot(card.division_color),
      h('span', { data: { nnCard: 'division' } }, card.division),
      card.group ? h('span', { class: 'nn-share-sep', 'aria-hidden': 'true' }, '·') : null,
      card.group ? h('span', { data: { nnCard: 'group' } }, card.group) : null),
    h('div', { class: 'nn-share-card__section' },
      h('div', { class: 'nn-share-card__stats' }, stats),
      card.degree_detail ? h('p', { class: 'nn-share-note' }, card.degree_detail) : null,
      card.scope_text ? h('p', { class: 'nn-share-note' }, card.scope_text) : null),
    edges);
}

/** The ramp as a CSS gradient from the server's stops [[position 0..1, '#RRGGBB'], ...]. */
function rampGradient(ramp) {
  if (!Array.isArray(ramp) || !ramp.length) return null;
  return `linear-gradient(90deg, ${ramp.map(([pos, hex]) => `${hex} ${Number(pos) * 100}%`).join(', ')})`;
}

/** An edge row's swatch: its color, with its alpha when the edges it names are drawn faded. */
function faded(row) {
  if (row.alpha === null || row.alpha === undefined) return row.color;
  const a = Math.round(Math.min(Math.max(Number(row.alpha), 0), 1) * 255);
  return `${row.color}${a.toString(16).padStart(2, '0')}`;
}

const text = (value, cls = 'nn-share-legend__sub', tag = 'p') => (value === null || value === undefined || value === ''
  ? null : h(tag, { class: cls, data: { nnLegendText: '' } }, value));

function colorBlock(color) {
  const head = text(color.heading, 'nn-share-legend__title', 'h4');
  if (color.kind === 'delta' || color.kind === 'agreement') {
    const [lo, mid, hi] = color.ends || [];
    const [decrease, increase] = color.end_labels || [];
    return h('div', { class: 'nn-share-legend__block', data: { nnLegendBlock: 'color' } }, head,
      h('div', { class: 'nn-share-legend__ramp', 'aria-hidden': 'true', vars: { '--nn-ramp': rampGradient(color.ramp) } }),
      h('div', { class: 'nn-share-legend__ends' }, text(lo, '', 'span'), text(mid, '', 'span'), text(hi, '', 'span')),
      h('div', { class: 'nn-share-legend__ends' }, text(decrease, '', 'span'), text(increase, '', 'span')),
      (color.lines || []).map((line) => text(line)),
      color.no_edges ? h('div', { class: 'nn-share-legend__item' }, dot(color.no_edges.color), text(color.no_edges.label, '', 'span'))
        : null);
  }
  return h('div', { class: 'nn-share-legend__block', data: { nnLegendBlock: 'color' } }, head,
    h('ul', { class: 'nn-share-legend__swatches' }, (color.entries || []).map((entry) => h('li', { class: 'nn-share-legend__item' },
      dot(entry.color), text(entry.label, '', 'span')))));
}

function sizeBlock(size) {
  if (!size) return null;
  return h('div', { class: 'nn-share-legend__block', data: { nnLegendBlock: 'size' } },
    text(size.heading, 'nn-share-legend__title', 'h4'),
    h('div', { class: 'nn-share-legend__glyphs' },
      ['sm', 'md', 'lg'].map((s) => h('span', { class: `nn-share-legend__glyph nn-share-legend__glyph--${s}`, 'aria-hidden': 'true' })),
      text(size.range, '', 'span')),
    text(size.rule), text(size.multiplier_note));
}

function edgesBlock(edges) {
  if (!edges) return null;
  return h('div', { class: 'nn-share-legend__block', data: { nnLegendBlock: 'edges' } },
    text(edges.heading, 'nn-share-legend__title', 'h4'),
    h('ul', { class: 'nn-share-legend__rows' }, (edges.rows || []).map((row) => h('li', { class: 'nn-share-legend__item', data: { nnLegendEdge: row.role } },
      h('span', { class: 'nn-share-swatch nn-share-swatch--wide', 'aria-hidden': 'true', vars: { '--nn-swatch': faded(row) } }),
      text(row.label, '', 'span')))),
    text(edges.width_note), text(edges.exponent_note), text(edges.opacity_note), text(edges.paths_note));
}

function stylesBlock(styles) {
  if (!styles?.length) return null;
  return h('div', { class: 'nn-share-legend__block', data: { nnLegendBlock: 'styles' } },
    h('ul', { class: 'nn-share-legend__rows' }, styles.map((row) => h('li', { class: 'nn-share-legend__item' },
      h('span', { class: 'nn-share-legend__style', 'aria-hidden': 'true', vars: { '--nn-dot': row.fill, '--nn-ring': row.outline } }),
      text(row.label, '', 'span')))));
}

/** The legend model, block by block, as the app's docked legend draws it. */
export function legendSheet(legend) {
  if (!legend) return h('p', { class: 'nn-share-note' }, 'This scene has no legend.');
  return h('div', { class: 'nn-share-legend', data: { nnLegend: legend.color?.kind ?? '' } },
    text(legend.title, 'nn-share-legend__caption', 'h3'),
    colorBlock(legend.color || {}), stylesBlock(legend.styles), sizeBlock(legend.node_size), edgesBlock(legend.edges),
    text(legend.hemisphere_note, 'nn-share-legend__note'), text(legend.slice_note, 'nn-share-legend__note'),
    text(legend.moved_note, 'nn-share-legend__note'));
}

function tableOf(block, onRow) {
  return h('table', { class: 'nn-share-table' },
    h('thead', {}, h('tr', {}, block.columns.map((c) => h('th', { scope: 'col' }, c)))),
    h('tbody', {}, block.rows.map((row, i) => h('tr', onRow ? { data: { nnRow: i }, tabindex: 0, class: 'is-link',
      onclick: () => onRow(i), onkeydown: (e) => { if (e.key === 'Enter') onRow(i); } } : {},
    row.map((cell) => h('td', {}, cell))))));
}

/** The spheres and edges tables, as two tabs; a sphere row calls onNode(index into packet.cards). */
export function tableSheet(table, onNode) {
  const body = h('div', { class: 'nn-share-table__body' });
  const tabs = [['nodes', `Spheres (${table.nodes.rows.length})`], ['edges', `Edges (${table.edges.rows.length})`]];
  const buttons = tabs.map(([id, label]) => h('button', { type: 'button', class: 'nn-share-tab', role: 'tab', data: { nnTab: id },
    onclick: () => show(id) }, label));
  function show(id) {
    for (const b of buttons) b.setAttribute('aria-selected', String(b.dataset.nnTab === id));
    body.replaceChildren(id === 'nodes' ? tableOf(table.nodes, onNode) : tableOf(table.edges, null));
  }
  show('nodes');
  return h('div', { class: 'nn-share-tables' }, h('div', { class: 'nn-share-tabs', role: 'tablist' }, buttons),
    h('p', { class: 'nn-share-note' }, 'Tap a sphere’s row to select it in the view.'), body);
}

/** The page's About: the owner's title and words, what is shown, how to move the view, the atlas. */
export function aboutSheet(packet) {
  const spheres = packet.cards.length;
  const edges = new Set(packet.scene.edges.edge_id).size;
  const atlas = packet.scene.dataset.atlas;
  const paragraphs = String(packet.about || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  return h('div', { class: 'nn-share-about' },
    packet.title ? h('h3', { class: 'nn-share-about__title', data: { nnAbout: 'title' } }, packet.title) : null,
    paragraphs.map((p) => h('p', { data: { nnAbout: 'about' } }, p)),
    h('p', { class: 'nn-share-note', data: { nnAbout: 'shown' } },
      `Shown: ${spheres} ${spheres === 1 ? 'sphere' : 'spheres'} and ${edges} ${edges === 1 ? 'edge' : 'edges'} from the figure’s view. `
      + (packet.detail === 'no_numbers' ? 'This page shows no effect sizes or p values.'
        : 'Effect sizes and p values are rounded.')),
    h('h4', { class: 'nn-share-label' }, 'Moving the view'),
    h('p', {}, HOW_TO),
    h('h4', { class: 'nn-share-label' }, 'Atlas'),
    h('p', {}, 'Brain regions and the brain surface: the Allen Mouse Brain Common Coordinate Framework, version 3 (CCFv3)'
      + (atlas?.name ? `, ${atlas.name}${atlas.version ? ` ${atlas.version}` : ''}.` : '.')),
    h('p', { class: 'nn-share-cite', data: { nnAbout: 'citation' } }, CCF_CITATION),
    h('p', { class: 'nn-share-note' }, 'Made with Neuronode. The key in this link opens the scene in your browser and is never '
      + 'sent to the server.'));
}

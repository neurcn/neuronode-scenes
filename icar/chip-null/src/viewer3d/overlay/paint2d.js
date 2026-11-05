/**
 * The one painter of the 2D overlay (plan 3.8 viewer3d/overlay/paint2d.js):
 * it paints a display list from overlay/layout.js on the live overlay canvas,
 * and later into screenshots and video frames, so captures equal the screen.
 * Sizes in the list are CSS px; `scale` turns them into the target's pixels
 * (the device pixel ratio on screen; an export also multiplies by k, D45).
 *
 * Colors and fonts are design tokens (tokens.css), read once by readPalette()
 * from the view's element, so they follow its background theme (the light
 * figure block under [data-fig-theme="light"]): marker letters --fig-text, the
 * marker's axes --fig-axis, the glow, ring, tag text and scale bar --fig-mark,
 * the tag --fig-fill with a --fig-border edge, a comparison's hollow sphere
 * (D46) --c-one-dataset. A label inside its sphere is --fig-label-dark on a
 * light fill and --fig-label-light on a dark one; a fixed-size label is
 * --fig-text with a --fig-fill halo.
 * The legend item (overlay/furniture.js, G2) carries the page's own computed
 * colors, so it is painted as the page drew it. Its place is anchored at the
 * bottom left of the frame: `height` (the frame's CSS height) places it.
 *
 * Plain ES module; no imports.
 */

/**
 * The overlay's colors and font families from the design tokens.
 * @param {Element} [element]  an element the tokens apply to
 */
export function readPalette(element = document.documentElement) {
  const css = getComputedStyle(element);
  const token = (name) => css.getPropertyValue(name).trim();
  return {
    text: token('--fig-text'),
    axis: token('--fig-axis'),
    lock: token('--fig-lock'),
    mark: token('--fig-mark'),
    labelDark: token('--fig-label-dark'),
    labelLight: token('--fig-label-light'),
    fill: token('--fig-fill'),
    border: token('--fig-border'),
    oneDataset: token('--c-one-dataset'),
    sans: token('--font-sans'),
    mono: token('--font-mono'),
  };
}

/** A CSS font string for {px, mono, weight}. */
export function fontOf(palette, { px, mono = false, weight = 400 }) {
  return `${weight} ${px}px ${mono ? palette.mono : palette.sans}`;
}

/**
 * A text measurer for layout.js, using a 2D context.
 * @param {CanvasRenderingContext2D} ctx
 */
export function createMeasure(ctx, palette) {
  const cache = new Map();
  return (text, font) => {
    const key = `${font.mono ? 'm' : 's'}${font.weight}|${text}`;
    let em = cache.get(key);
    if (em === undefined) {
      ctx.save();
      ctx.font = fontOf(palette, { ...font, px: 100 });
      em = ctx.measureText(text).width / 100;
      ctx.restore();
      cache.set(key, em);
    }
    return em * font.px;
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.rect(x, y, w, h);
  }
}

/** Paint a furniture legend item (overlay/furniture.js) with its top left at (x, y) CSS px. */
function paintLegend(ctx, item, x, y) {
  for (const part of item.parts) {
    const px = x + part.x;
    const py = y + part.y;
    ctx.globalAlpha = 1;
    switch (part.type) {
      case 'rect': {
        if (part.fill) {
          ctx.fillStyle = part.fill;
          roundRect(ctx, px, py, part.w, part.h, part.radius);
          ctx.fill();
        }
        if (part.stroke && part.lineWidth > 0) {
          const half = part.lineWidth / 2;
          ctx.strokeStyle = part.stroke;
          ctx.lineWidth = part.lineWidth;
          roundRect(ctx, px + half, py + half, part.w - part.lineWidth, part.h - part.lineWidth,
            Math.max(0, part.radius - half));
          ctx.stroke();
        }
        break;
      }
      case 'gradient': {
        const gradient = ctx.createLinearGradient(px, 0, px + part.w, 0);
        for (const [at, color] of part.stops) gradient.addColorStop(Math.min(1, Math.max(0, at)), color);
        ctx.fillStyle = gradient;
        roundRect(ctx, px, py, part.w, part.h, part.radius);
        ctx.fill();
        break;
      }
      case 'path': {
        ctx.save();
        ctx.translate(px, py);
        ctx.scale(part.sx, part.sy);
        ctx.fillStyle = part.fill;
        ctx.fill(new Path2D(part.d));
        ctx.restore();
        break;
      }
      case 'text':
        ctx.fillStyle = part.color;
        ctx.font = part.font;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(part.text, px, py);
        break;
      default:
        break;
    }
  }
}

/**
 * Paint `items` on ctx (cleared first unless clear is false).
 * @param {CanvasRenderingContext2D} ctx
 * @param {object[]} items  layoutOverlay().items, plus furniture items (overlay/furniture.js)
 * @param {{scale: number, palette: object, clear?: boolean, height?: number, offsetX?: number,
 *          offsetY?: number}} options
 *   height: the frame's CSS height (places a legend item; default the canvas's height / scale);
 *   offsetX, offsetY: CSS px of the frame at the canvas's top left (a tile or band of an export)
 */
export function paintOverlay(ctx, items, { scale, palette, clear = true, height, offsetX = 0, offsetY = 0 }) {
  const canvas = ctx.canvas;
  ctx.save();
  if (clear) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  ctx.setTransform(scale, 0, 0, scale, -offsetX * scale, -offsetY * scale);
  ctx.textBaseline = 'alphabetic';
  const frameHeight = height ?? canvas.height / scale;
  for (const item of items) {
    switch (item.kind) {
      case 'legend':
        paintLegend(ctx, item, item.left, frameHeight - item.bottom);
        break;
      case 'glow':
        ctx.globalAlpha = item.alpha;
        ctx.fillStyle = palette.mark;
        ctx.beginPath();
        ctx.arc(item.x, item.y, item.r, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'label':
        if (item.alpha <= 0) break;
        ctx.globalAlpha = item.alpha;
        ctx.font = fontOf(palette, { px: item.px, weight: 600 });
        ctx.textAlign = 'center';
        if (item.halo) {
          ctx.lineJoin = 'round';
          ctx.lineWidth = Math.max(2, item.px * 0.24);
          ctx.strokeStyle = palette.fill;
          ctx.strokeText(item.text, item.x, item.y);
          ctx.fillStyle = palette.text;
        } else {
          ctx.fillStyle = item.dark ? palette.labelDark : palette.labelLight;
        }
        ctx.fillText(item.text, item.x, item.y);
        break;
      case 'hollow':
        if (item.alpha <= 0) break;
        ctx.globalAlpha = item.alpha;
        ctx.strokeStyle = palette.oneDataset;
        ctx.lineWidth = item.lineWidth;
        ctx.beginPath();
        ctx.arc(item.x, item.y, Math.max(0, item.r - item.lineWidth / 2), 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'ring':
        ctx.globalAlpha = 1;
        ctx.strokeStyle = palette.mark;
        ctx.lineWidth = item.lineWidth;
        ctx.beginPath();
        ctx.arc(item.x, item.y, item.r, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'tag':
        ctx.globalAlpha = 1;
        ctx.fillStyle = palette.fill;
        ctx.strokeStyle = palette.border;
        ctx.lineWidth = 1;
        roundRect(ctx, item.x + 0.5, item.y + 0.5, item.width - 1, item.height - 1, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = palette.mark;
        ctx.font = fontOf(palette, { px: 12, mono: true, weight: 500 });
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(item.text, item.x + 7, item.y + item.height / 2 + 0.5);
        ctx.textBaseline = 'alphabetic';
        break;
      case 'scalebar': {
        ctx.globalAlpha = 1;
        ctx.fillStyle = palette.mark;
        const w = item.x1 - item.x0;
        ctx.fillRect(item.x0, item.top + 4, w, 2);           // the rule
        ctx.fillRect(item.x0, item.top, 2, 10);              // end ticks
        ctx.fillRect(item.x1 - 2, item.top, 2, 10);
        ctx.font = fontOf(palette, { px: 12, mono: true, weight: 400 });
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(item.text, item.labelX, item.labelY);
        ctx.textBaseline = 'alphabetic';
        break;
      }
      case 'title': {
        ctx.globalAlpha = 1;
        ctx.fillStyle = palette.text;
        ctx.font = fontOf(palette, { px: item.px, mono: false, weight: 600 });
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(item.text, item.x, item.y);
        break;
      }
      case 'marker': {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = palette.axis;
        ctx.lineWidth = 1.5;
        ctx.lineCap = 'round';
        for (const a of item.axes) {
          ctx.strokeStyle = a.locked ? palette.lock : palette.axis;
          ctx.lineWidth = a.locked ? 2.5 : 1.5;
          ctx.beginPath();
          ctx.moveTo(item.x, item.y);
          ctx.lineTo(a.x1, a.y1);
          ctx.stroke();
        }
        ctx.fillStyle = palette.axis;
        ctx.beginPath();
        ctx.arc(item.x, item.y, 1.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = palette.text;
        ctx.font = fontOf(palette, { px: 12, mono: true, weight: 500 });
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const a of item.axes) {
          ctx.fillStyle = a.locked ? palette.lock : palette.text;
          ctx.fillText(a.letter, a.lx, a.ly);
        }
        ctx.textBaseline = 'alphabetic';
        break;
      }
      default:
        break;
    }
  }
  ctx.restore();
}

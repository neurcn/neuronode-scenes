/**
 * Screenshots and video frames (plan 3.8 viewer3d/capture/png.js; inventory G1).
 *
 * A capture is the 3D view's drawing buffer with the 2D overlay painted over
 * it by the same painter as the screen (overlay/paint2d.js): labels, hover
 * glow, selection ring and tag, orientation marker and scale bar. Nothing of
 * the page around the view (bar, rail, sheet, inspector, legend card, toasts)
 * is in it. At the viewport's size the picture equals the screen in device
 * pixels; a larger export would scale every CSS px size by k (D45, P8).
 *
 * compositeFrame() paints one frame into a 2D context: call it in the same
 * task as the 3D render (the WebGL canvas keeps no drawing buffer between
 * frames). pngBlob() encodes a canvas as PNG. The 3D view (index.js) uses
 * both for capturePng(); capture/video.js uses compositeFrame for each frame.
 *
 * Plain ES module; imports only the overlay painter.
 */

import { paintOverlay } from '../overlay/paint2d.js';

/**
 * Paint the 3D canvas, then the overlay items, into ctx (its whole canvas).
 * @param {CanvasRenderingContext2D} ctx      the target; its canvas has the frame's size in device px
 * @param {HTMLCanvasElement} glCanvas         the 3D view's canvas, just drawn
 * @param {object[]} items                     overlay/layout.js display list (CSS px of the view)
 * @param {{scale: number, palette: object, under?: string|null}} options  device px per CSS px; the
 *        overlay's tokens; under: a color painted first, for a transparent view in an opaque frame (a video)
 */
export function compositeFrame(ctx, glCanvas, items, { scale, palette, under = null }) {
  const { width, height } = ctx.canvas;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  if (under) {
    ctx.globalCompositeOperation = 'copy';
    ctx.fillStyle = under;
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';
  } else {
    ctx.globalCompositeOperation = 'copy'; // the 3D picture replaces whatever the canvas held, alpha included
  }
  ctx.drawImage(glCanvas, 0, 0, width, height);
  ctx.restore();
  paintOverlay(ctx, items, { scale, palette, clear: false });
}

/**
 * A PNG of the canvas.
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Blob>}
 */
export function pngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('The picture could not be encoded as PNG.'));
    }, 'image/png');
  });
}

/**
 * A new canvas of width x height device px holding one composited frame; alpha: keep the view's
 * transparency (a transparent background).
 * @returns {HTMLCanvasElement}
 */
export function frameCanvas(glCanvas, items, { width, height, scale, palette, alpha = false }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha });
  compositeFrame(ctx, glCanvas, items, { scale, palette });
  return canvas;
}

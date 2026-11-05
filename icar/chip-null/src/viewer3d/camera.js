/**
 * The camera of the 3D view (plan D27, 3.8 viewer3d/camera.js): our own
 * VTK-style trackball, not a three.js controls addon.
 *
 * A pose is {position, focal_point, view_up} in world µm, as core/camera.py
 * and the view state hold it. The motion is the old version's (render/viewer.py
 * in the qt-final tag, with VTK's vtkInteractorStyleTrackballCamera, MotionFactor 10):
 * - left drag rotates: Azimuth(-200° x dx / width) about the view-up and
 *   Elevation(-200° x dy / height) about the camera's right axis, then
 *   OrthogonalizeViewUp. The view-up is re-made orthogonal after every step,
 *   so a drag passes over the poles without the view flipping (inventory E16);
 * - every turn pivots on the center of what the view shows (setPivot), not on
 *   the focal point as VTK's does: the whole camera (position, focal point and
 *   view-up) turns about the pivot (turnPose), so the brain spins in place and
 *   a pan or a zoom is kept. A pivot at the focal point (a whole-brain view
 *   with no pan) gives VTK's turns;
 * - right (or middle) drag pans in the screen plane. Today's app moves the
 *   focal point by the mouse's logical pixels taken as device pixels, so the
 *   scene follows the mouse at 1 / devicePixelRatio of its speed (half on a
 *   Retina display); PAN_FOLLOW keeps that feel;
 * - the wheel and pinch drive today's smooth dolly: each notch adds to a drive
 *   that decays (tau 0.26 s), a velocity follows it (tau 0.11 s), and the
 *   camera dollies by exp(velocity x dt), at most 0.06 per 8 ms;
 * - Spin turns the camera about the view-up at 12°/s (Azimuth), and stops at a
 *   drag, a preset or a reset (D7, inventory E15);
 * - Slice view (setRotate(false)): a left drag pans as a right drag does, Spin
 *   holds still, and Shift+scroll goes to onSliceStep(notches) instead of the
 *   zoom (Shift turns a mouse wheel's deltaY into deltaX on macOS, so either
 *   counts);
 * - an axis lock (a click on a letter of the orientation marker; lock()):
 *   a left drag turns the camera about that world axis through the pivot, by
 *   the drag across the axis's line on screen (axisRotate), and Spin turns
 *   about it too;
 * - touch (pointerType 'touch', the phone page): one finger rotates as a left
 *   drag does once it moves past TOUCH_TAP_TOLERANCE_PX (less is a tap, a
 *   click); two fingers pinch to dolly and move together to pan, the scene
 *   following the fingers; after a pinch the finger left down does nothing
 *   until every finger is up. A finger whose lift was lost (its capture
 *   taken, or still listed when a new gesture starts) is forgotten. Mouse and
 *   trackpad input is unchanged;
 * - presets and the start camera come from the scene (core/camera.py):
 *   world.presets and world.default_camera; fit() keeps the direction and
 *   moves to VTK's ResetCamera distance for the scene's bounding sphere.
 * The projection is perspective, or orthographic (display.figure.projection):
 * then applyToThree gives the frustum the height the perspective view has at
 * the focal point (2 d tan(fov / 2)), so switching keeps the framing there and
 * a dolly still zooms; every depth is drawn at that scale.
 *
 * The pose math is pure (plain arrays, float64) and exported for tests; the
 * controller attaches pointer and wheel listeners to an element.
 *
 * Plain ES module: imports three only.
 */

import * as THREE from 'three';

export const MOTION_FACTOR = 10;          // vtkInteractorStyleTrackballCamera's default
export const CLICK_TOLERANCE_PX = 4;      // viewer.py _CLICK_MOVE_TOLERANCE_PX: a click moves at most this far
export const RIGHT_CLICK_TOLERANCE_PX = 3; // viewer.py: a right press that moves 3 px or more is a pan
export const TOUCH_TAP_TOLERANCE_PX = 10; // a finger wobbles more than a mouse: a tap moves at most this far
export const SPIN_DEG_PER_SEC = 12;       // viewer.py orbit_deg_per_sec
export const FRAME_MARGIN = 1.1;          // framePose: a tenth of the view to spare around the brain
export const ZOOM = {
  notch: 1.4,            // drive added per wheel notch (viewer.py _queue_smooth_zoom)
  driveMax: 40,
  driveTau: 0.26,        // s
  velocityGain: 0.33,
  velocityTau: 0.11,     // s
  stepPer8ms: 0.06,      // largest log-dolly step in today's 8 ms timer tick
  pixelsPerNotch: 60,    // Qt pixelDelta / 60 (trackpads)
  stop: 1e-3,
};

// ------------------------------------------------------------------ vector helpers (plain arrays)
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
function unit(a) {
  const n = norm(a);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
}

/** Rotate vector v by `deg` degrees about the unit axis (right-hand rule; Rodrigues). */
export function rotate(v, axis, deg) {
  const k = unit(axis);
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}

/** A copy of a pose with plain number arrays. */
export function copyPose(pose) {
  return {
    position: [...pose.position].map(Number),
    focal_point: [...pose.focal_point].map(Number),
    view_up: [...pose.view_up].map(Number),
  };
}

/**
 * The camera frame as VTK's view transform has it: vpn points from the focal
 * point to the camera, right = viewUp x vpn, up = vpn x right (all unit).
 */
export function frame(pose) {
  const vpn = unit(sub(pose.position, pose.focal_point));
  const right = unit(cross(pose.view_up, vpn));
  const up = cross(vpn, right);
  return { vpn, right, up, distance: norm(sub(pose.position, pose.focal_point)) };
}

/** vtkCamera::Azimuth: rotate the position about the view-up through the focal point. */
export function azimuth(pose, deg) {
  const offset = rotate(sub(pose.position, pose.focal_point), pose.view_up, deg);
  return { ...copyPose(pose), position: add(pose.focal_point, offset) };
}

/**
 * vtkCamera::Elevation: rotate the position about minus the camera's right
 * axis through the focal point; the view-up is kept (OrthogonalizeViewUp
 * follows in the trackball).
 */
export function elevation(pose, deg) {
  const { right } = frame(pose);
  const offset = rotate(sub(pose.position, pose.focal_point), scale(right, -1), deg);
  return { ...copyPose(pose), position: add(pose.focal_point, offset) };
}

/** vtkCamera::OrthogonalizeViewUp: the view-up becomes the second row of the view matrix. */
export function orthogonalizeViewUp(pose) {
  return { ...copyPose(pose), view_up: frame(pose).up };
}

/** vtkCamera::Dolly: divide the distance to the focal point by factor (> 1 moves closer). */
export function dolly(pose, factor) {
  if (!(factor > 0)) return copyPose(pose);
  const { vpn, distance } = frame(pose);
  return { ...copyPose(pose), position: add(pose.focal_point, scale(vpn, distance / factor)) };
}

/** World µm per CSS pixel at the focal plane, for a viewport `height` CSS px tall. */
export function umPerPixel(pose, height, fovDeg) {
  const { distance } = frame(pose);
  return (2 * distance * Math.tan((fovDeg * Math.PI) / 360)) / Math.max(1, height);
}

/**
 * Move the camera and the focal point in the screen plane so the focal plane
 * moves by (dx right, dy down) CSS pixels times `follow`.
 */
export function pan(pose, dx, dy, height, fovDeg, follow = 1) {
  const { right, up } = frame(pose);
  const s = umPerPixel(pose, height, fovDeg) * follow;
  const shift = add(scale(right, -dx * s), scale(up, dy * s));
  return {
    position: add(pose.position, shift),
    focal_point: add(pose.focal_point, shift),
    view_up: [...pose.view_up],
  };
}

/**
 * The whole camera turned by `deg` about the axis through `pivot` (right-hand rule): the position, the focal point
 * and the view-up turn together, so a point at the pivot keeps its place on screen. About the view-up through the
 * focal point this is Azimuth.
 */
export function turnPose(pose, axis, deg, pivot = pose.focal_point) {
  const about = (p) => add(pivot, rotate(sub(p, pivot), axis, deg));
  return { position: about(pose.position), focal_point: about(pose.focal_point), view_up: rotate(pose.view_up, axis, deg) };
}

/**
 * One trackball step for a drag of (dx right, dy down) CSS px in a width x height viewport, about axes through
 * `pivot` (the focal point by default: VTK's Azimuth, Elevation and OrthogonalizeViewUp).
 */
export function trackballRotate(pose, dx, dy, width, height, motionFactor = MOTION_FACTOR, pivot = pose.focal_point) {
  const azimuthDeg = dx * (-20 / Math.max(1, width)) * motionFactor;
  const elevationDeg = -dy * (-20 / Math.max(1, height)) * motionFactor; // VTK's display y points up
  const turned = turnPose(pose, pose.view_up, azimuthDeg, pivot);
  return orthogonalizeViewUp(turnPose(turned, scale(frame(turned).right, -1), elevationDeg, pivot));
}

export const WORLD_AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** The pose turned by `deg` about a world axis through `pivot` (the focal point by default). */
export function turnAbout(pose, axis, deg, pivot = pose.focal_point) {
  return orthogonalizeViewUp(turnPose(pose, axis, deg, pivot));
}

/**
 * One locked step: a drag of (dx right, dy down) CSS px turns the camera about the world axis by the drag's part
 * across the axis's line on screen, at the trackball's rate (about the view-up this is the trackball's azimuth).
 * An axis that points at the viewer turns with a sideways drag.
 */
export function axisRotate(pose, axis, dx, dy, width, height, motionFactor = MOTION_FACTOR, pivot = pose.focal_point) {
  const { right } = frame(pose);
  const up = unit(pose.view_up);
  const sx = dot(axis, right);
  const sy = -dot(axis, up);
  const len = Math.hypot(sx, sy);
  const across = len > 0.2 ? (-sy * dx + sx * dy) / len : dx;
  return turnAbout(pose, axis, across * (-20 / Math.max(1, width)) * motionFactor, pivot);
}

/**
 * VTK's ResetCamera for a bounding sphere: keep the direction and the view-up,
 * put the focal point at the center and the camera where the sphere fits the
 * vertical view angle.
 */
export function fitPose(pose, center, radius, fovDeg) {
  const { vpn } = frame(pose);
  const distance = radius / Math.sin((fovDeg * Math.PI) / 360);
  return { position: add(center, scale(vpn, distance)), focal_point: [...center], view_up: [...pose.view_up] };
}

/**
 * The pose's direction and view-up, centered on `center`, at the distance where the box `bounds` ([xmin, xmax,
 * ymin, ymax, zmin, zmax], taken about `center`) fits a view `aspect` (width / height) wide, `margin` to spare: a
 * phone's start view (web/share/), whatever pan and zoom the figure had in its own frame.
 */
export function framePose(pose, bounds, center, fovDeg, aspect, margin = FRAME_MARGIN) {
  const { vpn, right, up } = frame(pose);
  const half = [0, 1, 2].map((i) => Math.max(Math.abs(bounds[2 * i] - center[i]),
    Math.abs(bounds[2 * i + 1] - center[i])));
  const reach = (axis) => half.reduce((sum, h, i) => sum + h * Math.abs(axis[i]), 0);
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const distance = reach(vpn) + margin * Math.max(reach(up) / tanV, reach(right) / (tanV * aspect));
  return { position: add(center, scale(vpn, distance)), focal_point: [...center], view_up: [...pose.view_up] };
}

/** Largest absolute difference between two poses' numbers. */
export function poseDifference(a, b) {
  let worst = 0;
  for (const key of ['position', 'focal_point', 'view_up']) {
    for (let i = 0; i < 3; i += 1) worst = Math.max(worst, Math.abs(a[key][i] - b[key][i]));
  }
  return worst;
}

/** The wheel delta in notches: pixels / 60 (trackpads), lines / 3, pages x 1; forward (away) is positive. */
export function wheelNotches(event) {
  const d = Number(event.deltaY) || 0;
  if (event.deltaMode === 1) return -d / 3;
  if (event.deltaMode === 2) return -d;
  return -d / ZOOM.pixelsPerNotch;
}

/**
 * The smooth dolly of today's viewer (viewer.py _queue_smooth_zoom and
 * _on_smooth_zoom_step), stepped by real elapsed time.
 */
export function createSmoothZoom() {
  let drive = 0;
  let velocity = 0;
  return {
    /** Add wheel notches (positive: closer). */
    push(notches) {
      drive = Math.max(-ZOOM.driveMax, Math.min(ZOOM.driveMax, drive + notches * ZOOM.notch));
    },
    /** Advance by dt seconds; returns the dolly factor for this step (1 = none). */
    step(dtSeconds) {
      const dt = Math.max(1e-4, Math.min(0.05, dtSeconds));
      drive *= Math.exp(-dt / ZOOM.driveTau);
      const target = drive * ZOOM.velocityGain;
      velocity += (target - velocity) * (1 - Math.exp(-dt / ZOOM.velocityTau));
      if (Math.abs(drive) < ZOOM.stop && Math.abs(velocity) < ZOOM.stop) {
        drive = 0;
        velocity = 0;
        return 1;
      }
      const limit = ZOOM.stepPer8ms * (dt / 0.008);
      const step = Math.max(-limit, Math.min(limit, velocity * dt));
      return Math.exp(step);
    },
    get active() {
      return drive !== 0 || velocity !== 0;
    },
    stop() {
      drive = 0;
      velocity = 0;
    },
  };
}

/**
 * Apply a pose to a three.js PerspectiveCamera or OrthographicCamera, with near and far planes that
 * hold the scene's bounding sphere (center, radius), as VTK's
 * ResetCameraClippingRange does before each render.
 */
export function applyToThree(camera, pose, { aspect, fovDeg, center, radius }) {
  camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
  camera.up.set(pose.view_up[0], pose.view_up[1], pose.view_up[2]);
  camera.lookAt(pose.focal_point[0], pose.focal_point[1], pose.focal_point[2]);
  const { vpn } = frame(pose);
  // Depth of the sphere's center along the view direction; the sphere spans +-radius around it.
  const depth = -dot(sub(center, pose.position), vpn);
  const r = radius * 1.02;
  if (camera.isOrthographicCamera) {
    const half = norm(sub(pose.focal_point, pose.position)) * Math.tan((fovDeg * Math.PI) / 360);
    camera.top = half;
    camera.bottom = -half;
    camera.left = -half * aspect;
    camera.right = half * aspect;
    camera.near = depth - r;   // may be behind the camera: an orthographic view has no eye point
    camera.far = Math.max(depth + r, camera.near + r * 1e-3);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    return;
  }
  const far = Math.max(depth + r, r * 1e-3);
  camera.near = Math.max(depth - r, far * 1e-3);
  camera.far = far;
  camera.fov = fovDeg;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

/**
 * The camera controller: the pose, the pointer gestures on `element`, Spin
 * and the smooth zoom. Callbacks:
 * - onChange(): the pose changed (draw a frame);
 * - onInteraction(active): a drag started or ended (labels fade, edges dim);
 * - onEnd(pose): a camera move ended (drag end, zoom settled, preset, reset);
 * - onClick({x, y, shift, button}): a press and release that moved less than the tolerance;
 * - onHover({x, y} | null): the pointer moved over the element with no button down, or left it;
 * - onSpin(on): Spin stopped by itself (a drag, a preset or a reset);
 * - onPress({x, y}): a left press; true when it was taken (a marker letter), so no drag starts;
 * - onSliceStep(notches): Shift+scroll in Slice view (positive: up, toward the viewer).
 * size() gives {width, height} of the element in CSS px.
 */
export function createCameraController(element, { size, fovDeg = 30, devicePixelRatio = () => window.devicePixelRatio || 1,
  onChange, onInteraction, onEnd, onClick, onHover, onSpin, onPress, onSliceStep } = {}) {
  let pose = null;
  let rotate = true; // false in Slice view: a left drag pans
  let lockAxis = null; // a world axis key of WORLD_AXES, or null
  let pivot = null; // the world point turns pivot on; null: the focal point
  let bounds = { center: [0, 0, 0], radius: 1 };
  let spinning = false;
  let drag = null; // {button, x0, y0, x, y, moved}; a finger's adds touch, pinch {distance, mid} and held
  const touches = new Map(); // pointerId -> {x, y}: the fingers down
  const zoom = createSmoothZoom();
  let zoomTimer = 0;

  const changed = () => onChange?.();

  function setPose(next, { end = false } = {}) {
    pose = copyPose(next);
    changed();
    if (end) onEnd?.(copyPose(pose));
  }

  function stopSpin() {
    if (!spinning) return;
    spinning = false;
    onSpin?.(false);
  }

  function rect() {
    const s = size();
    return { width: Math.max(1, s.width), height: Math.max(1, s.height) };
  }

  /** A rotate-drag step: the trackball, or the turn about the locked axis, through the pivot. */
  function dragTurn(dx, dy) {
    const { width, height } = rect();
    const about = pivot ?? pose.focal_point;
    setPose(lockAxis ? axisRotate(pose, WORLD_AXES[lockAxis], dx, dy, width, height, MOTION_FACTOR, about)
      : trackballRotate(pose, dx, dy, width, height, MOTION_FACTOR, about));
  }

  function local(event) {
    const box = element.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  function capture(event) {
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic event may have no capturable pointer.
    }
  }

  function release(event) {
    try {
      element.releasePointerCapture(event.pointerId);
    } catch {
      // Already released.
    }
  }

  /** The two fingers' distance and midpoint. */
  function pinchSpan() {
    const [a, b] = [...touches.values()];
    return { distance: Math.hypot(b.x - a.x, b.y - a.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }

  function startInteraction() {
    if (drag.interacting) return;
    stopSpin();
    drag.interacting = true;
    onInteraction?.(true);
  }

  function onTouchDown(event) {
    if (!pose || (drag && !drag.touch)) return;
    // A gesture's first finger (isPrimary) with fingers still listed: their lift never came (an iPhone's long press
    // can take a touch for text selection without a pointerup or pointercancel). Forget them, or one finger pans.
    if (event.isPrimary && touches.size) {
      for (const pointerId of [...touches.keys()]) onTouchUp({ pointerId }, true);
    }
    const p = local(event);
    if (!touches.size && onPress?.(p)) return;
    touches.set(event.pointerId, p);
    capture(event);
    if (touches.size === 1) {
      drag = { button: 0, touch: true, x0: p.x, y0: p.y, x: p.x, y: p.y, moved: false, interacting: false,
        shift: false, pinch: null, held: false };
      onHover?.(null);
    } else if (touches.size === 2) {
      drag.moved = true; // no tap
      drag.pinch = pinchSpan();
      drag.held = false;
      startInteraction();
    }
  }

  function onTouchMove(event) {
    if (!touches.has(event.pointerId) || !drag?.touch) return;
    const p = local(event);
    touches.set(event.pointerId, p);
    const { height } = rect();
    if (drag.pinch) {
      if (touches.size < 2) return;
      const next = pinchSpan();
      let moved = pose;
      if (drag.pinch.distance > 0 && next.distance > 0) moved = dolly(moved, next.distance / drag.pinch.distance);
      moved = pan(moved, next.mid.x - drag.pinch.mid.x, next.mid.y - drag.pinch.mid.y, height, fovDeg);
      drag.pinch = next;
      setPose(moved);
      return;
    }
    if (drag.held) return;
    if (!drag.moved) {
      const sx = p.x - drag.x0;
      const sy = p.y - drag.y0;
      if (sx * sx + sy * sy <= TOUCH_TAP_TOLERANCE_PX * TOUCH_TAP_TOLERANCE_PX) return;
      drag.moved = true;
      startInteraction();
    }
    const dx = p.x - drag.x;
    const dy = p.y - drag.y;
    drag.x = p.x;
    drag.y = p.y;
    if (!dx && !dy) return;
    if (!rotate) setPose(pan(pose, dx, dy, height, fovDeg));
    else dragTurn(dx, dy);
  }

  function onTouchUp(event, canceled = false) {
    if (!touches.delete(event.pointerId)) return;
    release(event);
    if (!drag?.touch) return;
    if (touches.size) {
      // One finger of a pinch lifted: the pinch ends, and the finger left down waits for the others to lift.
      drag.pinch = null;
      drag.held = true;
      return;
    }
    const done = drag;
    drag = null;
    if (done.interacting) onInteraction?.(false);
    if (!done.moved && !canceled) onClick?.({ x: done.x0, y: done.y0, shift: false, button: 0 });
    if (done.moved) onEnd?.(copyPose(pose));
  }

  function onPointerDown(event) {
    if (event.pointerType === 'touch') {
      onTouchDown(event);
      return;
    }
    if (!pose || drag) return;
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    const p = local(event);
    if (event.button === 0 && onPress?.(p)) return;
    drag = { button: event.button, x0: p.x, y0: p.y, x: p.x, y: p.y, moved: false, interacting: false, shift: event.shiftKey };
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic event may have no capturable pointer.
    }
    onHover?.(null);
    if (event.button === 0) {
      // A press starts the rotate-drag at once, as VTK's trackball does (a click may rotate a little).
      stopSpin();
      drag.interacting = true;
      onInteraction?.(true);
    }
  }

  function onPointerMove(event) {
    if (event.pointerType === 'touch') {
      onTouchMove(event);
      return;
    }
    if (drag?.touch) return;
    const p = local(event);
    if (!drag) {
      if (event.buttons === 0) onHover?.(p);
      return;
    }
    const dx = p.x - drag.x;
    const dy = p.y - drag.y;
    drag.x = p.x;
    drag.y = p.y;
    const sx = p.x - drag.x0;
    const sy = p.y - drag.y0;
    const { height } = rect();
    if (drag.button === 0 && rotate) {
      if (sx * sx + sy * sy > CLICK_TOLERANCE_PX * CLICK_TOLERANCE_PX) drag.moved = true;
      if (dx || dy) dragTurn(dx, dy);
      return;
    }
    const tolerance = drag.button === 0 ? CLICK_TOLERANCE_PX : RIGHT_CLICK_TOLERANCE_PX;
    if (!drag.moved && sx * sx + sy * sy >= tolerance * tolerance) {
      drag.moved = true;
      stopSpin();
      drag.interacting = true;
      onInteraction?.(true);
    }
    if (drag.moved && (dx || dy)) setPose(pan(pose, dx, dy, height, fovDeg, 1 / Math.max(1, devicePixelRatio())));
  }

  function onPointerUp(event) {
    if (event.pointerType === 'touch') {
      onTouchUp(event);
      return;
    }
    if (!drag || drag.touch || event.button !== drag.button) return;
    const done = drag;
    drag = null;
    try {
      element.releasePointerCapture(event.pointerId);
    } catch {
      // Already released.
    }
    if (done.interacting) onInteraction?.(false);
    if (!done.moved) onClick?.({ x: done.x0, y: done.y0, shift: done.shift || event.shiftKey, button: done.button });
    if (done.moved) onEnd?.(copyPose(pose));
    if (event.buttons === 0) onHover?.(local(event));
  }

  function onPointerCancel(event) {
    if (event.pointerType === 'touch') {
      onTouchUp(event, true);
      return;
    }
    if (!drag || drag.touch) return;
    const done = drag;
    drag = null;
    if (done.interacting) onInteraction?.(false);
    if (done.moved) onEnd?.(copyPose(pose));
  }

  function onPointerLeave(event) {
    if (event.pointerType !== 'touch' && !drag) onHover?.(null);
  }

  /** A finger whose capture was taken away ends as a canceled touch (after a normal lift it is already gone). */
  function onLostCapture(event) {
    if (event.pointerType === 'touch') onTouchUp(event, true);
  }

  function onWheel(event) {
    if (!pose) return;
    event.preventDefault();
    if (!rotate && event.shiftKey) {
      const step = wheelNotches({ deltaY: event.deltaY || event.deltaX, deltaMode: event.deltaMode });
      if (step) onSliceStep?.(step);
      return;
    }
    const notches = wheelNotches(event);
    if (!notches) return;
    zoom.push(notches);
    changed();
  }

  function onContextMenu(event) {
    event.preventDefault(); // no browser menu (Reload, Inspect Element) over the view (inventory E16)
  }

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', onPointerUp);
  element.addEventListener('pointercancel', onPointerCancel);
  element.addEventListener('pointerleave', onPointerLeave);
  element.addEventListener('lostpointercapture', onLostCapture);
  element.addEventListener('wheel', onWheel, { passive: false });
  element.addEventListener('contextmenu', onContextMenu);

  return {
    get pose() {
      return pose ? copyPose(pose) : null;
    },
    get spinning() {
      return spinning;
    },
    /** True while something moves the camera by itself (Spin, the smooth zoom). */
    get animating() {
      return spinning || zoom.active;
    },
    get dragging() {
      return Boolean(drag?.interacting);
    },
    /** The world axis a drag and Spin turn about ('x', 'y' or 'z'), or null for the trackball. */
    get lockAxis() {
      return lockAxis;
    },
    lock(axis) {
      lockAxis = WORLD_AXES[axis] ? axis : null;
      changed();
    },
    /** Rotation on (the trackball) or off (Slice view: a left drag pans, Spin holds still). */
    setRotate(on) {
      rotate = Boolean(on);
      if (!rotate) stopSpin();
    },
    /** The scene's bounding sphere, for fit() and the clipping planes. */
    setBounds(center, radius) {
      bounds = { center: [...center], radius: Number(radius) };
    },
    get bounds() {
      return { center: [...bounds.center], radius: bounds.radius };
    },
    /** The world point every turn pivots on (the center of what the view shows); null: the focal point. */
    setPivot(point) {
      pivot = point ? point.map(Number) : null;
    },
    get pivot() {
      return pivot ? [...pivot] : null;
    },
    /** Set the pose; end: report it as the end of a move (saved). */
    set(next, { end = false } = {}) {
      setPose(next, { end });
    },
    /** A preset pose (from the scene); stops Spin. */
    preset(next) {
      stopSpin();
      zoom.stop();
      setPose(next, { end: true });
    },
    fit() {
      if (!pose) return;
      stopSpin();
      zoom.stop();
      setPose(fitPose(pose, bounds.center, bounds.radius, fovDeg), { end: true });
    },
    /** Spin on or off; turning it off saves the pose it reached, as the end of a move. */
    spin(on) {
      const was = spinning;
      spinning = Boolean(on) && Boolean(pose);
      if (was && !spinning) onEnd?.(copyPose(pose));
      changed();
    },
    /**
     * Advance Spin and the smooth zoom by dt seconds (called once per drawn frame).
     * @returns {boolean} whether the pose changed
     */
    advance(dtSeconds) {
      if (!pose) return false;
      let moved = false;
      if (spinning && rotate && !drag?.interacting) {
        const deg = SPIN_DEG_PER_SEC * Math.max(0, Math.min(0.1, dtSeconds));
        const about = pivot ?? pose.focal_point;
        pose = lockAxis ? turnAbout(pose, WORLD_AXES[lockAxis], deg, about) : turnPose(pose, pose.view_up, deg, about);
        moved = true;
      }
      if (zoom.active) {
        const factor = zoom.step(dtSeconds);
        if (factor !== 1) {
          pose = dolly(pose, factor);
          moved = true;
        }
        if (!zoom.active) {
          clearTimeout(zoomTimer);
          zoomTimer = setTimeout(() => onEnd?.(copyPose(pose)), 0);
        }
      }
      return moved;
    },
    dispose() {
      clearTimeout(zoomTimer);
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerCancel);
      element.removeEventListener('pointerleave', onPointerLeave);
      element.removeEventListener('lostpointercapture', onLostCapture);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('contextmenu', onContextMenu);
    },
  };
}

/** A three.js camera for the view: a PerspectiveCamera, or an OrthographicCamera (applyToThree sizes it). */
export function createThreeCamera(fovDeg = 30, orthographic = false) {
  return orthographic ? new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 10) : new THREE.PerspectiveCamera(fovDeg, 1, 1, 10);
}

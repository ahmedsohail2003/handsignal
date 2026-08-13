// 3-link planar arm kinematics for the cobot cell view.
//
// The gripper tip follows a keyframed Cartesian path (pick from conveyor,
// place on pallet); shoulder and elbow angles are solved with 2-link inverse
// kinematics, and a fixed-length wrist link keeps the gripper pointing down.
// Coordinates are canvas-style: y grows downward.

export interface Point {
  x: number;
  y: number;
}

export interface ArmPose {
  shoulder: Point;
  elbow: Point;
  wrist: Point;
  /** Gripper tip position. */
  tip: Point;
  /** 1 = fully open, 0 = closed. */
  gripOpen: number;
  /** True while a part is held (between pick and place). */
  carrying: boolean;
  /** Human-readable phase name for telemetry. */
  phase: string;
}

// Scene layout constants (design space 660 x 430).
export const SHOULDER: Point = { x: 250, y: 250 };
export const L1 = 110;
export const L2 = 95;
export const L3 = 35;

export const PICK_X = 430;
export const PLACE_X = 110;

// Cycle fractions where the part attaches / detaches.
export const PICK_U = 0.3;
export const PLACE_U = 0.74;

interface Waypoint {
  u: number;
  x: number;
  y: number;
  phase: string;
}

const WAYPOINTS: Waypoint[] = [
  { u: 0.0, x: 300, y: 170, phase: 'HOME' },
  { u: 0.15, x: PICK_X, y: 235, phase: 'APPROACH PICK' },
  { u: 0.26, x: PICK_X, y: 296, phase: 'DESCEND' },
  { u: 0.34, x: PICK_X, y: 296, phase: 'GRIP' },
  { u: 0.44, x: PICK_X, y: 205, phase: 'LIFT' },
  { u: 0.62, x: PLACE_X, y: 205, phase: 'TRANSFER' },
  { u: 0.7, x: PLACE_X, y: 318, phase: 'DESCEND' },
  { u: 0.78, x: PLACE_X, y: 318, phase: 'RELEASE' },
  { u: 0.88, x: PLACE_X, y: 220, phase: 'RETRACT' },
  { u: 1.0, x: 300, y: 170, phase: 'RETURN' },
];

function smoothstep(s: number): number {
  const c = Math.min(1, Math.max(0, s));
  return c * c * (3 - 2 * c);
}

/**
 * 2-link IK in y-down coordinates. Returns the elbow position for the
 * "elbow up" configuration (smaller y). Out-of-reach targets are clamped
 * onto the reachable annulus.
 */
export function solveTwoLink(
  shoulder: Point,
  target: Point,
  l1: number,
  l2: number,
): Point {
  let dx = target.x - shoulder.x;
  let dy = target.y - shoulder.y;
  let d = Math.hypot(dx, dy);
  const dMin = Math.abs(l1 - l2) + 1e-3;
  const dMax = l1 + l2 - 1e-3;
  if (d < 1e-6) {
    dx = dMin;
    dy = 0;
    d = dMin;
  } else if (d < dMin || d > dMax) {
    const clamped = Math.min(Math.max(d, dMin), dMax);
    dx *= clamped / d;
    dy *= clamped / d;
    d = clamped;
  }
  const cosE = (d * d - l1 * l1 - l2 * l2) / (2 * l1 * l2);
  const e = Math.acos(Math.min(1, Math.max(-1, cosE)));
  const base = Math.atan2(dy, dx);
  const inner = Math.atan2(l2 * Math.sin(e), l1 + l2 * Math.cos(e));
  const a = base - inner;
  const b = base + inner;
  const elbowA = {
    x: shoulder.x + l1 * Math.cos(a),
    y: shoulder.y + l1 * Math.sin(a),
  };
  const elbowB = {
    x: shoulder.x + l1 * Math.cos(b),
    y: shoulder.y + l1 * Math.sin(b),
  };
  return elbowA.y <= elbowB.y ? elbowA : elbowB;
}

function gripOpenAt(u: number): number {
  // Closes over 0.26..0.30, opens over 0.74..0.78.
  if (u < 0.26) return 1;
  if (u < 0.3) return 1 - (u - 0.26) / 0.04;
  if (u < 0.74) return 0;
  if (u < 0.78) return (u - 0.74) / 0.04;
  return 1;
}

/** Arm pose at cycle fraction u in [0, 1). */
export function poseAt(u: number): ArmPose {
  const cu = ((u % 1) + 1) % 1;
  let i = 0;
  while (i < WAYPOINTS.length - 2 && cu >= WAYPOINTS[i + 1].u) i += 1;
  const w0 = WAYPOINTS[i];
  const w1 = WAYPOINTS[i + 1];
  const span = Math.max(1e-6, w1.u - w0.u);
  const s = smoothstep((cu - w0.u) / span);
  const tip: Point = {
    x: w0.x + (w1.x - w0.x) * s,
    y: w0.y + (w1.y - w0.y) * s,
  };
  const wrist: Point = { x: tip.x, y: tip.y - L3 };
  const elbow = solveTwoLink(SHOULDER, wrist, L1, L2);
  return {
    shoulder: SHOULDER,
    elbow,
    wrist,
    tip,
    gripOpen: gripOpenAt(cu),
    carrying: cu >= PICK_U && cu < PLACE_U,
    phase: w1.phase,
  };
}

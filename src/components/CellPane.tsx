import { useEffect, useRef } from 'react';
import type React from 'react';
import { CobotCell, type CellState } from '../cell/cellSim';
import { PICK_U, PICK_X, PLACE_U, PLACE_X, poseAt } from '../cell/arm';
import { fitCanvas } from './ring';

const BANNERS: Record<
  CellState,
  { title: string; desc: string; color: string; flash?: boolean }
> = {
  IDLE: {
    title: 'IDLE',
    desc: 'Awaiting CYCLE START — hold the V gesture (key 5).',
    color: '#8A94A8',
  },
  RUNNING: {
    title: 'RUNNING',
    desc: 'Pick-and-place cycle active at full speed.',
    color: '#34D399',
  },
  SLOW: {
    title: 'SLOW MODE',
    desc: 'Cycle running at 50% speed.',
    color: '#F59E0B',
  },
  STOPPED: {
    title: 'STOPPED',
    desc: 'Motion paused mid-move. RESUME (thumb up, key 3) to continue.',
    color: '#EF4444',
  },
  ESTOPPED: {
    title: 'EMERGENCY STOP',
    desc: 'Cell locked out. Two-step reset required at the panel below.',
    color: '#EF4444',
    flash: true,
  },
};

interface CellPaneProps {
  cellRef: React.MutableRefObject<CobotCell | null>;
  cellState: CellState;
  resetStep: 0 | 1;
  cyclesCompleted: number;
  speedPct: number;
  onEstopResetArm: () => void;
  onEstopResetConfirm: () => void;
}

export function CellPane(props: CellPaneProps) {
  const {
    cellState,
    resetStep,
    cyclesCompleted,
    speedPct,
    onEstopResetArm,
    onEstopResetConfirm,
  } = props;
  const banner = BANNERS[cellState];

  return (
    <section className="pane" aria-label="Cobot cell simulation">
      <div className="pane-head">
        <h2>Cobot cell — simulation</h2>
        <span className="badge">2D kinematic model, not a real robot</span>
        <div className="spacer" />
      </div>

      <div
        className={banner.flash ? 'banner flash' : 'banner'}
        style={{ borderLeftColor: banner.color }}
        role="status"
        aria-live="polite"
      >
        <span className="state-name" style={{ color: banner.color }}>
          {banner.title}
        </span>
        <span className="state-desc">{banner.desc}</span>
      </div>

      <div className="cell-stage">
        <CellCanvas cellRef={props.cellRef} />
        <Andon state={cellState} />
        {cellState === 'ESTOPPED' && (
          <div className="estop-panel" role="alert" aria-label="E-stop reset">
            <div className="estop-title">EMERGENCY STOP ACTIVE</div>
            <p>
              Recovery is deliberately not gesture-driven: a misread hand pose
              must never re-energize a locked-out cell, so the reset is an
              explicit two-step act at the panel. The cell returns to IDLE,
              not to RUNNING.
            </p>
            <div className="estop-actions">
              <button
                type="button"
                onClick={onEstopResetArm}
                disabled={resetStep === 1}
                className={resetStep === 1 ? 'armed-step' : ''}
              >
                {resetStep === 1 ? 'STEP 1 DONE — RESET LATCHED' : 'STEP 1 · RESET E-STOP'}
              </button>
              <button
                type="button"
                onClick={onEstopResetConfirm}
                disabled={resetStep !== 1}
              >
                STEP 2 · CONFIRM — RETURN TO IDLE
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="cell-foot">
        <span>CYCLES {cyclesCompleted}</span>
        <span>SPEED {speedPct}%</span>
        <PhaseReadout cellRef={props.cellRef} />
        <div className="spacer" />
        <span>STOP pauses · SLOW halves speed · E-STOP locks out</span>
      </div>
    </section>
  );
}

/** Cycle-phase label, re-rendered with parent syncs (~8 Hz is enough). */
function PhaseReadout({
  cellRef,
}: {
  cellRef: React.MutableRefObject<CobotCell | null>;
}) {
  const cell = cellRef.current;
  const phase = cell ? poseAt(cell.cycleU()).phase : 'HOME';
  return <span>PHASE {phase}</span>;
}

function Andon({ state }: { state: CellState }) {
  const lamps = [
    {
      cls: 'red',
      label: 'STOP',
      on: state === 'STOPPED' || state === 'IDLE' || state === 'ESTOPPED',
      flashing: state === 'ESTOPPED',
    },
    { cls: 'amber', label: 'SLOW', on: state === 'SLOW', flashing: false },
    { cls: 'green', label: 'RUN', on: state === 'RUNNING', flashing: false },
  ];
  return (
    <div className="andon" role="img" aria-label={`Andon light: ${state}`}>
      {lamps.map((l) => (
        <div
          key={l.cls}
          className={`lamp ${l.cls}${l.on ? ' on' : ''}${l.flashing ? ' flashing' : ''}`}
        >
          <span className="bulb" />
          <span className="lamp-label">{l.label}</span>
        </div>
      ))}
      <span className="andon-state">{state}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Canvas scene                                                        */
/* ------------------------------------------------------------------ */

const SCENE_W = 660;
const SCENE_H = 430;
const FLOOR_Y = 370;
const BELT_Y = 320;
const BELT_X0 = 380;
const BELT_X1 = 656;
const BOX_W = 30;
const BOX_H = 24;
const BOX_GAP = 58;
const BELT_SPEED = 55; // px/s at full speed

interface SceneState {
  boxes: number[];
  beltOffset: number;
  carriedPrev: boolean;
  placed: number;
}

function CellCanvas({
  cellRef,
}: {
  cellRef: React.MutableRefObject<CobotCell | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<SceneState>({
    boxes: [PICK_X, PICK_X + BOX_GAP, PICK_X + BOX_GAP * 2, PICK_X + BOX_GAP * 3],
    beltOffset: 0,
    carriedPrev: false,
    placed: 0,
  });

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const canvas = canvasRef.current;
      const cell = cellRef.current;
      if (canvas && cell) {
        updateScene(sceneRef.current, cell, dt);
        drawScene(canvas, cell, sceneRef.current);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [cellRef]);

  return <canvas ref={canvasRef} aria-label="Robot arm pick-and-place scene" />;
}

function updateScene(scene: SceneState, cell: CobotCell, dt: number) {
  const f = cell.speedFactor();
  const u = cell.cycleU();
  const pose = poseAt(u);

  if (f > 0) {
    scene.beltOffset = (scene.beltOffset + BELT_SPEED * f * dt) % 24;
    // Boxes advance toward the pick point and queue behind each other.
    for (let i = 0; i < scene.boxes.length; i += 1) {
      const minX = i === 0 ? PICK_X : scene.boxes[i - 1] + BOX_GAP;
      scene.boxes[i] = Math.max(minX, scene.boxes[i] - BELT_SPEED * f * dt);
    }
    const lastBox = scene.boxes[scene.boxes.length - 1] ?? BELT_X1;
    if (lastBox < BELT_X1 - BOX_GAP) scene.boxes.push(BELT_X1 + BOX_W);
  }

  // Rising edge of "carrying": the gripper closed at the pick point.
  if (pose.carrying && !scene.carriedPrev) {
    if (scene.boxes.length > 0 && scene.boxes[0] <= PICK_X + 6) {
      scene.boxes.shift();
    }
  }
  // Falling edge: part released over the pallet.
  if (!pose.carrying && scene.carriedPrev && u >= PLACE_U && u < PLACE_U + 0.2) {
    scene.placed = (scene.placed + 1) % 7;
  }
  scene.carriedPrev = pose.carrying;

  if (cell.state === 'IDLE' && cell.cycleT === 0) {
    scene.carriedPrev = false;
  }
}

function drawScene(
  canvas: HTMLCanvasElement,
  cell: CobotCell,
  scene: SceneState,
) {
  const fit = fitCanvas(canvas);
  if (!fit) return;
  const { ctx, w, h } = fit;
  ctx.clearRect(0, 0, w, h);

  // Uniform scale, centered.
  const k = Math.min(w / SCENE_W, h / SCENE_H);
  ctx.save();
  ctx.translate((w - SCENE_W * k) / 2, (h - SCENE_H * k) / 2);
  ctx.scale(k, k);

  // Background grid.
  ctx.strokeStyle = 'rgba(42, 51, 71, 0.35)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= SCENE_W; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, SCENE_H);
    ctx.stroke();
  }
  for (let y = 0; y <= SCENE_H; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(SCENE_W, y);
    ctx.stroke();
  }

  // Safety cell boundary.
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = '#2A3347';
  ctx.lineWidth = 2;
  ctx.strokeRect(12, 40, SCENE_W - 24, FLOOR_Y - 28);
  ctx.setLineDash([]);
  ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillStyle = '#8A94A8';
  ctx.textAlign = 'left';
  ctx.fillText('CELL BOUNDARY', 20, 56);

  // Floor.
  ctx.strokeStyle = '#2A3347';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, FLOOR_Y);
  ctx.lineTo(SCENE_W, FLOOR_Y);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(42, 51, 71, 0.6)';
  ctx.lineWidth = 1;
  for (let x = 0; x < SCENE_W; x += 18) {
    ctx.beginPath();
    ctx.moveTo(x, FLOOR_Y);
    ctx.lineTo(x - 8, FLOOR_Y + 10);
    ctx.stroke();
  }

  const u = cell.cycleU();
  const pose = poseAt(u);

  // Pallet (place target).
  ctx.fillStyle = '#1C2333';
  ctx.strokeStyle = '#2A3347';
  ctx.lineWidth = 1.5;
  ctx.fillRect(PLACE_X - 52, FLOOR_Y - 16, 104, 16);
  ctx.strokeRect(PLACE_X - 52, FLOOR_Y - 16, 104, 16);
  // Placed parts stack, 2 columns x 3 rows.
  for (let i = 0; i < scene.placed && i < 6; i += 1) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const bx = PLACE_X - 34 + col * 36;
    const by = FLOOR_Y - 16 - BOX_H * (row + 1) - 2;
    drawBox(ctx, bx, by);
  }
  ctx.fillStyle = '#8A94A8';
  ctx.textAlign = 'center';
  ctx.fillText('PLACE', PLACE_X, FLOOR_Y + 22);

  // Conveyor.
  ctx.fillStyle = '#1C2333';
  ctx.strokeStyle = '#2A3347';
  ctx.fillRect(BELT_X0, BELT_Y, BELT_X1 - BELT_X0, 18);
  ctx.strokeRect(BELT_X0, BELT_Y, BELT_X1 - BELT_X0, 18);
  // Belt stripes indicate motion.
  ctx.save();
  ctx.beginPath();
  ctx.rect(BELT_X0, BELT_Y, BELT_X1 - BELT_X0, 18);
  ctx.clip();
  ctx.strokeStyle = 'rgba(96, 165, 250, 0.35)';
  ctx.lineWidth = 2;
  for (let x = BELT_X1 + 24; x > BELT_X0 - 24; x -= 24) {
    const sx = x - scene.beltOffset;
    ctx.beginPath();
    ctx.moveTo(sx, BELT_Y + 2);
    ctx.lineTo(sx - 8, BELT_Y + 16);
    ctx.stroke();
  }
  ctx.restore();
  // Legs.
  ctx.strokeStyle = '#2A3347';
  ctx.lineWidth = 3;
  for (const lx of [BELT_X0 + 14, BELT_X1 - 20]) {
    ctx.beginPath();
    ctx.moveTo(lx, BELT_Y + 18);
    ctx.lineTo(lx, FLOOR_Y);
    ctx.stroke();
  }
  ctx.fillStyle = '#8A94A8';
  ctx.textAlign = 'center';
  ctx.fillText('PICK', PICK_X, FLOOR_Y + 22);

  // Queued boxes on the belt.
  for (const bx of scene.boxes) {
    if (bx < BELT_X1 + BOX_W) drawBox(ctx, bx - BOX_W / 2, BELT_Y - BOX_H);
  }

  // Pedestal.
  ctx.fillStyle = '#1C2333';
  ctx.strokeStyle = '#2A3347';
  ctx.lineWidth = 1.5;
  ctx.fillRect(pose.shoulder.x - 16, pose.shoulder.y, 32, FLOOR_Y - pose.shoulder.y);
  ctx.strokeRect(pose.shoulder.x - 16, pose.shoulder.y, 32, FLOOR_Y - pose.shoulder.y);
  ctx.fillRect(pose.shoulder.x - 30, FLOOR_Y - 8, 60, 8);
  ctx.strokeRect(pose.shoulder.x - 30, FLOOR_Y - 8, 60, 8);

  // Arm links.
  const linkColor = cell.state === 'ESTOPPED' ? '#7F3B45' : '#4A5876';
  ctx.lineCap = 'round';
  ctx.strokeStyle = linkColor;
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.moveTo(pose.shoulder.x, pose.shoulder.y);
  ctx.lineTo(pose.elbow.x, pose.elbow.y);
  ctx.stroke();
  ctx.lineWidth = 11;
  ctx.beginPath();
  ctx.moveTo(pose.elbow.x, pose.elbow.y);
  ctx.lineTo(pose.wrist.x, pose.wrist.y);
  ctx.stroke();
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(pose.wrist.x, pose.wrist.y);
  ctx.lineTo(pose.tip.x, pose.tip.y - 6);
  ctx.stroke();

  // Carried part (drawn before the gripper so the fingers wrap it).
  if (pose.carrying) {
    drawBox(ctx, pose.tip.x - BOX_W / 2, pose.tip.y - 4);
  }

  // Gripper fingers.
  const spread = 6 + pose.gripOpen * 10;
  ctx.strokeStyle = '#7DD3FC';
  ctx.lineWidth = 4;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(pose.tip.x + side * spread, pose.tip.y - 8);
    ctx.lineTo(pose.tip.x + side * spread, pose.tip.y + 8);
    ctx.stroke();
  }

  // Joints.
  for (const j of [pose.shoulder, pose.elbow, pose.wrist]) {
    ctx.beginPath();
    ctx.arc(j.x, j.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#141926';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#8A94A8';
    ctx.stroke();
  }

  // Pick target marker on the belt.
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = 'rgba(138, 148, 168, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PICK_X, BELT_Y - BOX_H - 26);
  ctx.lineTo(PICK_X, BELT_Y - BOX_H - 6);
  ctx.stroke();
  ctx.setLineDash([]);

  // Cycle-progress arc near the base, labeled.
  ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillStyle = '#8A94A8';
  ctx.textAlign = 'left';
  ctx.fillText(`CYCLE ${(u * 100).toFixed(0)}%  ${pose.phase}`, 20, SCENE_H - 24);
  if (u >= PICK_U && u < PLACE_U) {
    ctx.fillText('PART IN GRIPPER', 20, SCENE_H - 10);
  }

  ctx.restore();
}

function drawBox(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.fillStyle = '#223047';
  ctx.strokeStyle = '#60A5FA';
  ctx.lineWidth = 1.5;
  ctx.fillRect(x, y, BOX_W, BOX_H);
  ctx.strokeRect(x, y, BOX_W, BOX_H);
  ctx.strokeStyle = 'rgba(96, 165, 250, 0.4)';
  ctx.beginPath();
  ctx.moveTo(x + BOX_W / 2, y);
  ctx.lineTo(x + BOX_W / 2, y + BOX_H);
  ctx.stroke();
}

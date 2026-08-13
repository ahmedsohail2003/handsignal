import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_CONFIG,
  GestureStateMachine,
  type GestureLabel,
  type MachineEvent,
  type Snapshot,
} from './gesture/stateMachine';
import { COMMAND_LABELS, KEY_TO_GESTURE } from './gesture/gestures';
import { CobotCell, type CellState } from './cell/cellSim';
import {
  DEMO_CONFIDENCE,
  DEMO_DWELL_MS,
  DEMO_STEPS,
  DEMO_TOTAL_MS,
} from './demo/script';
import { HandPane } from './components/HandPane';
import { CellPane } from './components/CellPane';
import { TelemetryStrip } from './components/TelemetryStrip';
import { AboutPanel } from './components/AboutPanel';
import type { LastFired } from './components/ring';

export type InputMode = 'sim' | 'camera';

export interface LogLine {
  id: number;
  t: number; // ms since session start
  kind: 'armed' | 'fired' | 'false_start' | 'info';
  text: string;
}

/** Narration state for the guided demo overlay. */
export interface DemoUi {
  idx: number;
  total: number;
  caption: string;
  totalMs: number;
}

export interface UiSync {
  snapshot: Snapshot;
  cellState: CellState;
  resetStep: 0 | 1;
  cyclesCompleted: number;
  speedPct: number;
  lastFired: LastFired | null;
  lastRaw: { label: GestureLabel; confidence: number } | null;
}

const RAW_LOG_CAP = 4000;

export default function App() {
  // Mutable engine state lives in refs; canvases read it every frame and
  // React state is synced at ~8 Hz for the DOM parts.
  const machineRef = useRef<GestureStateMachine | null>(null);
  if (machineRef.current === null) {
    machineRef.current = new GestureStateMachine();
  }
  const cellRef = useRef<CobotCell | null>(null);
  if (cellRef.current === null) cellRef.current = new CobotCell();

  const heldRef = useRef<GestureLabel | null>(null);
  const confRef = useRef(0.92);
  const modeRef = useRef<InputMode>('sim');
  const snapRef = useRef<Snapshot>(machineRef.current.snapshot(0));
  const lastFiredRef = useRef<LastFired | null>(null);
  const lastRawRef = useRef<{ label: GestureLabel; confidence: number } | null>(
    null,
  );
  const sessionLogRef = useRef<MachineEvent[]>([]);
  const rawLoggedRef = useRef(0);
  const t0Ref = useRef<number | null>(null);
  const logIdRef = useRef(1);

  const demoActiveRef = useRef(false);
  const demoTimersRef = useRef<number[]>([]);

  const [mode, setMode] = useState<InputMode>('sim');
  const [simConfidence, setSimConfidence] = useState(0.92);
  const [dwellMs, setDwellMsState] = useState(DEFAULT_CONFIG.dwellMs);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [cameraNote, setCameraNote] = useState<string | null>(null);
  const [demoUi, setDemoUi] = useState<DemoUi | null>(null);
  const [uiLog, setUiLog] = useState<LogLine[]>([]);
  const [ui, setUi] = useState<UiSync>(() => ({
    snapshot: machineRef.current!.snapshot(0),
    cellState: 'IDLE',
    resetStep: 0,
    cyclesCompleted: 0,
    speedPct: 0,
    lastFired: null,
    lastRaw: null,
  }));

  const sessionT = useCallback((t: number) => t - (t0Ref.current ?? t), []);

  const appendLog = useCallback(
    (lines: Omit<LogLine, 'id'>[]) => {
      if (lines.length === 0) return;
      setUiLog((prev) => [
        ...prev.slice(-60),
        ...lines.map((l) => ({ ...l, id: logIdRef.current++ })),
      ]);
    },
    [setUiLog],
  );

  /**
   * Single ingestion point for classification samples. Real (camera) and
   * simulated input both land here, so everything downstream — state
   * machine, cell commands, logging — is identical for the two paths.
   */
  const pushSample = useCallback(
    (label: GestureLabel | null, confidence: number, t: number) => {
      const machine = machineRef.current!;
      const cell = cellRef.current!;
      const events = machine.sample(label, confidence, t);
      if (events.length === 0) return;
      const lines: Omit<LogLine, 'id'>[] = [];
      for (const ev of events) {
        if (ev.type === 'raw') {
          lastRawRef.current = { label: ev.label, confidence: ev.confidence };
          if (rawLoggedRef.current < RAW_LOG_CAP) {
            sessionLogRef.current.push(ev);
            rawLoggedRef.current += 1;
          }
          continue;
        }
        sessionLogRef.current.push(ev);
        const ts = sessionT(ev.t);
        if (ev.type === 'armed') {
          lines.push({
            t: ts,
            kind: 'armed',
            text: `ARMED ${COMMAND_LABELS[ev.command]} — hold ${ev.requiredDwellMs} ms`,
          });
        } else if (ev.type === 'false_start') {
          lines.push({
            t: ts,
            kind: 'false_start',
            text: `FALSE START ${COMMAND_LABELS[ev.command]} — released at ${Math.round(ev.heldMs)} ms`,
          });
        } else {
          const stateBefore = cell.state;
          const accepted = cell.apply(ev.command);
          lastFiredRef.current = { command: ev.command, t: ev.t };
          lines.push({
            t: ts,
            kind: 'fired',
            text: `FIRED ${COMMAND_LABELS[ev.command]} (${Math.round(ev.latencyMs)} ms hold)${
              accepted ? '' : ` — no effect, cell ${stateBefore}`
            }`,
          });
        }
      }
      appendLog(lines);
    },
    [appendLog, sessionT],
  );

  const syncUi = useCallback(() => {
    const cell = cellRef.current!;
    setUi({
      snapshot: snapRef.current,
      cellState: cell.state,
      resetStep: cell.resetStep,
      cyclesCompleted: cell.cyclesCompleted,
      speedPct: Math.round(cell.speedFactor() * 100),
      lastFired: lastFiredRef.current,
      lastRaw: lastRawRef.current,
    });
  }, []);

  // Main loop: simulated sampling, cell clock, periodic React sync.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastSync = 0;
    const step = (now: number) => {
      if (t0Ref.current === null) t0Ref.current = now;
      if (modeRef.current === 'sim') {
        const held = heldRef.current;
        // The guided demo pins the synthetic confidence so a low slider
        // setting cannot make the scripted story silently fail.
        const conf = demoActiveRef.current ? DEMO_CONFIDENCE : confRef.current;
        pushSample(held, held !== null ? conf : 0, now);
      }
      snapRef.current = machineRef.current!.snapshot(now);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      cellRef.current!.tick(dt);
      if (now - lastSync >= 125) {
        lastSync = now;
        syncUi();
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [pushSample, syncUi]);

  /* ------------------------------------------------------------------ */
  /* Guided demo: a scripted ~45 s story played through the simulated    */
  /* input path (same state machine, cell, and logging as live input).   */
  /* ------------------------------------------------------------------ */

  const stopDemo = useCallback(
    (reason: 'finished' | 'canceled') => {
      if (!demoActiveRef.current) return;
      demoActiveRef.current = false;
      demoTimersRef.current.forEach((id) => window.clearTimeout(id));
      demoTimersRef.current = [];
      heldRef.current = null;
      setDemoUi(null);
      appendLog([
        {
          t: sessionT(performance.now()),
          kind: 'info',
          text:
            reason === 'finished'
              ? 'GUIDED DEMO finished — cell idle, you have control'
              : 'GUIDED DEMO canceled — you have control',
        },
      ]);
    },
    [appendLog, sessionT],
  );

  const setInputMode = useCallback(
    (m: InputMode, note?: string) => {
      if (m === 'camera') stopDemo('canceled');
      heldRef.current = null;
      modeRef.current = m;
      setMode(m);
      if (note !== undefined) setCameraNote(note);
    },
    [stopDemo],
  );

  /** User-initiated hold (keyboard key or keypad press). Takes over from a
   *  running demo instead of fighting it. */
  const holdGesture = useCallback(
    (g: GestureLabel) => {
      if (demoActiveRef.current) stopDemo('canceled');
      heldRef.current = g;
    },
    [stopDemo],
  );

  const releaseGesture = useCallback((g: GestureLabel) => {
    if (heldRef.current === g) heldRef.current = null;
  }, []);

  // Keyboard: keys 1–5 hold a simulated gesture while pressed. Escape closes
  // the About panel or cancels a running demo. Any gesture key cancels the
  // demo and takes over immediately.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAboutOpen(false);
        stopDemo('canceled');
        return;
      }
      if (e.repeat) return;
      const g = KEY_TO_GESTURE[e.key];
      if (g && modeRef.current === 'sim') {
        holdGesture(g);
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      const g = KEY_TO_GESTURE[e.key];
      if (g) releaseGesture(g);
    };
    const blur = () => {
      if (!demoActiveRef.current) heldRef.current = null;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [holdGesture, releaseGesture, stopDemo]);

  // Detect whether a camera exists; simulated input is the default either
  // way (?sim=1 forces it), and the camera is strictly opt-in.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('demo') === '1') {
      setCameraNote('Guided demo — simulated input.');
      return;
    }
    if (params.get('sim') === '1') {
      setCameraNote('Simulated input forced via ?sim=1.');
      return;
    }
    if (!navigator.mediaDevices?.enumerateDevices) {
      setCameraNote('No camera API in this environment — simulated input active.');
      return;
    }
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        const cams = devices.filter((d) => d.kind === 'videoinput');
        setCameraNote(
          cams.length === 0
            ? 'No camera detected — simulated input active.'
            : 'Camera detected — click "Enable camera" for live gestures.',
        );
      })
      .catch(() =>
        setCameraNote('Camera check failed — simulated input active.'),
      );
  }, []);

  const onDwellMs = useCallback((v: number) => {
    machineRef.current!.setDwellMs(v);
    setDwellMsState(v);
  }, []);

  const onSimConfidence = useCallback((v: number) => {
    confRef.current = v;
    setSimConfidence(v);
  }, []);

  const onEstopResetArm = useCallback(() => {
    cellRef.current!.estopResetArm();
    appendLog([
      { t: sessionT(performance.now()), kind: 'info', text: 'E-STOP RESET step 1 of 2 (panel)' },
    ]);
    syncUi();
  }, [appendLog, sessionT, syncUi]);

  const onEstopResetConfirm = useCallback(() => {
    cellRef.current!.estopResetConfirm();
    appendLog([
      { t: sessionT(performance.now()), kind: 'info', text: 'E-STOP RESET confirmed — cell IDLE' },
    ]);
    syncUi();
  }, [appendLog, sessionT, syncUi]);

  const startDemo = useCallback(() => {
    if (demoActiveRef.current) return;
    setAboutOpen(false);
    setInputMode('sim', 'Guided demo running — scripted simulated input.');
    onDwellMs(DEMO_DWELL_MS); // deterministic timing; slider shows the change
    // Fresh cell so the story starts from IDLE. Session counters and the
    // event log are kept — the demo's commands are real pipeline traffic.
    cellRef.current = new CobotCell();
    lastFiredRef.current = null;
    demoActiveRef.current = true;
    appendLog([
      {
        t: sessionT(performance.now()),
        kind: 'info',
        text: 'GUIDED DEMO started — scripted simulated input; cell reset to IDLE',
      },
    ]);
    let at = 0;
    DEMO_STEPS.forEach((step, i) => {
      demoTimersRef.current.push(
        window.setTimeout(() => {
          if (!demoActiveRef.current) return;
          setDemoUi({
            idx: i + 1,
            total: DEMO_STEPS.length,
            caption: step.caption,
            totalMs: DEMO_TOTAL_MS,
          });
          if (step.action === 'resetArm') onEstopResetArm();
          if (step.action === 'resetConfirm') onEstopResetConfirm();
          if (step.hold) {
            const g = step.hold;
            heldRef.current = g;
            demoTimersRef.current.push(
              window.setTimeout(() => {
                if (demoActiveRef.current && heldRef.current === g) {
                  heldRef.current = null;
                }
              }, step.holdMs ?? 0),
            );
          }
        }, at),
      );
      at += step.durMs;
    });
    demoTimersRef.current.push(
      window.setTimeout(() => stopDemo('finished'), at),
    );
    syncUi();
  }, [
    appendLog,
    onDwellMs,
    onEstopResetArm,
    onEstopResetConfirm,
    sessionT,
    setInputMode,
    stopDemo,
    syncUi,
  ]);

  // ?demo=1 auto-plays the guided demo shortly after load.
  const startDemoRef = useRef(startDemo);
  startDemoRef.current = startDemo;
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('demo') !== '1') return;
    const id = window.setTimeout(() => startDemoRef.current(), 600);
    return () => window.clearTimeout(id);
  }, []);

  const onExport = useCallback(() => {
    const machine = machineRef.current!;
    const payload = {
      tool: 'HandSignal prototype',
      exportedAt: new Date().toISOString(),
      note: 'Simulated and/or live-camera session log. Raw entries capped at 4000.',
      config: machine.getConfig(),
      counters: machine.counters(),
      events: sessionLogRef.current,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'handsignal-session.json';
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Hand<span>Signal</span>
        </div>
        <div className="tagline">
          Crane-signal gestures as a safety command channel for a cobot cell —
          research prototype
        </div>
        <div className="spacer" />
        <span className={mode === 'sim' ? 'badge sim' : 'badge live'}>
          {mode === 'sim' ? 'Simulated input' : 'Camera input'}
        </span>
        <button
          type="button"
          className={demoUi ? 'demo-btn running' : 'demo-btn'}
          onClick={() => (demoUi ? stopDemo('canceled') : startDemo())}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden="true"
            fill="currentColor"
          >
            {demoUi ? (
              <rect x="1.5" y="1.5" width="7" height="7" rx="1" />
            ) : (
              <path d="M2 1.2 8.8 5 2 8.8Z" />
            )}
          </svg>
          {demoUi ? 'Stop demo' : 'Guided demo · 45 s'}
        </button>
        <button type="button" onClick={() => setAboutOpen(true)}>
          About this study
        </button>
      </header>

      <main className="main">
        <HandPane
          mode={mode}
          snapRef={snapRef}
          heldRef={heldRef}
          lastFiredRef={lastFiredRef}
          simConfidence={simConfidence}
          onSimConfidence={onSimConfidence}
          dwellMs={dwellMs}
          onDwellMs={onDwellMs}
          minConfidence={DEFAULT_CONFIG.minConfidence}
          cameraNote={cameraNote}
          onEnableCamera={() => setInputMode('camera')}
          onUseSim={(note) =>
            setInputMode('sim', note ?? 'Simulated input active.')
          }
          pushSample={pushSample}
          activeGesture={
            ui.snapshot.phase === 'debouncing' || ui.snapshot.phase === 'arming'
              ? ui.snapshot.gesture
              : null
          }
          holdGesture={holdGesture}
          releaseGesture={releaseGesture}
          demo={demoUi}
          onStopDemo={() => stopDemo('canceled')}
        />
        <CellPane
          cellRef={cellRef}
          cellState={ui.cellState}
          resetStep={ui.resetStep}
          cyclesCompleted={ui.cyclesCompleted}
          speedPct={ui.speedPct}
          onEstopResetArm={onEstopResetArm}
          onEstopResetConfirm={onEstopResetConfirm}
        />
      </main>

      <TelemetryStrip
        ui={ui}
        uiLog={uiLog}
        dwellMs={dwellMs}
        estopDwellMs={DEFAULT_CONFIG.estopDwellMs}
        onExport={onExport}
      />

      {aboutOpen && <AboutPanel onClose={() => setAboutOpen(false)} />}
    </div>
  );
}

// gta6-twitch-ccu-forecast-01 entry: an analogue-curve forecaster for a game's
// launch-day Twitch viewership, hour by hour (Node 22, standard library only).
//
// Method (see METHOD.md for the full write-up): a launch day's shape, measured
// as each hour's viewers over hour 1's, is largely set by how the game unlocks
// — a rolling midnight-local launch builds all day toward the US prime-time
// peak, a fixed-hour global unlock ramps at that hour, an early-access launch
// starts front-loaded. So the forecast is built from the case's own
// comparables (38+ past launches with full hourly curves):
//
//   1. every comparable with a full launch day becomes a log-ratio curve
//      r_c(h) = ln V_c(h) - ln V_c(1), plus features: its unlock class (from
//      its unlock text and its curve's shape), its hour-1 scale, and its
//      pre-launch ramp (the mean of the six hours before day start against
//      hour 1 — for a rolling launch those hours are the Asia-Pacific wave
//      already playing);
//   2. the target case gets the same features from its notes and its own
//      history, and each comparable is weighted by class match, scale
//      proximity, ramp proximity and recency;
//   3. each hour's median is the weighted median of the comparables'
//      log-ratios, and its five quantiles blend the weighted empirical
//      quantiles with a normal spread whose sigma is the weighted MAD of the
//      ratios at that hour, smoothed across neighbouring hours.
//
// Everything is computed from the case file at run time: no network, no
// randomness, no clock — two runs write the same bytes. If a case carries too
// few usable comparables, the program falls back to the house persistence
// shape (hour 1 held flat, lognormal spread widening like sqrt(h - 1)).
//
// The contract (program/v1): read every <id>.in in the input directory, write
// <id>.out to the output directory: {"hours":[{"hour":2,"q":[q05,q25,q50,q75,
// q95]}, ...]} for the case's forecast hours. Outside the grader's container,
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const HOUR_MS = 3_600_000;

/** The quantile levels the contest scores. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level (full precision). */
const Z: Record<string, number> = {
  '0.05': -1.6448536269514722,
  '0.25': -0.6744897501960817,
  '0.5': 0,
  '0.75': 0.6744897501960817,
  '0.95': 1.6448536269514722,
};

/** Inverse standard normal CDF (Acklam's rational approximation). */
function normQuantile(p: number): number {
  const exact = Z[String(p)];
  if (exact !== undefined) return exact;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285984469534e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  let q: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - plow) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** x rounded to 2 decimals (half up), as the starter rounds. */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Clamp a forecast print into the contract's (0, 1e9] range. */
const clampPrint = (x: number): number => Math.min(1e9, Math.max(0.01, x));

// ---------------------------------------------------------------------------
// Case shapes, as the kit's cases carry them.

interface HourPoint {
  from?: string;
  at?: string;
  viewers: number;
}

interface Comparable {
  name?: string;
  day_start: string;
  hourly: HourPoint[];
  unlock?: string;
}

interface Case {
  day_start: string;
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  history_hourly?: HourPoint[];
  history?: HourPoint[];
  comparables?: Comparable[];
  notes?: string;
}

// ---------------------------------------------------------------------------
// Features

interface TextClass {
  ea: boolean;
  rolling: boolean;
  global: boolean;
}

/** Read the unlock pattern out of a notes/unlock text. */
function classifyText(text: string | undefined): TextClass {
  const t = (text ?? '').toLowerCase();
  return {
    ea: t.includes('early access') || t.includes('early-access'),
    rolling: t.includes('midnight local') || t.includes('rolling'),
    global: t.includes('global unlock') || t.includes('simultaneous') || t.includes('single global'),
  };
}

/** Hour-stamped viewers of a point series, keyed by epoch milliseconds. */
function hourMap(points: HourPoint[] | undefined): Map<number, number> {
  const m = new Map<number, number>();
  for (const p of points ?? []) {
    const ts = p.from ?? p.at;
    if (ts === undefined) continue;
    const ms = Date.parse(ts);
    if (Number.isFinite(ms) && typeof p.viewers === 'number') m.set(ms, p.viewers);
  }
  return m;
}

/** Mean viewers over the hours [a, b] relative to a day start, or null. */
function preMean(map: Map<number, number>, dayStartMs: number, a: number, b: number): number | null {
  let sum = 0;
  let n = 0;
  for (let t = a; t <= b; t++) {
    const v = map.get(dayStartMs + t * HOUR_MS);
    if (v !== undefined) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? sum / n : null;
}

type CurveClass = 'late' | 'front' | 'build';

interface CompFeatures {
  /** log-ratio of each forecast hour (2..24) to hour 1; null where unsampled. */
  ratios: Array<number | null>;
  logH1: number;
  /** Pre-launch ramp: ln(mean of hours -6..-1 / hour 1). */
  u: number;
  ea: boolean;
  curveClass: CurveClass;
  year: number;
}

/** A comparable's launch-day features, or null when it has no usable day. */
function compFeatures(c: Comparable): CompFeatures | null {
  const map = hourMap(c.hourly);
  const start = Date.parse(c.day_start);
  if (!Number.isFinite(start)) return null;
  const day: Array<number | null> = [];
  for (let t = 0; t < 24; t++) {
    const v = map.get(start + t * HOUR_MS);
    day.push(v === undefined ? null : v);
  }
  const h1 = day[0];
  if (h1 === null || h1 <= 0) return null;
  const valid = day.filter((v): v is number => v !== null);
  if (valid.length < 20) return null;
  const peak = Math.max(...valid);
  const r1 = h1 / peak;
  const curveClass: CurveClass = r1 < 0.05 ? 'late' : r1 >= 0.5 ? 'front' : 'build';
  const pm = preMean(map, start, -6, -1);
  const u = pm !== null && pm > 0 ? Math.log(pm / h1) : 0;
  const ratios: Array<number | null> = day.map((v, t) =>
    t === 0 ? 0 : v !== null && v > 0 ? Math.log(v / h1) : null,
  );
  return {
    ratios,
    logH1: Math.log(h1),
    u,
    ea: classifyText(c.unlock).ea,
    curveClass,
    year: Number(c.day_start.slice(0, 4)),
  };
}

interface TargetFeatures {
  p1: number;
  logH1: number;
  u: number;
  cls: TextClass;
  year: number;
}

function targetFeatures(c: Case): TargetFeatures {
  const first = c.known.find((k) => k.hour === 1) ?? c.known[0];
  const p1 = Math.max(1, first?.viewers ?? 1);
  const points = c.history_hourly && c.history_hourly.length > 0 ? c.history_hourly : c.history;
  const map = hourMap(points);
  const start = Date.parse(c.day_start);
  const pm = Number.isFinite(start) ? preMean(map, start, -6, -1) : null;
  const u = pm !== null && pm > 0 ? Math.log(pm / p1) : 0;
  return { p1, logH1: Math.log(p1), u, cls: classifyText(c.notes), year: Number(c.day_start.slice(0, 4)) };
}

/** The curve class a target with this unlock text should be matched against. */
function wantedClass(cls: TextClass): CurveClass {
  if (cls.rolling && cls.global) return 'front';
  if (cls.global && !cls.rolling) return 'late';
  return 'build';
}

/** 0 = same class, 1 = neighbouring, 2 = far. */
function classDist(want: CurveClass, got: CurveClass): number {
  if (want === got) return 0;
  if (want === 'build' || got === 'build') return 1;
  return 2;
}

// ---------------------------------------------------------------------------
// Weighted quantiles

/** Weighted quantile of [value, weight] pairs, linearly interpolated. */
function wquantile(pairs: Array<[number, number]>, tau: number): number {
  const sorted = [...pairs].sort((x, y) => x[0] - y[0]);
  const tot = sorted.reduce((s, [, w]) => s + w, 0);
  if (tot <= 0) return sorted[Math.floor(sorted.length / 2)][0];
  let acc = 0;
  for (let i = 0; i < sorted.length; i++) {
    const [v, w] = sorted[i];
    acc += w;
    if (acc / tot >= tau) {
      if (i === 0) return v;
      const [pv] = sorted[i - 1];
      const prevAcc = acc - w;
      const frac = w > 0 ? (tau * tot - prevAcc) / w : 0;
      return pv + frac * (v - pv);
    }
  }
  return sorted[sorted.length - 1][0];
}

// ---------------------------------------------------------------------------
// Tuned constants (leave-one-out over the comparables plus the kit's four
// practice launches; see METHOD.md). The loss surface is flat around them.

const S_SCALE = 0.7; // bandwidth of the hour-1 scale proximity (natural log)
const S_U = 0.5; // bandwidth of the pre-launch ramp proximity
const CLASS_W = [1.0, 0.45, 0.08]; // weight by class distance 0 / 1 / 2
const RECENCY_HALF = 10; // years for a comparable's weight to halve
const EA_FACTOR = 0.45; // early-access comparable vs a clean-launch target
const SIGMA_FLOOR = 0.22;
const SIGMA_CAP = 1.15;
const SIGMA_SMOOTH = 2; // hours either side in the sigma moving average
const EMP_BLEND = 0.45; // weight on empirical quantiles vs the normal spread

/** The analogue-curve forecast: one row of five quantiles per forecast hour. */
function modelForecast(c: Case, hours: number[]): Array<{ hour: number; q: number[] }> | null {
  const tf = targetFeatures(c);
  const want = wantedClass(tf.cls);
  const feats: Array<{ f: CompFeatures; w: number }> = [];
  for (const comp of c.comparables ?? []) {
    const f = compFeatures(comp);
    if (f === null) continue;
    let w = CLASS_W[classDist(want, f.curveClass)];
    w *= Math.exp(-((f.logH1 - tf.logH1) ** 2) / (2 * S_SCALE * S_SCALE));
    w *= Math.exp(-((f.u - tf.u) ** 2) / (2 * S_U * S_U));
    w *= Math.pow(0.5, Math.max(0, tf.year - f.year) / RECENCY_HALF);
    if (f.ea && !tf.cls.ea) w *= EA_FACTOR;
    feats.push({ f, w: Math.max(w, 1e-6) });
  }
  if (feats.length < 5) return null;

  const levels = c.levels.length === LEVELS.length ? c.levels : LEVELS;
  const med = new Map<number, number>();
  const sigRaw = new Map<number, number>();
  const emp = new Map<number, number[]>();
  for (const h of hours) {
    const t = h - 1; // ratios are indexed by hour-of-day offset; hour h sits at index h-1
    const pairs: Array<[number, number]> = [];
    for (const { f, w } of feats) {
      const r = f.ratios[t];
      if (r !== null && r !== undefined) pairs.push([r, w]);
    }
    if (pairs.length < 5) return null;
    const m = wquantile(pairs, 0.5);
    med.set(h, m);
    const absdev: Array<[number, number]> = pairs.map(([r, w]) => [Math.abs(r - m), w]);
    const mad = wquantile(absdev, 0.5);
    sigRaw.set(h, Math.min(SIGMA_CAP, Math.max(SIGMA_FLOOR, 1.4826 * mad)));
    emp.set(h, levels.map((tau) => wquantile(pairs, tau)));
  }
  const sig = new Map<number, number>();
  for (const h of hours) {
    let sum = 0;
    let n = 0;
    for (let x = h - SIGMA_SMOOTH; x <= h + SIGMA_SMOOTH; x++) {
      const s = sigRaw.get(x);
      if (s !== undefined) {
        sum += s;
        n++;
      }
    }
    sig.set(h, n > 0 ? sum / n : SIGMA_FLOOR);
  }
  return hours.map((h) => {
    const m = med.get(h) ?? 0;
    const s = sig.get(h) ?? SIGMA_FLOOR;
    const e = emp.get(h) ?? levels.map(() => m);
    const q = levels
      .map((tau, j) => {
        const logQ = EMP_BLEND * e[j] + (1 - EMP_BLEND) * (m + normQuantile(tau) * s);
        return clampPrint(round2(tf.p1 * Math.exp(logQ)));
      })
      .sort((x, y) => x - y);
    return { hour: h, q };
  });
}

/** The house persistence shape, as a fallback for a case with no analogues. */
function persistenceForecast(c: Case, hours: number[]): Array<{ hour: number; q: number[] }> {
  const tf = targetFeatures(c);
  const levels = c.levels.length === LEVELS.length ? c.levels : LEVELS;
  return hours.map((h) => ({
    hour: h,
    q: levels.map((tau) => clampPrint(round2(tf.p1 * Math.exp(normQuantile(tau) * 0.15 * Math.sqrt(h - 1))))),
  }));
}

// ---------------------------------------------------------------------------

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  const hours = c.forecast.map((f) => f.hour).sort((x, y) => x - y);
  let rows: Array<{ hour: number; q: number[] }> | null = null;
  try {
    rows = modelForecast(c, hours);
  } catch {
    rows = null;
  }
  if (rows === null) rows = persistenceForecast(c, hours);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours: rows })}\n`);
}

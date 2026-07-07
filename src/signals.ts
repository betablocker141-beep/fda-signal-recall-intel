/**
 * Pure signal-detection statistics. No I/O, no framework imports — this is the
 * tested backbone of the dashboard (the analogue of classifier.py in the MAUDE
 * project).
 *
 * Methods:
 * - PRR / ROR disproportionality with 95% CI (Evans 2001 / van Puijenbroek 2002)
 * - Yates-corrected chi-square on the 2x2 table
 * - Evans/MHRA signal criterion: n >= 3, PRR >= 2, chi2 >= 4
 * - Rolling z-score spike detection on monthly report counts
 * - Recall linkage: earliest spike preceding each recall -> lead time in months
 */
import type { Dataset, MonthCount, Recall } from "./types";

const Z95 = 1.96;

// ---------------------------------------------------------------------------
// 2x2 disproportionality
//   a = reports for device D mentioning problem P
//   b = reports for D not mentioning P
//   c = reports for other devices mentioning P
//   d = reports for other devices not mentioning P
// ---------------------------------------------------------------------------

export interface Table2x2 {
  a: number;
  b: number;
  c: number;
  d: number;
}

export interface CIResult {
  value: number;
  lo: number;
  hi: number;
}

/** Proportional Reporting Ratio with 95% CI; null when undefined (zero cells). */
export function prr(t: Table2x2): CIResult | null {
  const { a, b, c, d } = t;
  if (a <= 0 || c <= 0 || a + b <= 0 || c + d <= 0) return null;
  const value = a / (a + b) / (c / (c + d));
  const se = Math.sqrt(1 / a - 1 / (a + b) + 1 / c - 1 / (c + d));
  return { value, lo: value * Math.exp(-Z95 * se), hi: value * Math.exp(Z95 * se) };
}

/** Reporting Odds Ratio with 95% CI; null when any cell is zero. */
export function ror(t: Table2x2): CIResult | null {
  const { a, b, c, d } = t;
  if (a <= 0 || b <= 0 || c <= 0 || d <= 0) return null;
  const value = (a * d) / (b * c);
  const se = Math.sqrt(1 / a + 1 / b + 1 / c + 1 / d);
  return { value, lo: value * Math.exp(-Z95 * se), hi: value * Math.exp(Z95 * se) };
}

/** Chi-square with Yates continuity correction. 0 when the table is degenerate. */
export function chiSquaredYates(t: Table2x2): number {
  const { a, b, c, d } = t;
  const n = a + b + c + d;
  const denom = (a + b) * (c + d) * (a + c) * (b + d);
  if (denom === 0) return 0;
  const diff = Math.abs(a * d - b * c) - n / 2;
  if (diff <= 0) return 0;
  return (n * diff * diff) / denom;
}

/** Evans/MHRA criterion: observed >= 3, PRR >= 2, chi2 >= 4. */
export function isSignal(observed: number, prrValue: number | null, chi2: number): boolean {
  return observed >= 3 && prrValue !== null && prrValue >= 2 && chi2 >= 4;
}

export interface SignalRow {
  product_code: string;
  device_name: string;
  problem: string;
  observed: number;
  expected: number;
  prr: CIResult | null;
  ror: CIResult | null;
  chi2: number;
  flagged: boolean;
}

/**
 * PRR/ROR/chi2 for every device x problem pair in the dataset. The background
 * (c/d cells) is the rest of the monitored device set, not all of MAUDE — a
 * deliberate scoping so mock and live behave identically.
 *
 * Sorted flagged-first, then by PRR descending.
 */
export function computeSignals(ds: Dataset): SignalRow[] {
  const deviceTotals: Record<string, number> = {};
  const problemTotals: Record<string, number> = {};
  let grand = 0;
  for (const [code, probs] of Object.entries(ds.deviceProblems)) {
    for (const [p, n] of Object.entries(probs)) {
      deviceTotals[code] = (deviceTotals[code] ?? 0) + n;
      problemTotals[p] = (problemTotals[p] ?? 0) + n;
      grand += n;
    }
  }
  const nameOf = new Map(ds.devices.map((d) => [d.product_code, d.device_name]));
  const rows: SignalRow[] = [];
  for (const [code, probs] of Object.entries(ds.deviceProblems)) {
    for (const [problem, a] of Object.entries(probs)) {
      if (a <= 0) continue;
      const b = (deviceTotals[code] ?? 0) - a;
      const c = (problemTotals[problem] ?? 0) - a;
      const d = grand - a - b - c;
      const t = { a, b, c, d };
      const p = prr(t);
      const chi2 = chiSquaredYates(t);
      rows.push({
        product_code: code,
        device_name: nameOf.get(code) ?? code,
        problem,
        observed: a,
        expected: grand > 0 ? ((a + b) * (a + c)) / grand : 0,
        prr: p,
        ror: ror(t),
        chi2,
        flagged: isSignal(a, p?.value ?? null, chi2),
      });
    }
  }
  rows.sort((x, y) => {
    if (x.flagged !== y.flagged) return x.flagged ? -1 : 1;
    return (y.prr?.value ?? 0) - (x.prr?.value ?? 0);
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Trend spike detection (rolling z-score over trailing months)
// ---------------------------------------------------------------------------

export interface SpikePoint {
  month: string;
  count: number;
  mean: number | null; // trailing-baseline mean (null while baseline too short)
  z: number | null;
  spike: boolean;
}

export interface SpikeOptions {
  window?: number; // trailing months used as baseline (default 12)
  zThreshold?: number; // flag at/above this z (default 3)
  minBaseline?: number; // months of history required before flagging (default 6)
}

/**
 * Rolling z-score against the trailing baseline. The std-dev is floored at
 * sqrt(mean) (Poisson noise floor) and at 1, so flat low-count baselines don't
 * produce divide-by-zero infinities.
 */
export function detectSpikes(series: MonthCount[], opts: SpikeOptions = {}): SpikePoint[] {
  const window = opts.window ?? 12;
  const zThreshold = opts.zThreshold ?? 3;
  const minBaseline = opts.minBaseline ?? 6;
  return series.map((pt, i) => {
    const start = Math.max(0, i - window);
    const base = series.slice(start, i).map((m) => m.count);
    if (base.length < minBaseline) {
      return { month: pt.month, count: pt.count, mean: null, z: null, spike: false };
    }
    const mean = base.reduce((s, v) => s + v, 0) / base.length;
    const variance = base.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, base.length - 1);
    const sd = Math.max(Math.sqrt(variance), Math.sqrt(Math.max(mean, 0)), 1);
    const z = (pt.count - mean) / sd;
    return { month: pt.month, count: pt.count, mean, z, spike: z >= zThreshold };
  });
}

// ---------------------------------------------------------------------------
// Recall linkage
// ---------------------------------------------------------------------------

/** Whole months from "yyyy-mm" a to "yyyy-mm" b (positive when b is later). */
export function monthDiff(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
}

export interface RecallLink {
  recall: Recall;
  signalMonth: string | null; // earliest spike within the lookback, or null
  leadMonths: number | null;
}

/**
 * For each recall, the earliest spike month for the same product code within
 * `lookback` months before (or in) the recall-initiation month.
 */
export function linkRecalls(
  recalls: Recall[],
  spikesByDevice: Record<string, SpikePoint[]>,
  lookback = 24,
): RecallLink[] {
  return recalls.map((recall) => {
    const recallMonth = recall.event_date_initiated.slice(0, 7);
    const spikes = (spikesByDevice[recall.product_code] ?? []).filter((s) => s.spike);
    const preceding = spikes
      .map((s) => ({ month: s.month, lead: monthDiff(s.month, recallMonth) }))
      .filter((s) => s.lead >= 0 && s.lead <= lookback)
      .sort((x, y) => y.lead - x.lead);
    const first = preceding[0];
    return {
      recall,
      signalMonth: first?.month ?? null,
      leadMonths: first?.lead ?? null,
    };
  });
}

/** Median of a list (null when empty). */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

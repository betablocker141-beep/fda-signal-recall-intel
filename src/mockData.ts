/**
 * Deterministic seeded mock dataset (mock-first, same philosophy as the MAUDE
 * project). 36 months of device x problem counts with three injected signals
 * and three recalls:
 *
 *   FRN Infusion Pump      — Software Error x6 from 2025-03, recall 2025-11 (should link, ~8 mo lead)
 *   GAT Surgical Stapler   — Break/Fracture x4 from 2024-10, recall 2025-04 (should link, ~6 mo lead)
 *   NBW Glucose Meter      — Inaccurate Reading x4 from 2025-09, NO recall yet (open signal)
 *   CBK Ventilator         — recall 2025-01 with NO preceding signal (the "miss" case)
 *
 * Codes/names are illustrative, not authoritative product-code mappings.
 */
import type { Dataset, DeviceInfo, MonthCount, Recall } from "./types";

export const MOCK_DEVICES: DeviceInfo[] = [
  { product_code: "FRN", device_name: "Infusion Pump" },
  { product_code: "NBW", device_name: "Blood Glucose Meter (OTC)" },
  { product_code: "CBK", device_name: "Continuous Ventilator" },
  { product_code: "GAT", device_name: "Surgical Stapler" },
  { product_code: "DYE", device_name: "Intravascular Catheter" },
  { product_code: "DQA", device_name: "Pulse Oximeter" },
];

const PROBLEMS = [
  "Software Error",
  "Battery Failure",
  "Alarm Failure",
  "Occlusion",
  "Break/Fracture",
  "Inaccurate Reading",
  "Connection Problem",
  "Overheating",
] as const;

/** Baseline mean problem-mentions per month, per device x problem. */
const BASE_RATES: Record<string, Partial<Record<(typeof PROBLEMS)[number], number>>> = {
  FRN: { "Software Error": 4, "Battery Failure": 3, "Alarm Failure": 3, Occlusion: 5, "Connection Problem": 2 },
  NBW: { "Inaccurate Reading": 5, "Battery Failure": 2, "Software Error": 2, "Connection Problem": 1 },
  CBK: { "Alarm Failure": 4, "Software Error": 3, Overheating: 1, "Connection Problem": 2 },
  GAT: { "Break/Fracture": 3, "Connection Problem": 1, Occlusion: 1 },
  DYE: { Occlusion: 4, "Break/Fracture": 2, "Connection Problem": 2 },
  DQA: { "Inaccurate Reading": 3, "Battery Failure": 2, "Connection Problem": 2, "Software Error": 1 },
};

interface Injection {
  code: string;
  problem: (typeof PROBLEMS)[number];
  from: string; // "yyyy-mm" onset
  factor: number;
}

const INJECTED: Injection[] = [
  { code: "FRN", problem: "Software Error", from: "2025-03", factor: 6 },
  { code: "GAT", problem: "Break/Fracture", from: "2024-10", factor: 4 },
  { code: "NBW", problem: "Inaccurate Reading", from: "2025-09", factor: 4 },
];

const MOCK_RECALLS: Recall[] = [
  {
    recall_id: "Z-1041-2026",
    product_code: "FRN",
    event_date_initiated: "2025-11-14",
    recalling_firm: "Meditek Systems Inc.",
    description: "Infusion pump software may miscalculate dose rate after pause/resume.",
    root_cause: "Software design",
    status: "Open, Classified",
  },
  {
    recall_id: "Z-0522-2025",
    product_code: "GAT",
    event_date_initiated: "2025-04-02",
    recalling_firm: "SurgiCore Devices LLC",
    description: "Stapler jaw may fracture during firing, retaining fragments.",
    root_cause: "Component design/selection",
    status: "Open, Classified",
  },
  {
    recall_id: "Z-0217-2025",
    product_code: "CBK",
    event_date_initiated: "2025-01-20",
    recalling_firm: "VentAir Medical Corp.",
    description: "Inlet filter lot manufactured with nonconforming material.",
    root_cause: "Nonconforming material",
    status: "Terminated",
  },
];

// ---- deterministic PRNG + Poisson sampling ----

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Knuth Poisson sampler — fine for the small lambdas used here. */
function poisson(lambda: number, rand: () => number): number {
  if (lambda <= 0) return 0;
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rand();
  } while (p > limit);
  return k - 1;
}

// ---- month scaffolding ----

const MOCK_MONTHS: string[] = (() => {
  const out: string[] = [];
  for (let y = 2023, m = 7; !(y === 2026 && m === 7); m === 12 ? ((m = 1), (y += 1)) : (m += 1)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  return out;
})(); // 2023-07 .. 2026-06, 36 months

interface Cell {
  code: string;
  problem: string;
  month: string;
  count: number;
}

let _cells: Cell[] | null = null;

function cells(): Cell[] {
  if (_cells) return _cells;
  const rand = mulberry32(42);
  const out: Cell[] = [];
  for (const dev of MOCK_DEVICES) {
    const rates = BASE_RATES[dev.product_code] ?? {};
    for (const problem of PROBLEMS) {
      const base = rates[problem] ?? 0;
      if (base === 0) continue;
      const inj = INJECTED.find((i) => i.code === dev.product_code && i.problem === problem);
      for (const month of MOCK_MONTHS) {
        let lambda = base;
        if (inj && month >= inj.from) lambda = base * inj.factor;
        out.push({ code: dev.product_code, problem, month, count: poisson(lambda, rand) });
      }
    }
  }
  _cells = out;
  return out;
}

/** The mock dataset for the trailing `windowMonths` of the 36-month range. */
export function generateMockDataset(windowMonths: number): Dataset {
  const months = MOCK_MONTHS.slice(Math.max(0, MOCK_MONTHS.length - windowMonths));
  const inWindow = new Set(months);
  const deviceMonthly: Record<string, MonthCount[]> = {};
  const deviceProblems: Record<string, Record<string, number>> = {};
  for (const dev of MOCK_DEVICES) {
    const monthly = new Map(months.map((m) => [m, 0]));
    deviceProblems[dev.product_code] = {};
    for (const cell of cells()) {
      if (cell.code !== dev.product_code || !inWindow.has(cell.month)) continue;
      monthly.set(cell.month, (monthly.get(cell.month) ?? 0) + cell.count);
      deviceProblems[dev.product_code][cell.problem] =
        (deviceProblems[dev.product_code][cell.problem] ?? 0) + cell.count;
    }
    deviceMonthly[dev.product_code] = months.map((m) => ({ month: m, count: monthly.get(m) ?? 0 }));
  }
  const from = `${months[0]}-01`;
  return {
    months,
    devices: MOCK_DEVICES,
    deviceMonthly,
    deviceProblems,
    recalls: MOCK_RECALLS.filter((r) => r.event_date_initiated >= from),
    meta: { source: "mock", fetched_at: new Date().toISOString(), window_months: windowMonths },
  };
}

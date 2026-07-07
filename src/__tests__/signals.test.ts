import { describe, expect, it } from "vitest";
import { generateMockDataset } from "../mockData";
import {
  chiSquaredYates,
  computeSignals,
  detectSpikes,
  isSignal,
  linkRecalls,
  median,
  monthDiff,
  prr,
  ror,
} from "../signals";
import type { Dataset, Recall } from "../types";

// Hand-computed reference table: a=20 b=80 c=100 d=900
//   PRR  = (20/100)/(100/1000) = 2.0
//   ROR  = (20*900)/(80*100)   = 2.25
//   chi2 (Yates) = 1100*(|18000-8000|-550)^2 / (100*1000*120*980) = 8.3531
const T = { a: 20, b: 80, c: 100, d: 900 };

describe("prr", () => {
  it("matches the hand-computed value and CI", () => {
    const r = prr(T)!;
    expect(r.value).toBeCloseTo(2.0, 6);
    // se = sqrt(1/20 - 1/100 + 1/100 - 1/1000) = sqrt(0.049)
    expect(r.lo).toBeCloseTo(2 * Math.exp(-1.96 * Math.sqrt(0.049)), 4);
    expect(r.hi).toBeCloseTo(2 * Math.exp(1.96 * Math.sqrt(0.049)), 4);
  });
  it("is null on zero cells", () => {
    expect(prr({ a: 0, b: 10, c: 5, d: 100 })).toBeNull();
    expect(prr({ a: 5, b: 10, c: 0, d: 100 })).toBeNull();
  });
});

describe("ror", () => {
  it("matches the hand-computed value and CI", () => {
    const r = ror(T)!;
    expect(r.value).toBeCloseTo(2.25, 6);
    const se = Math.sqrt(1 / 20 + 1 / 80 + 1 / 100 + 1 / 900);
    expect(r.lo).toBeCloseTo(2.25 * Math.exp(-1.96 * se), 4);
    expect(r.hi).toBeCloseTo(2.25 * Math.exp(1.96 * se), 4);
  });
  it("is null when any cell is zero", () => {
    expect(ror({ a: 5, b: 0, c: 5, d: 100 })).toBeNull();
  });
});

describe("chiSquaredYates", () => {
  it("matches the hand-computed value", () => {
    expect(chiSquaredYates(T)).toBeCloseTo(8.3531, 3);
  });
  it("is 0 on degenerate tables", () => {
    expect(chiSquaredYates({ a: 0, b: 0, c: 10, d: 10 })).toBe(0);
  });
});

describe("isSignal (Evans/MHRA)", () => {
  it("requires n>=3, PRR>=2, chi2>=4 simultaneously", () => {
    expect(isSignal(3, 2, 4)).toBe(true);
    expect(isSignal(2, 5, 10)).toBe(false); // n too small
    expect(isSignal(10, 1.9, 10)).toBe(false); // PRR too small
    expect(isSignal(10, 5, 3.9)).toBe(false); // chi2 too small
    expect(isSignal(10, null, 10)).toBe(false);
  });
});

describe("computeSignals", () => {
  it("builds the 2x2 from device/problem totals", () => {
    const ds: Dataset = {
      months: ["2025-01"],
      devices: [
        { product_code: "X", device_name: "Device X" },
        { product_code: "Y", device_name: "Device Y" },
      ],
      deviceMonthly: { X: [], Y: [] },
      deviceProblems: {
        X: { P: 20, Q: 80 },
        Y: { P: 100, Q: 900 },
      },
      recalls: [],
      meta: { source: "mock", fetched_at: "", window_months: 12 },
    };
    const rows = computeSignals(ds);
    const xp = rows.find((r) => r.product_code === "X" && r.problem === "P")!;
    expect(xp.observed).toBe(20);
    expect(xp.prr!.value).toBeCloseTo(2.0, 6);
    expect(xp.ror!.value).toBeCloseTo(2.25, 6);
    expect(xp.chi2).toBeCloseTo(8.3531, 3);
    expect(xp.flagged).toBe(true);
    expect(xp.expected).toBeCloseTo((100 * 120) / 1100, 4);
    // flagged rows sort first
    expect(rows[0].flagged).toBe(true);
  });
});

describe("detectSpikes", () => {
  const flat = (n: number, count: number) =>
    Array.from({ length: n }, (_, i) => ({ month: `2025-${String(i + 1).padStart(2, "0")}`, count }));

  it("flags a jump above a flat baseline", () => {
    const series = [...flat(12, 5), { month: "2026-01", count: 20 }];
    const pts = detectSpikes(series);
    // sd floored at sqrt(5): z = 15/2.236 ≈ 6.7
    expect(pts[12].spike).toBe(true);
    expect(pts[12].z!).toBeGreaterThan(3);
  });

  it("does not flag while the baseline is too short", () => {
    const series = [...flat(3, 5), { month: "2025-04", count: 50 }];
    const pts = detectSpikes(series);
    expect(pts[3].spike).toBe(false);
    expect(pts[3].z).toBeNull();
  });

  it("does not flag a flat series", () => {
    expect(detectSpikes(flat(24, 5)).some((p) => p.spike)).toBe(false);
  });
});

describe("monthDiff / linkRecalls / median", () => {
  it("monthDiff counts whole months", () => {
    expect(monthDiff("2025-03", "2025-11")).toBe(8);
    expect(monthDiff("2024-11", "2025-01")).toBe(2);
    expect(monthDiff("2025-05", "2025-05")).toBe(0);
  });

  const recall = (code: string, date: string): Recall => ({
    recall_id: `R-${code}`,
    product_code: code,
    event_date_initiated: date,
    recalling_firm: "Firm",
    description: "",
    root_cause: "",
    status: "",
  });
  const spike = (month: string, on = true) => ({ month, count: 0, mean: 0, z: 5, spike: on });

  it("links a recall to the earliest preceding spike within lookback", () => {
    const links = linkRecalls([recall("FRN", "2025-11-14")], {
      FRN: [spike("2025-03"), spike("2025-05"), spike("2024-01")], // 2024-01 is beyond 24? no: 22mo, within
    });
    expect(links[0].signalMonth).toBe("2024-01");
    expect(links[0].leadMonths).toBe(22);
  });

  it("ignores spikes after the recall and reports misses", () => {
    const links = linkRecalls([recall("CBK", "2025-01-20")], {
      CBK: [spike("2025-06")],
    });
    expect(links[0].signalMonth).toBeNull();
    expect(links[0].leadMonths).toBeNull();
  });

  it("median handles odd/even/empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("mock dataset end-to-end", () => {
  it("the injected signals are detected and the seeded recalls link as designed", () => {
    const ds = generateMockDataset(36);
    const rows = computeSignals(ds);
    const frn = rows.find((r) => r.product_code === "FRN" && r.problem === "Software Error")!;
    expect(frn.flagged).toBe(true);

    const spikes: Record<string, ReturnType<typeof detectSpikes>> = {};
    for (const d of ds.devices) spikes[d.product_code] = detectSpikes(ds.deviceMonthly[d.product_code]);
    const links = linkRecalls(ds.recalls, spikes);

    const frnLink = links.find((l) => l.recall.product_code === "FRN")!;
    expect(frnLink.leadMonths).not.toBeNull();
    expect(frnLink.leadMonths!).toBeGreaterThanOrEqual(1);

    const cbk = links.find((l) => l.recall.product_code === "CBK")!;
    expect(cbk.leadMonths).toBeNull(); // the designed "miss" case
  });

  it("is deterministic", () => {
    const a = generateMockDataset(24);
    const b = generateMockDataset(24);
    expect(a.deviceProblems).toEqual(b.deviceProblems);
  });
});

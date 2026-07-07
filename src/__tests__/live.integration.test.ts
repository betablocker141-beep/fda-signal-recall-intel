/**
 * Opt-in live integration test — hits the real openFDA API.
 * Run with:  LIVE=1 npx vitest run   (skipped in the normal suite)
 * Requires VITE_OPENFDA_API_KEY in .env.
 */
import { describe, expect, it } from "vitest";
import { fetchLiveDataset } from "../openfda";
import { computeSignals } from "../signals";

// vitest runs in node; the app tsconfig has no node types, so declare just this
declare const process: { env: Record<string, string | undefined> };

describe.runIf(process.env.LIVE === "1")("openFDA live path", () => {
  it("fetches a real 12-month dataset and computes signals from it", { timeout: 120_000 }, async () => {
    const ds = await fetchLiveDataset(12);
    expect(ds.meta.source).toBe("live");
    expect(ds.months).toHaveLength(12);
    expect(ds.devices.length).toBeGreaterThan(0);

    // every monitored device should have real problem mentions
    for (const d of ds.devices) {
      const mentions = Object.values(ds.deviceProblems[d.product_code] ?? {}).reduce((s, n) => s + n, 0);
      expect(mentions, `${d.product_code} problem mentions`).toBeGreaterThan(0);
      const monthly = ds.deviceMonthly[d.product_code] ?? [];
      expect(monthly).toHaveLength(12);
      expect(monthly.reduce((s, m) => s + m.count, 0), `${d.product_code} monthly total`).toBeGreaterThan(0);
    }

    // the statistics pipeline runs on real data
    const rows = computeSignals(ds);
    expect(rows.length).toBeGreaterThan(50);
    expect(rows.every((r) => r.observed > 0)).toBe(true);
  });
});

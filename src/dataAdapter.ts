/**
 * THE ONLY mock <=> live swap point (same pattern as the MAUDE project).
 * The dashboard imports only `loadDataset()` and never knows whether the
 * dataset came from the seeded mock generator or live openFDA.
 *
 * Flip SOURCE to "live" to query openFDA directly from the browser; on any
 * live failure it falls back to the mock dataset (and says so in meta.source).
 */
import { generateMockDataset } from "./mockData";
import { fetchLiveDataset } from "./openfda";
import type { Dataset } from "./types";

export const SOURCE: "mock" | "live" = "live";

export async function loadDataset(
  windowMonths: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Dataset> {
  if (SOURCE === "mock") return generateMockDataset(windowMonths);
  try {
    return await fetchLiveDataset(windowMonths, onProgress);
  } catch (e: any) {
    console.warn("[dataAdapter] openFDA unavailable, using mock dataset:", e?.message ?? e);
    return generateMockDataset(windowMonths);
  }
}

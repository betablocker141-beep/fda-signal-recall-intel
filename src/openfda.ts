/**
 * Live openFDA client. Browser-direct (openFDA supports CORS).
 *
 * NOTE: openFDA now requires an API key for device/event (403 API_KEY_MISSING
 * without one); device/recall still works anonymously. Get a free key at
 * https://open.fda.gov/apis/authentication/ and put it in `.env` as
 * VITE_OPENFDA_API_KEY=yourkey
 *
 * Per monitored device it issues:
 *   device/event  count=product_problems.exact   -> deviceProblems (window totals)
 *   device/event  count=date_received            -> deviceMonthly (per calendar
 *                 year, because count queries cap at 1000 buckets and a 36-month
 *                 window spans ~1095 days)
 *   device/recall search=product_code:"X"        -> recalls
 */
import type { Dataset, DeviceInfo, MonthCount, Recall } from "./types";

const BASE = "https://api.fda.gov";

/**
 * The device set under surveillance. Selected data-driven: the highest
 * MAUDE-report-volume product codes (2024+), names from the official
 * device/classification endpoint. Edit freely — each device costs ~6 API
 * requests per 36-month load.
 */
export const MONITORED_DEVICES: DeviceInfo[] = [
  // diabetes care
  { product_code: "QBJ", device_name: "Integrated Continuous Glucose Monitor (iCGM)" },
  { product_code: "QLG", device_name: "Integrated CGM, Factory Calibrated" },
  { product_code: "PQF", device_name: "Glucose Sensor, Invasive, Non-Adjunctive" },
  { product_code: "QFG", device_name: "Insulin Infusion Pump, Alternate Controller Enabled" },
  { product_code: "OZP", device_name: "Automated Insulin Dosing System" },
  { product_code: "LZG", device_name: "Pump, Infusion, Insulin" },
  { product_code: "OYC", device_name: "Insulin Pump w/ Invasive Glucose Sensor" },
  { product_code: "NBW", device_name: "Blood Glucose Test System (OTC)" },
  // infusion & vascular access
  { product_code: "FRN", device_name: "Pump, Infusion" },
  { product_code: "FPA", device_name: "Set, Administration, Intravascular" },
  { product_code: "DYE", device_name: "Catheter, Intravascular, Therapeutic" },
  // cardiac rhythm & circulatory support
  { product_code: "LWP", device_name: "Implantable Pulse Generator, Pacemaker" },
  { product_code: "DTB", device_name: "Permanent Pacemaker Electrode" },
  { product_code: "LWS", device_name: "Implantable Cardioverter Defibrillator" },
  { product_code: "NIK", device_name: "Implantable Cardioverter Defibrillator w/ CRT" },
  { product_code: "MKJ", device_name: "Automated External Defibrillator" },
  { product_code: "MVK", device_name: "Wearable Automated External Defibrillator" },
  { product_code: "OZD", device_name: "Temporary Left Heart Support Blood Pump" },
  { product_code: "DSQ", device_name: "Ventricular (Assist) Bypass" },
  { product_code: "NPT", device_name: "Aortic Valve Prosthesis, Percutaneous (TAVR)" },
  // respiratory
  { product_code: "CBK", device_name: "Ventilator, Continuous, Facility Use" },
  { product_code: "BZD", device_name: "Ventilator, Non-Continuous (Respirator)" },
  { product_code: "DQA", device_name: "Oximeter, Pulse" },
  // surgical
  { product_code: "NAY", device_name: "Computer-Controlled Surgical System (Robot)" },
  { product_code: "GDW", device_name: "Staple, Implantable" },
  { product_code: "GEI", device_name: "Electrosurgical Cutting & Coagulation" },
  // implants & prosthetics
  { product_code: "DZE", device_name: "Dental Implant, Endosseous, Root-Form" },
  { product_code: "LGW", device_name: "Spinal Cord Stimulator, Implanted (Pain)" },
  { product_code: "FTR", device_name: "Breast Prosthesis, Silicone Gel-Filled" },
  { product_code: "FWM", device_name: "Breast Prosthesis, Inflatable (Saline)" },
  { product_code: "JWH", device_name: "Knee Prosthesis, Semi-Constrained, Cemented" },
  // endoscopy
  { product_code: "FDF", device_name: "Colonoscope and Accessories" },
  { product_code: "FDS", device_name: "Gastroscope and Accessories" },
  { product_code: "EOQ", device_name: "Bronchoscope" },
];

function apiKeyParam(): string {
  const key = import.meta.env.VITE_OPENFDA_API_KEY as string | undefined;
  return key ? `&api_key=${encodeURIComponent(key)}` : "";
}

// ---- global throttle: keyed openFDA allows 240 req/min; pace at ~215/min ----
const REQUEST_SPACING_MS = 280;
let nextRequestAt = 0;
async function throttle(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextRequestAt);
  nextRequestAt = at + REQUEST_SPACING_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * openFDA returns HTTP 404 for zero matches — treat that as an empty result.
 * 429 (rate limit) and 5xx are retried with backoff; 403 means missing key.
 */
async function getJson(url: string, attempt = 0): Promise<any | null> {
  await throttle();
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    if (attempt >= 3) throw e;
    await sleep(1000 * 2 ** attempt);
    return getJson(url, attempt + 1);
  }
  if (res.status === 404) return null;
  if (res.status === 403) {
    throw new Error(
      "openFDA 403 — device/event requires an API key. Get a free key at " +
        "https://open.fda.gov/apis/authentication/ and set VITE_OPENFDA_API_KEY in .env",
    );
  }
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    const retryAfter = Number(res.headers.get("retry-after")) || 0;
    await sleep(Math.max(retryAfter * 1000, 1000 * 2 ** attempt));
    return getJson(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`openFDA ${res.status}: ${url}`);
  return res.json();
}

async function countQuery(
  endpoint: string,
  search: string,
  countField: string,
): Promise<Array<{ term?: string; time?: string; count: number }>> {
  const url = `${BASE}/${endpoint}.json?search=${encodeURIComponent(search)}&count=${countField}&limit=1000${apiKeyParam()}`;
  const j = await getJson(url);
  return j?.results ?? [];
}

function yyyymmdd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** Trailing full months ["yyyy-mm", ...] ending with the current month. */
export function trailingMonths(windowMonths: number, today = new Date()): string[] {
  const out: string[] = [];
  let y = today.getFullYear();
  let m = today.getMonth() + 1;
  for (let i = 0; i < windowMonths; i++) {
    out.unshift(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

async function fetchDeviceProblems(code: string, from: string, to: string): Promise<Record<string, number>> {
  const search = `device.device_report_product_code:"${code}" AND date_received:[${from} TO ${to}]`;
  const rows = await countQuery("device/event", search, "product_problems.exact");
  const out: Record<string, number> = {};
  for (const r of rows) if (r.term) out[r.term] = r.count;
  return out;
}

/** Split [from, to] (yyyymmdd) into spans of <= 900 days (count cap is 1000 buckets). */
function dateSpans(from: string, to: string): Array<[string, string]> {
  const parse = (s: string) => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00`);
  const spans: Array<[string, string]> = [];
  let cursor = parse(from);
  const end = parse(to);
  while (cursor <= end) {
    const spanEnd = new Date(cursor);
    spanEnd.setDate(spanEnd.getDate() + 899);
    spans.push([yyyymmdd(cursor), yyyymmdd(spanEnd < end ? spanEnd : end)]);
    cursor = new Date(spanEnd);
    cursor.setDate(cursor.getDate() + 1);
  }
  return spans;
}

async function fetchDeviceMonthly(code: string, from: string, to: string, months: string[]): Promise<MonthCount[]> {
  const byMonth = new Map(months.map((m) => [m, 0]));
  for (const [sFrom, sTo] of dateSpans(from, to)) {
    const search = `device.device_report_product_code:"${code}" AND date_received:[${sFrom} TO ${sTo}]`;
    const rows = await countQuery("device/event", search, "date_received");
    for (const r of rows) {
      if (!r.time || r.time.length < 6) continue;
      const month = `${r.time.slice(0, 4)}-${r.time.slice(4, 6)}`;
      if (byMonth.has(month)) byMonth.set(month, (byMonth.get(month) ?? 0) + r.count);
    }
  }
  return months.map((m) => ({ month: m, count: byMonth.get(m) ?? 0 }));
}

async function fetchRecalls(code: string): Promise<Recall[]> {
  const url = `${BASE}/device/recall.json?search=${encodeURIComponent(`product_code:"${code}"`)}&limit=100${apiKeyParam()}`;
  const j = await getJson(url);
  const results: any[] = j?.results ?? [];
  return results
    .map((r, i): Recall => {
      const raw = String(r.event_date_initiated ?? "");
      // normalize "yyyymmdd" or "yyyy-mm-dd" to "yyyy-mm-dd"
      const date = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw;
      return {
        recall_id: String(r.res_event_number ?? r.product_res_number ?? `${code}-${i}`),
        product_code: code,
        event_date_initiated: date,
        recalling_firm: String(r.recalling_firm ?? "Unknown firm"),
        description: String(r.product_description ?? r.reason_for_recall ?? ""),
        root_cause: String(r.root_cause_description ?? "Unknown"),
        status: String(r.recall_status ?? ""),
      };
    })
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.event_date_initiated));
}

/**
 * The full live dataset for the trailing window across MONITORED_DEVICES.
 * Requests are globally throttled under the openFDA rate limit; a device that
 * still fails after retries is skipped (with a console warning) instead of
 * failing the whole load. Throws only when every device failed.
 */
export async function fetchLiveDataset(
  windowMonths: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Dataset> {
  const months = trailingMonths(windowMonths);
  const fromDate = new Date(`${months[0]}-01T00:00:00`);
  const from = yyyymmdd(fromDate);
  const to = yyyymmdd(new Date());
  const fromIso = `${months[0]}-01`;

  const deviceMonthly: Record<string, MonthCount[]> = {};
  const deviceProblems: Record<string, Record<string, number>> = {};
  const recalls: Recall[] = [];
  const succeeded: DeviceInfo[] = [];
  const failed: string[] = [];
  let done = 0;

  // the pool keeps a few devices in flight; the global throttle sets the pace
  const CONCURRENCY = 4;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, MONITORED_DEVICES.length) }, async () => {
      while (next < MONITORED_DEVICES.length) {
        const dev = MONITORED_DEVICES[next++];
        const code = dev.product_code;
        try {
          const problems = await fetchDeviceProblems(code, from, to);
          const monthly = await fetchDeviceMonthly(code, from, to, months);
          const r = await fetchRecalls(code);
          deviceProblems[code] = problems;
          deviceMonthly[code] = monthly;
          recalls.push(...r.filter((x) => x.event_date_initiated >= fromIso));
          succeeded.push(dev);
        } catch (e: any) {
          failed.push(code);
          console.warn(`[openfda] ${code} failed, skipping:`, e?.message ?? e);
        }
        done += 1;
        onProgress?.(done, MONITORED_DEVICES.length);
      }
    }),
  );

  if (succeeded.length === 0) throw new Error(`openFDA: all ${MONITORED_DEVICES.length} devices failed`);
  if (failed.length > 0) console.warn(`[openfda] loaded ${succeeded.length}, skipped ${failed.join(", ")}`);

  // keep the original list order for the UI
  const devices = MONITORED_DEVICES.filter((d) => succeeded.some((s) => s.product_code === d.product_code));
  return {
    months,
    devices,
    deviceMonthly,
    deviceProblems,
    recalls: recalls.sort((a, b) => b.event_date_initiated.localeCompare(a.event_date_initiated)),
    meta: { source: "live", fetched_at: new Date().toISOString(), window_months: windowMonths },
  };
}

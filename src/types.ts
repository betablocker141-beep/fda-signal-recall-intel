/** Shared types for the signal + recall intelligence dashboard. */

export interface MonthCount {
  month: string; // "yyyy-mm"
  count: number;
}

export interface DeviceInfo {
  product_code: string;
  device_name: string;
}

export interface Recall {
  recall_id: string;
  product_code: string;
  event_date_initiated: string; // "yyyy-mm-dd"
  recalling_firm: string;
  description: string;
  root_cause: string;
  status: string;
}

/**
 * The dataset shape both sources (mock generator / live openFDA) produce.
 *
 * - `deviceMonthly`: report counts per month per product code (trend / spike input)
 * - `deviceProblems`: problem-mention counts per product code over the whole
 *   window (2x2 disproportionality input). A report can mention several
 *   problems, so these are MENTION counts, consistent with openFDA's
 *   `count=product_problems.exact`.
 */
export interface Dataset {
  months: string[]; // sorted "yyyy-mm" covering the window
  devices: DeviceInfo[];
  deviceMonthly: Record<string, MonthCount[]>;
  deviceProblems: Record<string, Record<string, number>>;
  recalls: Recall[];
  meta: {
    source: "mock" | "live";
    fetched_at: string;
    window_months: number;
  };
}

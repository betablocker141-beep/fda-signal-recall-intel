import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { loadDataset } from "./dataAdapter";
import {
  computeSignals,
  detectSpikes,
  linkRecalls,
  median,
  type RecallLink,
  type SignalRow,
  type SpikePoint,
} from "./signals";
import type { Dataset } from "./types";

const WINDOWS = [12, 24, 36] as const;

function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  return n.toFixed(digits);
}

function ci(r: { value: number; lo: number; hi: number } | null): string {
  if (!r) return "—";
  return `${fmt(r.value)} (${fmt(r.lo)}–${fmt(r.hi)})`;
}

export default function App() {
  const [windowMonths, setWindowMonths] = useState<(typeof WINDOWS)[number]>(36);
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loadDataset(windowMonths).then((ds) => {
      if (!alive) return;
      setDataset(ds);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [windowMonths]);

  const signals: SignalRow[] = useMemo(() => (dataset ? computeSignals(dataset) : []), [dataset]);

  const spikesByDevice: Record<string, SpikePoint[]> = useMemo(() => {
    if (!dataset) return {};
    const out: Record<string, SpikePoint[]> = {};
    for (const dev of dataset.devices) {
      out[dev.product_code] = detectSpikes(dataset.deviceMonthly[dev.product_code] ?? []);
    }
    return out;
  }, [dataset]);

  const links: RecallLink[] = useMemo(
    () => (dataset ? linkRecalls(dataset.recalls, spikesByDevice) : []),
    [dataset, spikesByDevice],
  );

  // default selection: first flagged device, else first device
  useEffect(() => {
    if (!dataset) return;
    if (selected && dataset.devices.some((d) => d.product_code === selected)) return;
    setSelected(signals.find((s) => s.flagged)?.product_code ?? dataset.devices[0]?.product_code ?? "");
  }, [dataset, signals, selected]);

  const kpis = useMemo(() => {
    const totalReports = dataset
      ? Object.values(dataset.deviceMonthly).reduce((s, series) => s + series.reduce((x, m) => x + m.count, 0), 0)
      : 0;
    const flagged = signals.filter((s) => s.flagged).length;
    const linked = links.filter((l) => l.leadMonths !== null);
    return {
      totalReports,
      devices: dataset?.devices.length ?? 0,
      flagged,
      recalls: dataset?.recalls.length ?? 0,
      medianLead: median(linked.map((l) => l.leadMonths as number)),
    };
  }, [dataset, signals, links]);

  const chartData = spikesByDevice[selected] ?? [];
  const selectedRecalls = (dataset?.recalls ?? []).filter((r) => r.product_code === selected);
  const selectedName = dataset?.devices.find((d) => d.product_code === selected)?.device_name ?? selected;

  return (
    <div className="app">
      <header>
        <div>
          <h1>FDA Device Signal &amp; Recall Intelligence</h1>
          <p className="sub">
            PRR / ROR disproportionality + trend spike detection, linked to device recalls
          </p>
        </div>
        <div className="meta">
          <span className={`badge src-${dataset?.meta.source ?? "mock"}`}>
            {(dataset?.meta.source ?? "mock").toUpperCase()}
          </span>
          {dataset && <span className="muted">fetched {new Date(dataset.meta.fetched_at).toLocaleString()}</span>}
        </div>
      </header>

      <div className="disclaimer">
        ⚠️ Research use only. MAUDE is passive surveillance: reporting is incomplete, unverified and biased.
        PRR/ROR measure <em>reporting disproportionality</em>, not risk, incidence or causality. Signal ≠ safety
        problem; absence of signal ≠ safety. Not for clinical or purchasing decisions.
      </div>

      <div className="controls">
        <label>
          Window{" "}
          <select value={windowMonths} onChange={(e) => setWindowMonths(Number(e.target.value) as any)}>
            {WINDOWS.map((w) => (
              <option key={w} value={w}>
                {w} months
              </option>
            ))}
          </select>
        </label>
        <label>
          Device{" "}
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            {(dataset?.devices ?? []).map((d) => (
              <option key={d.product_code} value={d.product_code}>
                {d.product_code} — {d.device_name}
              </option>
            ))}
          </select>
        </label>
        {loading && <span className="muted">loading…</span>}
      </div>

      <section className="kpis">
        <div className="card kpi">
          <div className="kpi-value">{kpis.totalReports.toLocaleString()}</div>
          <div className="kpi-label">Problem mentions in window</div>
        </div>
        <div className="card kpi">
          <div className="kpi-value">{kpis.devices}</div>
          <div className="kpi-label">Devices monitored</div>
        </div>
        <div className="card kpi">
          <div className="kpi-value warn">{kpis.flagged}</div>
          <div className="kpi-label">Flagged signals (Evans criteria)</div>
        </div>
        <div className="card kpi">
          <div className="kpi-value">{kpis.recalls}</div>
          <div className="kpi-label">Recalls in window</div>
        </div>
        <div className="card kpi">
          <div className="kpi-value">{kpis.medianLead === null ? "—" : `${kpis.medianLead} mo`}</div>
          <div className="kpi-label">Median signal → recall lead</div>
        </div>
      </section>

      <section className="card">
        <h2>
          Monthly reports — {selected} {selectedName}
        </h2>
        <p className="muted small">
          Red dots: months whose count is ≥ 3 SD above the trailing 12-month baseline. Dashed lines: recall
          initiation.
        </p>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="#2a3350" strokeDasharray="3 3" />
            <XAxis dataKey="month" tick={{ fill: "#8fa0c9", fontSize: 11 }} minTickGap={24} />
            <YAxis tick={{ fill: "#8fa0c9", fontSize: 11 }} allowDecimals={false} />
            <Tooltip
              contentStyle={{ background: "#141a2e", border: "1px solid #2a3350", borderRadius: 8 }}
              labelStyle={{ color: "#e6ebff" }}
              formatter={(v: any, name: any) => [v, name === "count" ? "reports" : name]}
            />
            <Line
              type="monotone"
              dataKey="count"
              stroke="#60a5fa"
              strokeWidth={2}
              isAnimationActive={false}
              dot={((p: any) => (
                <circle
                  key={p.index}
                  cx={p.cx}
                  cy={p.cy}
                  r={p.payload.spike ? 5 : 2.5}
                  fill={p.payload.spike ? "#f87171" : "#60a5fa"}
                  stroke="none"
                />
              )) as any}
            />
            {selectedRecalls.map((r) => (
              <ReferenceLine
                key={r.recall_id}
                x={r.event_date_initiated.slice(0, 7)}
                stroke="#fbbf24"
                strokeDasharray="6 4"
                label={{ value: "recall", fill: "#fbbf24", fontSize: 11, position: "top" }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </section>

      <div className="grid2">
        <section className="card">
          <h2>Disproportionality signals</h2>
          <p className="muted small">
            2×2 background = the other monitored devices. Flag = Evans/MHRA: n ≥ 3, PRR ≥ 2, χ² ≥ 4.
          </p>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Problem</th>
                  <th className="num">Obs</th>
                  <th className="num">Exp</th>
                  <th className="num">PRR (95% CI)</th>
                  <th className="num">ROR (95% CI)</th>
                  <th className="num">χ²</th>
                  <th>Signal</th>
                </tr>
              </thead>
              <tbody>
                {signals.slice(0, 40).map((s) => (
                  <tr
                    key={`${s.product_code}|${s.problem}`}
                    className={s.product_code === selected ? "hl" : ""}
                    onClick={() => setSelected(s.product_code)}
                  >
                    <td>
                      <strong>{s.product_code}</strong> <span className="muted">{s.device_name}</span>
                    </td>
                    <td>{s.problem}</td>
                    <td className="num">{s.observed}</td>
                    <td className="num">{fmt(s.expected, 1)}</td>
                    <td className="num">{ci(s.prr)}</td>
                    <td className="num">{ci(s.ror)}</td>
                    <td className="num">{fmt(s.chi2, 1)}</td>
                    <td>{s.flagged ? <span className="badge flag">SIGNAL</span> : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <h2>Recalls &amp; signal lead time</h2>
          <p className="muted small">
            For each recall: the earliest trend spike for the same product code in the prior 24 months.
          </p>
          {links.length === 0 && <p className="muted">No recalls in window.</p>}
          {links.map((l) => (
            <div key={l.recall.recall_id} className="recall" onClick={() => setSelected(l.recall.product_code)}>
              <div className="recall-head">
                <strong>
                  {l.recall.product_code} · {l.recall.recalling_firm}
                </strong>
                <span className="muted">{l.recall.event_date_initiated}</span>
              </div>
              <div className="small">{l.recall.description}</div>
              <div className="small muted">Root cause: {l.recall.root_cause} · {l.recall.status}</div>
              <div className="recall-link">
                {l.leadMonths !== null ? (
                  <span className="badge lead">signal preceded by {l.leadMonths} mo ({l.signalMonth})</span>
                ) : (
                  <span className="badge miss">no preceding signal detected</span>
                )}
              </div>
            </div>
          ))}
        </section>
      </div>

      <footer className="muted small">
        Sources: openFDA device/event &amp; device/recall. Mock data is a deterministic seeded generator — flip{" "}
        <code>SOURCE</code> in <code>src/dataAdapter.ts</code> to go live.
      </footer>
    </div>
  );
}

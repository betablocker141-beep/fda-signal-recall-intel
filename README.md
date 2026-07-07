# FDA Device Signal & Recall Intelligence

A companion dashboard to the [MAUDE Complaint Intelligence System](../fda-maude-intelligence):
where that project *counts and classifies* adverse events, this one asks the
statistical question — **is a device reporting a specific problem out of
proportion to its peers, and did such signals precede actual recalls?**

> ⚠️ **Research use only.** MAUDE is passive surveillance. PRR/ROR measure
> *reporting disproportionality*, not risk, incidence or causality. A signal is
> a hypothesis to investigate, not a safety finding. The disclaimer banner in
> the UI is non-negotiable.

## What it does

1. **Disproportionality signals** — for every monitored device × device-problem
   pair, a 2×2 contingency table against the rest of the monitored set:
   - **PRR** (Proportional Reporting Ratio) with 95% CI
   - **ROR** (Reporting Odds Ratio) with 95% CI
   - **χ²** with Yates continuity correction
   - Flagged by the **Evans/MHRA criterion**: n ≥ 3, PRR ≥ 2, χ² ≥ 4
2. **Trend spike detection** — rolling z-score of monthly report counts against
   the trailing 12-month baseline (σ floored at √mean, the Poisson noise floor).
3. **Recall linkage** — openFDA `device/recall` records joined by product code;
   for each recall, the earliest spike in the prior 24 months → **signal lead
   time** ("our signal fired N months before the recall").

## Architecture (mock-first, same house pattern)

```
   seeded mock generator            openFDA (device/event, device/recall)
            │                                     │
            └────────► src/dataAdapter.ts ◄───────┘   ← THE ONLY mock⇄live swap point
                              │
                    src/signals.ts  (pure, tested statistics)
                              │
                        React dashboard
```

- `src/signals.ts` — all statistics; pure functions, no I/O; **vitest** covers
  PRR/ROR/χ² against hand-computed tables, spike detection, and recall linkage.
- `src/mockData.ts` — deterministic seeded generator (36 months, 6 devices)
  with three injected signals and three recalls, including one designed
  *miss* (recall with no preceding signal) so the UI shows honest failure modes.
- `src/openfda.ts` — live client; edit `MONITORED_DEVICES` to choose product
  codes. **openFDA requires a free API key for `device/event`** (it returns
  403 without one; `device/recall` works anonymously). Copy `.env.example` to
  `.env` and set `VITE_OPENFDA_API_KEY` — get a key at
  https://open.fda.gov/apis/authentication/.
- `src/dataAdapter.ts` — `SOURCE` is `"live"`; on any openFDA failure (e.g.
  missing key) it falls back to the mock dataset and the badge shows MOCK.

## Run

```bash
npm install
npm run dev     # dashboard on mock data
npm test        # statistics test suite
npm run build   # typecheck + production build
```

## Method references

- Evans SJW et al., *Use of proportional reporting ratios (PRRs) for signal
  generation from spontaneous ADR reports*, Pharmacoepidemiol Drug Saf 2001.
- van Puijenbroek EP et al., *A comparison of measures of disproportionality
  for signal detection*, Pharmacoepidemiol Drug Saf 2002.

## Deliberate scoping choices

- The 2×2 background is the **monitored device set**, not all of MAUDE, so the
  mock and live paths behave identically. Widening the background to a full
  device class is the natural next step (one extra openFDA count query).
- Counts are **problem mentions** (a report can mention several problems),
  matching openFDA's `count=product_problems.exact`.
- Recall classification (Class I/II/III) lives on the `device/enforcement`
  endpoint and is not joined yet — listed as future work.

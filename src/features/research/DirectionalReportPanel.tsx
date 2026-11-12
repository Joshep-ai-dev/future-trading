import { fmt, type DirectionalReport } from "../../shared/types/types";

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const pct = (value: number | null | undefined, digits = 1) =>
  value == null ? "—" : `${fmt(value * 100, digits)}%`;
const label = (name: string) => name.replaceAll("_", " ");
const time = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
const EXIT: Record<string, string> = { take_profit: "Target", stop: "Stop", time_exit: "Time exit", period_end: "Period end", risk_limit: "Risk limit", data_gap: "Data gap" };

/** Walk-forward diagnostics for ML Directional: per-block AUC and P&L, calibration, feature importance. */
export default function DirectionalReportPanel({ report }: { report: DirectionalReport }) {
  const aucs = report.folds.flatMap((fold) => [fold.aucLong, fold.aucShort]).filter((v): v is number => v != null);
  const meanAuc = aucs.length ? aucs.reduce((a, b) => a + b, 0) / aucs.length : null;
  const profitable = report.folds.filter((fold) => fold.trades && fold.netPnl > 0).length;
  const traded = report.folds.filter((fold) => fold.trades).length;
  const top = report.featureImportance[0]?.value || 1;
  const audit = report.executionAudit;
  return (
    <div className='model-report'>
      <h3>ML Directional</h3>
      <p className='model-note'>{report.message}</p>
      <div className='model-kpis'>
        <div>
          <span>Mean out-of-sample AUC</span>
          <strong className={meanAuc != null && meanAuc < 0.55 ? "negative" : ""}>{meanAuc == null ? "—" : fmt(meanAuc, 3)}</strong>
          <small>0.50 = no skill. Long and short models, every block.</small>
        </div>
        <div>
          <span>Profitable blocks</span>
          <strong>{traded ? `${profitable} / ${traded}` : "—"}</strong>
          <small>Blocks with at least one trade</small>
        </div>
        <div>
          <span>Round-trip cost</span>
          <strong className={(report.averageCostR ?? 0) > 0.33 ? "negative" : ""}>
            {report.averageCostR == null ? "—" : `${fmt(report.averageCostR, 2)} R`}
          </strong>
          <small>Median fees, spread and slippage vs the stop distance</small>
        </div>
        <div>
          <span>Break-even win rate</span>
          <strong>{pct(report.breakEvenWinRate)}</strong>
          <small>Before costs, from take-profit ÷ stop</small>
        </div>
      </div>
      {audit && !audit.passed && (
        <p className='error'>The execution audit did not reconcile cash and trade P&amp;L.</p>
      )}
      <section>
        <h3>Walk-forward blocks</h3>
        <p className='model-note'>
          Each block trades with models trained only on candles before it. The training window ends one hold window before the
          block starts, so no label sees traded prices.
        </p>
        <table>
          <thead>
            <tr>
              <th>Block</th><th>Trained on</th><th>Base win L / S</th><th>AUC L / S</th><th>Signals</th><th>Trades</th><th>Net P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {report.folds.map((fold) => (
              <tr key={fold.start}>
                <td>{day(fold.start)} → {day(fold.end)}</td>
                <td title={`${day(fold.trainStart)} → ${day(fold.trainEnd)}${fold.calibrated ? " · calibrated" : " · uncalibrated"}`}>
                  {fold.trainRows.toLocaleString()} candles
                </td>
                <td>{pct(fold.baseRateLong, 0)} / {pct(fold.baseRateShort, 0)}</td>
                <td>{fold.aucLong == null ? "—" : fmt(fold.aucLong, 3)} / {fold.aucShort == null ? "—" : fmt(fold.aucShort, 3)}</td>
                <td>{fold.signals}</td>
                <td>{fold.trades}</td>
                <td className={fold.netPnl > 0 ? "positive" : fold.netPnl < 0 ? "negative" : ""}>{fmt(fold.netPnl, 2)}</td>
              </tr>
            ))}
            {report.skippedFolds.map((fold) => (
              <tr key={`skip-${fold.start}`}>
                <td>{day(fold.start)} → {day(fold.end)}</td>
                <td colSpan={6}>Not traded: {fold.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {report.predictionVsActual && report.predictionVsActual.trades > 0 && (() => {
        const v = report.predictionVsActual!;
        const gap = v.averagePredicted != null && v.reachedTarget != null ? v.reachedTarget - v.averagePredicted : null;
        return (
          <section>
            <h3>Prediction vs actual: your trades</h3>
            <p className='model-note'>
              For every trade: the model's chance of reaching take-profit before the stop at the signal candle, against what
              happened. Predicted {pct(v.averagePredicted)} on average, actual {pct(v.reachedTarget)} reached the target
              {gap != null && ` (${gap >= 0 ? "+" : ""}${fmt(gap * 100, 1)} pts)`}; {pct(v.profitable)} closed in profit. Break-even
              before costs: {pct(v.breakEven)}.
            </p>
            <table>
              <thead><tr><th>Predicted</th><th>Trades</th><th>Mean predicted</th><th>Reached target</th><th>In profit</th><th>Average R</th></tr></thead>
              <tbody>
                {v.buckets.map((b) => (
                  <tr key={b.low}>
                    <td>{pct(b.low, 0)}–{pct(b.high, 0)}</td><td>{b.trades}</td><td>{pct(b.predicted)}</td>
                    <td className={b.reachedTarget + 0.05 < b.predicted ? "negative" : ""}>{pct(b.reachedTarget)}</td>
                    <td>{pct(b.profitable)}</td>
                    <td className={b.averageR >= 0 ? "positive" : "negative"}>{fmt(b.averageR, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <details>
              <summary>Every trade ({v.rows.length}{v.trades > v.rows.length ? ` of ${v.trades}` : ""}) · UTC</summary>
              <div style={{ maxHeight: 420, overflow: "auto" }}>
                <table>
                  <thead><tr><th>Signal</th><th>Side</th><th>Predicted</th><th>Other side</th><th>Entry</th><th>Target</th><th>Stop</th><th>Exit</th><th>Result</th><th>R</th><th>Net P&amp;L</th></tr></thead>
                  <tbody>
                    {[...v.rows].reverse().map((t) => (
                      <tr key={t.entryTime}>
                        <td>{t.signalTime == null ? "—" : time(t.signalTime)}</td>
                        <td className={t.direction === 1 ? "positive" : "negative"}>{t.direction === 1 ? "Long" : "Short"}</td>
                        <td>{pct(t.predicted)}</td><td>{pct(t.other)}</td>
                        <td>{fmt(t.entry, 3)}</td><td>{t.target == null ? "—" : fmt(t.target, 3)}</td><td>{fmt(t.stop, 3)}</td><td>{fmt(t.exit, 3)}</td>
                        <td className={t.reachedTarget ? "positive" : "negative"}>{EXIT[t.exitReason] ?? t.exitReason}</td>
                        <td>{t.r == null ? "—" : fmt(t.r, 2)}</td>
                        <td className={t.netPnl >= 0 ? "positive" : "negative"}>{fmt(t.netPnl, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </section>
        );
      })()}
      <div className='model-report-grid'>
        <section>
          <h3>Calibration</h3>
          <p className='model-note'>
            Predicted win probability against how often take-profit was actually hit first, for every scored candle in the
            backtest (long and short pooled). Trustworthy models keep the two columns close where entries happen.
          </p>
          {report.calibration.length ? (
            <table>
              <thead>
                <tr><th>Predicted</th><th>Mean predicted</th><th>Actual</th><th>Candles</th></tr>
              </thead>
              <tbody>
                {report.calibration.map((row) => (
                  <tr key={row.low}>
                    <td>{pct(row.low, 0)}–{pct(row.high, 0)}</td>
                    <td>{pct(row.predicted)}</td>
                    <td className={row.actual + 0.05 < row.predicted ? "negative" : ""}>{pct(row.actual)}</td>
                    <td>{row.count.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className='model-note'>Not enough labelled candles yet.</p>
          )}
        </section>
        <section>
          <h3>Most important features</h3>
          <p className='model-note'>Share of LightGBM split gain, averaged over blocks and both sides.</p>
          {report.featureImportance.length ? (
            <ol className='importance-list'>
              {report.featureImportance.map(({ name, value }) => (
                <li key={name}>
                  <span>{label(name)}</span>
                  <i><b style={{ width: `${(value / top) * 100}%` }} /></i>
                  <em>{pct(value)}</em>
                </li>
              ))}
            </ol>
          ) : (
            <p className='model-note'>This model does not report feature importance.</p>
          )}
        </section>
      </div>
    </div>
  );
}

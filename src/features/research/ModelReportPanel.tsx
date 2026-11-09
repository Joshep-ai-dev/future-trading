import { fmt, type ModelReport } from "../../shared/types/types";

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const pct = (value: number | null | undefined, digits = 1) =>
  value == null ? "—" : `${fmt(value * 100, digits)}%`;
const label = (name: string) => name.replaceAll("_", " ");

/** Walk-forward diagnostics for ML strategies: accuracy, outcomes, costs and feature importance. */
export default function ModelReportPanel({ report }: { report: ModelReport }) {
  if (report.kind === "rl")
    return (
      <div className='model-report'>
        <h3>RL PPO policy</h3>
        <p className='model-note'>{report.message}</p>
        <p className='model-note'>
          Observes recent candles plus trend strength, volatility, range
          position and slower timeframe context. Eligible checkpoints rank by
          return divided by drawdown (minimum denominator 1 percentage point),
          then net profit.
        </p>
        {report.regimes && (
          <section>
            <h3>Results by market condition</h3>
            <p className='model-note'>
              Conditions use historical indicators. Trades are attributed to the
              condition observed before entry; net P&amp;L includes costs for
              the entire closed trade. High volatility takes precedence over
              trend. These are descriptive groups, not separate policies.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Condition</th>
                  <th>Time share</th>
                  <th>Trades</th>
                  <th>Win rate</th>
                  <th>Net P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {report.regimes.map((row) => (
                  <tr key={row.name}>
                    <td>{row.name}</td>
                    <td>{pct(row.share)}</td>
                    <td>{row.trades}</td>
                    <td>
                      {row.winRate == null ? "-" : `${fmt(row.winRate)}%`}
                    </td>
                    <td>{fmt(row.netPnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        <div className='model-kpis'>
          <div>
            <span>Evaluation blocks</span>
            <strong>{report.folds.length}</strong>
          </div>
          <div>
            <span>Unseen candles</span>
            <strong>{report.trainedBars}</strong>
          </div>
          <div>
            <span>Input features</span>
            <strong>{report.featureCount}</strong>
          </div>
        </div>
        <h3>Past checkpoint validation</h3>
        <p className='model-note'>
          Each policy uses only candles before its evaluation block. These
          validation results select checkpoints; they are not the forward-test
          performance.
        </p>
        <table>
          <thead>
            <tr>
              <th>Evaluation from</th>
              <th>Status</th>
              <th>Training ends</th>
              <th>Steps</th>
              <th>Validation trades</th>
              <th>Win rate</th>
              <th>Net profit</th>
            </tr>
          </thead>
          <tbody>
            {report.folds.map((fold) => (
              <tr key={fold.start}>
                <td>{day(fold.start)}</td>
                <td title={fold.training?.selectionReason}>
                  {fold.training?.accepted == null
                    ? "Legacy checkpoint"
                    : fold.training.accepted
                      ? "Accepted"
                      : "Staying flat"}
                </td>
                <td>{fold.training?.validationEnd.slice(0, 10) ?? "-"}</td>
                <td>{fold.training?.steps ?? 0}</td>
                <td>{fold.training?.validation.trades ?? 0}</td>
                <td>{fmt(fold.training?.validation.winRate ?? 0)}%</td>
                <td>{fmt(fold.training?.validation.netPnl ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {report.folds.map(
          (fold) =>
            fold.training?.checkpoints && (
              <details key={fold.start} className='tune-model-details'>
                <summary>Learning progress for {day(fold.start)}</summary>
                <p>
                  {fold.training.selectionReason ??
                    "Historical checkpoint record"}
                  . Cash baseline: zero trades, zero profit and zero trading
                  costs.
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>Steps</th>
                      <th>Trades</th>
                      <th>Win rate</th>
                      <th>Net profit</th>
                      <th>Costs</th>
                      <th>Drawdown</th>
                      <th>Position changes</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fold.training.checkpoints.map((checkpoint) => (
                      <tr key={checkpoint.steps}>
                        <td>{checkpoint.steps}</td>
                        <td>{checkpoint.metrics.trades}</td>
                        <td>{fmt(checkpoint.metrics.winRate)}%</td>
                        <td>{fmt(checkpoint.metrics.netPnl)}</td>
                        <td>{fmt(checkpoint.metrics.transactionCosts ?? 0)}</td>
                        <td>{fmt(checkpoint.metrics.maxDrawdownPct)}%</td>
                        <td>{checkpoint.metrics.positionChanges ?? 0}</td>
                        <td>
                          {checkpoint.accepted
                            ? checkpoint.steps ===
                              fold.training?.selectedCheckpointSteps
                              ? "Selected"
                              : "Passed"
                            : (checkpoint.reason ?? "Not assessed")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ),
        )}
        {report.folds.map((fold) =>
          fold.training?.checkpoints?.map(
            (checkpoint) =>
              checkpoint.metrics.regimes && (
                <details
                  key={`${fold.start}-${checkpoint.steps}-conditions`}
                  className='tune-model-details'
                >
                  <summary>
                    Checkpoint market conditions: {day(fold.start)},{" "}
                    {checkpoint.steps} steps
                  </summary>
                  <p className='model-note'>
                    Past validation results for this candidate, including
                    rejected policies. Conditions are measured before entry;
                    P&amp;L includes the entire closed trade after costs.
                  </p>
                  <table>
                    <thead>
                      <tr>
                        <th>Condition</th>
                        <th>Time share</th>
                        <th>Trades</th>
                        <th>Win rate</th>
                        <th>Net P&amp;L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {checkpoint.metrics.regimes.map((row) => (
                        <tr key={row.name}>
                          <td>{row.name}</td>
                          <td>{pct(row.share)}</td>
                          <td>{row.trades}</td>
                          <td>
                            {row.winRate == null ? "-" : `${fmt(row.winRate)}%`}
                          </td>
                          <td>{fmt(row.netPnl)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              ),
          ),
        )}
      </div>
    );
  const importance = Object.entries(report.importance).slice(0, 15),
    top = importance[0]?.[1] || 1;
  const baseline =
      report.exitMode === "forecast"
        ? Math.max(
            report.labelBalance.long,
            report.labelBalance.none,
            report.labelBalance.short,
          )
        : 1 / 3,
    edge = report.accuracy == null ? null : report.accuracy - baseline;
  const costShare =
    report.medianTarget && report.medianRoundTripCost
      ? report.medianRoundTripCost / report.medianTarget
      : null;
  return (
    <div className='model-report'>
      {!!report.skippedTrainingBlocks && (
        <p className='model-note'>
          {report.skippedTrainingBlocks} training blocks skipped because the
          data had only one outcome. No new entries were generated in those
          blocks. Later blocks train normally when outcomes vary.
        </p>
      )}
      {report.forecast && (
        <p className='model-note'>
          Latest forecast over {report.forecast.horizon} candles: high{" "}
          {fmt(report.forecast.high, 4)}, low {fmt(report.forecast.low, 4)},
          close {fmt(report.forecast.close, 4)}. Forecast direction scores are
          not calibrated win probabilities.
        </p>
      )}
      {report.forecastErrors && (
        <p className='model-note'>
          Unseen forecast mean absolute error: high{" "}
          {fmt(report.forecastErrors.highMaePct, 3)}%, low{" "}
          {fmt(report.forecastErrors.lowMaePct, 3)}%, close{" "}
          {fmt(report.forecastErrors.closeMaePct, 3)}% of price, over{" "}
          {report.forecastErrors.samples} candles with complete future outcomes.
        </p>
      )}
      <div className='model-kpis'>
        <div>
          <span>Out-of-sample accuracy</span>
          <strong
            className={edge != null && edge > 0 ? "positive" : "negative"}
          >
            {pct(report.accuracy)}
          </strong>
          <small>
            {report.exitMode === "forecast"
              ? `Majority outcome ${fmt(baseline * 100, 1)}%`
              : "Random guessing ~ 33.3%"}
            {edge != null &&
              ` · ${edge >= 0 ? "+" : ""}${fmt(edge * 100, 1)} pts`}
          </small>
        </div>
        <div>
          <span>Test blocks</span>
          <strong>{report.folds.length}</strong>
          <small>
            {report.trainedBars.toLocaleString()} unseen candles ·{" "}
            {report.featureCount} features
          </small>
        </div>
        <div>
          <span>Cost vs target</span>
          <strong
            className={costShare != null && costShare > 0.33 ? "negative" : ""}
          >
            {costShare == null ? "—" : `${fmt(costShare * 100, 0)}%`}
          </strong>
          <small>
            Round trip {fmt(report.medianRoundTripCost, 3)} vs target{" "}
            {fmt(report.medianTarget, 3)} USDT
          </small>
        </div>
        <div>
          <span>Signals skipped for cost</span>
          <strong>{report.blockedByCost.toLocaleString()}</strong>
          <small>Target below the reward ÷ cost ratio</small>
        </div>
      </div>
      {report.funnel && (
        <section className='signal-funnel'>
          <h3>Signal funnel</h3>
          <p className='model-note'>
            How many candles survive each entry filter. The biggest drop shows
            which setting limits your trades.
          </p>
          <ol>
            {report.funnel.map((row, index) => {
              const first = report.funnel![0].remaining || 1,
                previous = index
                  ? report.funnel![index - 1].remaining
                  : row.remaining,
                drop = previous ? 1 - row.remaining / previous : 0;
              return (
                <li key={row.step} title={row.note}>
                  <span>{row.step}</span>
                  <i>
                    <b
                      style={{
                        width: `${Math.max(0.5, (row.remaining / first) * 100)}%`,
                      }}
                    />
                  </i>
                  <strong>{row.remaining.toLocaleString()}</strong>
                  <em className={drop > 0.5 ? "negative" : ""}>
                    {index ? `−${Math.round(drop * 100)}%` : ""}
                  </em>
                </li>
              );
            })}
          </ol>
        </section>
      )}
      {report.regimes && (
        <section className='regime-report'>
          <h3>Results by market regime</h3>
          <p className='model-note'>
            Learned market states in the tested period. Off = excluded by your
            regime filter.
          </p>
          <table>
            <thead>
              <tr>
                <th>Regime</th>
                <th>Time in regime</th>
                <th>Trades</th>
                <th>Win rate</th>
                <th>Net P&amp;L</th>
                <th>Traded</th>
              </tr>
            </thead>
            <tbody>
              {report.regimes.map((regime) => (
                <tr key={regime.name}>
                  <td>
                    <span
                      className={`regime-dot is-${regime.name.replace(" ", "-").toLowerCase()}`}
                    />
                    {regime.name}
                  </td>
                  <td>
                    <i className='regime-share'>
                      <b style={{ width: `${regime.share * 100}%` }} />
                    </i>
                    {pct(regime.share, 0)}
                  </td>
                  <td>{regime.trades}</td>
                  <td>
                    {regime.winRate == null
                      ? "—"
                      : `${fmt(regime.winRate, 1)}%`}
                  </td>
                  <td className={regime.netPnl >= 0 ? "positive" : "negative"}>
                    {regime.netPnl >= 0 ? "+" : "-"}$
                    {fmt(Math.abs(regime.netPnl))}
                  </td>
                  <td>{regime.allowed ? "On" : "Off"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.exitMode === "learned" && report.learnedExits && (
            <div className='learned-exits'>
              <span>Median learned exits (× ATR)</span>
              {(
                [
                  ["Long target", "long_tp"],
                  ["Long stop", "long_sl"],
                  ["Short target", "short_tp"],
                  ["Short stop", "short_sl"],
                ] as const
              ).map(([label, key]) => (
                <div key={key}>
                  <small>{label}</small>
                  <b>
                    {report.learnedExits?.[key] == null
                      ? "—"
                      : fmt(report.learnedExits[key], 2)}
                  </b>
                </div>
              ))}
              <div>
                <small>Skipped by reward/risk</small>
                <b>{(report.blockedByRewardRisk ?? 0).toLocaleString()}</b>
              </div>
              <div>
                <small>Skipped by regime</small>
                <b>{(report.blockedByRegime ?? 0).toLocaleString()}</b>
              </div>
              <div>
                <small>Skipped: quiet / small target</small>
                <b>{(report.blockedBySize ?? 0).toLocaleString()}</b>
              </div>
            </div>
          )}
        </section>
      )}
      <div className='model-report-grid'>
        <section>
          <h3>What the market did</h3>
          <p className='model-note'>
            Share of candles where a long win, a short win or neither happened
            within the horizon.
          </p>
          <div className='outcome-bar' aria-label='Outcome balance'>
            {(["long", "none", "short"] as const).map((key) => (
              <i
                key={key}
                className={`is-${key}`}
                style={{ width: `${report.labelBalance[key] * 100}%` }}
                title={`${key}: ${pct(report.labelBalance[key])}`}
              />
            ))}
          </div>
          <div className='outcome-legend'>
            <span>
              <i className='is-long' />
              Long win {pct(report.labelBalance.long)}
            </span>
            <span>
              <i className='is-none' />
              Neither {pct(report.labelBalance.none)}
            </span>
            <span>
              <i className='is-short' />
              Short win {pct(report.labelBalance.short)}
            </span>
          </div>
          <h3>Accuracy by test block</h3>
          <div className='fold-bars'>
            {report.folds.map((fold) => (
              <div
                key={fold.start}
                title={`${day(fold.start)} → ${day(fold.end)} · ${pct(fold.accuracy)} · trained on ${fold.trainRows} candles`}
              >
                <i
                  style={{
                    height: `${Math.max(4, (fold.accuracy ?? 0) * 100)}%`,
                  }}
                  className={
                    (fold.accuracy ?? 0) > baseline ? "is-good" : "is-bad"
                  }
                />
              </div>
            ))}
            <span
              className='fold-baseline'
              style={{ bottom: `${baseline * 100}%` }}
            >
              {fmt(baseline * 100, 0)}%
            </span>
          </div>
          <div className='fold-axis'>
            <span>{report.folds[0] ? day(report.folds[0].start) : ""}</span>
            <span>
              {report.folds.at(-1) ? day(report.folds.at(-1)!.end) : ""}
            </span>
          </div>
        </section>
        <section>
          <h3>Most important indicators</h3>
          <p className='model-note'>
            Share of the tree models' decisions based on each feature, across
            all test blocks.
          </p>
          {importance.length ? (
            <ol className='importance-list'>
              {importance.map(([name, value]) => (
                <li key={name}>
                  <span>{label(name)}</span>
                  <i>
                    <b style={{ width: `${(value / top) * 100}%` }} />
                  </i>
                  <em>{pct(value)}</em>
                </li>
              ))}
            </ol>
          ) : (
            <p className='model-note'>
              The selected models do not report feature importance.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

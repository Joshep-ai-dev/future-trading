"""Compare Adaptive Forecast exits and entry guards on one fixed local period."""
from __future__ import annotations

import argparse
from dataclasses import replace
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.market.data import load_bars
from server.strategies.fine_tuning import _score
from server.strategies.ml.strategy import MLSettings, execute, prepare


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--test-bars', type=int, default=3000)
    parser.add_argument('--train-bars', type=int, default=6000)
    parser.add_argument('--horizon', type=int, default=24)
    parser.add_argument('--output', type=Path, default=Path('reports/adaptive_execution_validation.json'))
    args = parser.parse_args()
    frame, _ = load_bars('5m', instrument='xag')
    frame = frame.dropna(subset=['open', 'high', 'low', 'close']).tail(args.test_bars+args.train_bars+args.horizon+200)
    if len(frame) <= args.test_bars+500:
        raise ValueError('Not enough local history')
    start = frame.index[-args.test_bars]
    settings = MLSettings(train_bars=args.train_bars, horizon=args.horizon, retrain_every=1000)
    prepared = prepare(frame, settings, start)
    costs = dict(fee_bps=6., slippage=.01, spread=.02, funding_bps=1.)
    cases = {}
    # Same predictions, dates, costs, size caps, holding time and loss limits.
    # This is an ablation report, not an optimizer choosing on the test period.
    for name, guard, adaptive in (('unguarded_adaptive', False, True),
                                   ('guarded_adaptive', True, True), ('guarded_fixed', True, False)):
        result = execute(prepared, replace(settings, forecast_guard=guard, forecast_adaptive_exits=adaptive),
                         initial_capital=2000., leverage=1., start=start, close_at_end=True, bar_seconds=300, **costs)
        cases[name] = dict(metrics=_score(result, 2000.), audit=result['report']['executionAudit'],
                           validation=result['report']['forecastValidation'])
    report = dict(purpose='Fixed-period integration and ablation check; no profitability claim or forward-based selection',
                  start=start.isoformat(), end=frame.index[-1].isoformat(), costs=costs,
                  horizon=args.horizon, trainBars=args.train_bars, requestedEvaluationBars=args.test_bars, cases=cases)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False), encoding='utf-8')
    print(json.dumps({name: case['metrics'] for name, case in cases.items()}))


if __name__ == '__main__':
    main()

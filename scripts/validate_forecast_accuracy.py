"""Reproducible research comparison; trains temporary artifacts, never account models."""
import json
import tempfile
import time
from pathlib import Path

from server.market.data import load_bars
from server.forecast_models import TrainForecastRequest, train_saved_model, load_model
from server.forecast_research import ForecastRequest, run_forecast_test


def main() -> None:
    frame, _ = load_bars('5m')
    results = []
    with tempfile.TemporaryDirectory() as directory:
        for kind in ('extra_trees', 'rnn', 'lstm', 'gru'):
            request = TrainForecastRequest(model=kind, timeframe='5m', horizon=12, lookback=100, epochs=30,
                                           train_bars=6000, training_end='2026-10-25')
            started = time.time()
            metadata = train_saved_model(frame, request, 1, Path(directory))
            model, _ = load_model(1, metadata['id'], Path(directory))
            result = run_forecast_test(frame, ForecastRequest(**metadata['config'], start_date='2026-10-26',
                                       end_date='2026-11-02'), saved_model=model, metadata=metadata)
            row = dict(model=kind, seconds=round(time.time()-started, 1), epochs=metadata['epochsTrained'], metrics=result['metrics'])
            results.append(row)
            print(json.dumps(row), flush=True)
    Path('reports/forecast_accuracy_after.json').write_text(json.dumps(dict(
        purpose='Research comparison on a reused development period; not an untouched performance claim',
        timeframe='5m', horizon=12, trainThrough='2026-10-25', testStart='2026-10-26', testEnd='2026-11-02',
        results=results), indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()

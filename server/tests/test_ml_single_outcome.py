import unittest
from datetime import date
from unittest.mock import patch

import numpy as np
import pandas as pd

from server.strategies.ml.strategy import MLSettings, run_ml_backtest
from server.strategies.ml.walk_forward import fold_cache, walk_forward


class SingleOutcomeTests(unittest.TestCase):
    def setUp(self):
        fold_cache.items.clear()
        self.addCleanup(fold_cache.items.clear)
        self.index = pd.date_range('2026-01-01', periods=1200, freq='5min', tz='UTC')
        self.features = pd.DataFrame({'return': np.zeros(1200)}, index=self.index)

    def test_any_single_outcome_abstains_without_training(self):
        for outcome in (-1., 0., 1.):
            with self.subTest(outcome=outcome), patch('server.strategies.ml.walk_forward.fit_model') as fit:
                result = walk_forward(self.features, pd.Series(outcome, index=self.index),
                                      start_index=600, train_bars=500, retrain_every=200, horizon=24,
                                      models={'lightgbm': 1.}, key=f'single-{outcome}')
            fit.assert_not_called()
            self.assertTrue(result.probabilities[['p_short', 'p_none', 'p_long']].isna().all().all())
            self.assertEqual(len(result.folds), 3)
            self.assertTrue(all(f['status'] == 'skipped' and f['reason'] == 'single_outcome' for f in result.folds))

    def test_training_resumes_only_after_other_outcomes_are_in_the_past(self):
        labels = pd.Series(0., index=self.index)
        labels.iloc[700:] = np.resize([-1., 0., 1.], 500)
        with patch('server.strategies.ml.walk_forward.fit_model') as fit:
            fit.return_value.predict_rows.side_effect = lambda features, rows: np.tile([.1, .2, .7], (rows.stop-rows.start, 1))
            fit.return_value.importance.return_value = {}
            result = walk_forward(self.features, labels, start_index=500, train_bars=500, retrain_every=200,
                                  horizon=24, models={'lightgbm': 1.}, key='recovery', learn_regimes=False)
        self.assertTrue(result.probabilities.p_long.iloc[500:900].isna().all())
        self.assertTrue(result.probabilities.p_long.iloc[900:].notna().all())
        self.assertEqual([f.get('status') for f in result.folds[:2]], ['skipped', 'skipped'])
        self.assertTrue(all(call.args[3].stop > 700 for call in fit.call_args_list))

    def flat_market(self) -> pd.DataFrame:
        return pd.DataFrame(dict(open=100., high=100.1, low=99.9, close=100., volume=1.), index=self.index)

    def test_backtest_completes_with_zero_trades_and_explicit_diagnostics(self):
        result = run_ml_backtest(self.flat_market(), MLSettings(train_bars=500, retrain_every=200, exit_mode='percent'),
                                 initial_capital=1000., leverage=1., start=self.index[600])
        self.assertTrue(result['trades'].empty)
        self.assertEqual(result['cash'], 1000.)
        self.assertEqual(result['report']['skippedTrainingBlocks'], 3)
        self.assertEqual(result['report']['trainedBars'], 0)
        self.assertIsNone(result['report']['accuracy'])

    def test_search_completes_when_every_candidate_has_one_outcome(self):
        from server.strategies.ml import tuning
        from server.strategies.strategy import BacktestRequest

        request = BacktestRequest(start_date=date(2026, 1, 1), end_date=date(2026, 1, 5),
                                  strategy='ml_ensemble', ml=dict(train_bars=500, retrain_every=200, exit_mode='percent'))
        with patch.object(tuning, 'PERCENT_STOP_GRID', (.65,)), \
             patch.object(tuning, 'ENTRY_GRID', dict(entry_threshold=(.5,), min_edge=(.1,))):
            result = tuning.ml_fine_tune(self.flat_market(), request)
        self.assertFalse(result['candidates'][0]['reliable'])
        self.assertGreater(result['candidates'][0]['skippedTrainingBlocks'], 0)
        self.assertEqual(result['periods']['validation']['metrics']['trades'], 0)
        self.assertEqual(result['bestSettings']['ml']['take_profit_pct'], 1.)
        self.assertEqual(result['bestSettings']['ml']['stop_loss_pct'], .65)

import unittest
from datetime import date
from unittest.mock import patch

from server.strategies.ml.strategy import MLSettings, prepare
from server.strategies.ml.tuning import _ml_ranking_key
from server.tests.test_ml_strategy import market


class EssentialMLTests(unittest.TestCase):
    def metrics(self, win_rate: float = 65., profit: float = 100., trades: int = 100) -> dict:
        return dict(winRate=win_rate, netPnl=profit, trades=trades, maxDrawdownPct=-5., score=50.)

    def rank(self, train: dict, validation: dict) -> tuple:
        return _ml_ranking_key(train, validation)

    def test_profitable_sample_beats_high_win_rate_with_losses(self):
        good = self.rank(self.metrics(), self.metrics())
        losing = self.rank(self.metrics(90.), self.metrics(90., -100.))
        self.assertGreater(good, losing)

    def test_win_rate_precedes_profit_and_uses_weaker_period(self):
        good = self.rank(self.metrics(70.), self.metrics(70.))
        rich = self.rank(self.metrics(60., 1000.), self.metrics(60., 1000.))
        unstable = self.rank(self.metrics(95.), self.metrics(55.))
        self.assertGreater(good, rich)
        self.assertGreater(good, unstable)

    def test_profit_breaks_win_rate_ties(self):
        self.assertGreater(self.rank(self.metrics(profit=200.), self.metrics()),
                           self.rank(self.metrics(), self.metrics()))

    def test_tiny_sample_cannot_win(self):
        self.assertGreater(self.rank(self.metrics(), self.metrics()),
                           self.rank(self.metrics(100., trades=3), self.metrics(100., trades=3)))

    def test_essential_defaults_train_only_direction_model(self):
        settings = MLSettings()
        self.assertEqual(settings.models, {'extra_trees': 1.})
        self.assertEqual(settings.capacity, 'light')
        self.assertEqual(settings.exit_mode, 'forecast')
        self.assertFalse(settings.quality_filter)
        self.assertFalse(settings.let_profit_run)
        frame = market(800)
        with patch('server.strategies.ml.strategy.walk_forward') as walk:
            prepare(frame, settings, start=frame.index[600])
        self.assertFalse(walk.call_args.kwargs['learn_regimes'])
        self.assertFalse(walk.call_args.kwargs['meta'])
        self.assertIsNone(walk.call_args.kwargs['exit_targets'])
        self.assertIsNotNone(walk.call_args.kwargs['forecast_targets'])

    def test_selecting_regime_enables_regime_model(self):
        frame = market(800)
        with patch('server.strategies.ml.strategy.walk_forward') as walk:
            prepare(frame, MLSettings(regimes=['Range']), start=frame.index[600])
        self.assertTrue(walk.call_args.kwargs['learn_regimes'])

    def test_forward_results_cannot_change_selection_and_segments_do_not_overlap(self):
        from server.strategies.ml import tuning
        from server.strategies.strategy import BacktestRequest

        frame = market(1200)
        request = BacktestRequest(start_date=date(2026, 1, 1), end_date=date(2026, 1, 5),
                                  strategy='ml_ensemble', ml=dict(exit_mode='percent'))
        calls = []
        forward_profit = [10000.]

        def execute_candidate(prepared, settings, **kwargs):
            calls.append((kwargs['start'], kwargs['end']))
            # The higher win-rate candidate has less profit; forward performance
            # deliberately favours the other candidate and must not select it.
            if kwargs['start'] >= frame.index[960]:
                return self.metrics(20., forward_profit[0])
            return self.metrics(70., 100.) if settings.entry_threshold == .6 else self.metrics(60., 1000.)

        with patch.object(tuning, 'PERCENT_STOP_GRID', (.65,)), \
             patch.object(tuning, 'MODEL_GRID', dict(take_profit_atr=(1.5,), stop_atr=(1.,))), \
             patch.object(tuning, '_model_candidates', return_value=[dict(train_bars=6000)]), \
             patch.object(tuning, 'ENTRY_GRID', dict(entry_threshold=(.5, .6), min_edge=(.1,))), \
             patch.object(tuning, 'prepare', return_value=object()) as train, \
             patch.object(tuning, 'execute', side_effect=execute_candidate), \
             patch.object(tuning, '_score', side_effect=lambda result, capital: result):
            first = tuning.ml_fine_tune(frame, request)
            forward_profit[0] = -10000.
            second = tuning.ml_fine_tune(frame, request)
        self.assertEqual(train.call_count, 4)  # Model selection and tuning; entry trials reuse preparation.
        self.assertEqual(first['bestParameters'], second['bestParameters'])
        self.assertEqual(first['bestParameters']['entry_threshold'], .6)
        self.assertTrue(first['objective'].startswith('Win rate first'))
        segments = sorted(set(calls))
        self.assertEqual(len(segments), 3)
        for previous, following in zip(segments, segments[1:]):
            self.assertLess(previous[1], following[0])

    def test_model_selection_finishes_before_tuning_and_uses_only_earlier_data(self):
        from server.strategies.ml import tuning
        from server.strategies.strategy import BacktestRequest

        frame = market(1200)
        request = BacktestRequest(start_date=date(2026, 1, 1), end_date=date(2026, 1, 5),
                                  strategy='ml_ensemble', ml=dict(exit_mode='percent'))
        preparations = []
        executions = []

        def prepare_candidate(source, settings, *args, **kwargs):
            preparations.append((settings.train_bars, source.index[-1]))
            return source

        def execute_candidate(prepared, settings, **kwargs):
            executions.append((settings.train_bars, kwargs['start']))
            return self.metrics(75., 100.) if settings.train_bars == 3000 else self.metrics(60., 1000.)

        with patch.object(tuning, 'prepare', side_effect=prepare_candidate), \
             patch.object(tuning, 'execute', side_effect=execute_candidate), \
             patch.object(tuning, '_score', side_effect=lambda result, capital: result), \
             patch.object(tuning, 'PERCENT_STOP_GRID', (.65,)), \
             patch.object(tuning, 'MODEL_GRID', dict(take_profit_atr=(1.5,), stop_atr=(1.,))), \
             patch.object(tuning, 'ENTRY_GRID', dict(entry_threshold=(.6,), min_edge=(.1,))):
            result = tuning.ml_fine_tune(frame, request)
        self.assertEqual(len(preparations), 4)
        self.assertTrue(all(last < frame.index[720] for _, last in preparations[:3]))
        self.assertEqual(preparations[-1], (3000, frame.index[-1]))
        self.assertTrue(all(start == frame.index[0] for _, start in executions[:3]))
        self.assertEqual(result['modelSelection']['selected']['parameters'], {'train_bars': 3000, 'horizon': 24})
        self.assertEqual(result['bestSettings']['ml']['train_bars'], 3000)
        self.assertEqual(result['bestParameters']['train_bars'], 3000)

    def test_random_search_is_unique_reproducible_and_bounded(self):
        from server.strategies.ml.tuning import _random_models

        settings = MLSettings(exit_mode='percent')
        first = _random_models(settings, 6)
        self.assertEqual(first, _random_models(settings, 6))
        self.assertEqual(len({tuple(sorted(candidate.items())) for candidate in first}), 6)
        self.assertEqual(len(_random_models(settings, 10000)), 101)
        self.assertTrue(all(candidate['take_profit_pct'] == 1. and .6 <= candidate['stop_loss_pct'] <= .7
                            for candidate in first))

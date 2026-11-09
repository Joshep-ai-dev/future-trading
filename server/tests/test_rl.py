import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

from server.strategies.rl.environment import TradingEnv
from server.strategies.rl.settings import RLSettings
from server.strategies.rl.training import CACHE, CashPolicy, Normalizer, checkpoint_rank, checkpoint_rejection, train_policy
from server.tests.test_ml_strategy import bars, market


class RLEnvironmentTests(unittest.TestCase):
    def test_regime_report_accounts_for_closed_trades_after_costs(self):
        from server.strategies.rl.features import regime_breakdown

        frame = market(150)
        evaluated = frame.iloc[100:]
        trades = pd.DataFrame({'entry_time': [frame.index[110], frame.index[120]], 'pnl': [10., -15.]})
        report = regime_breakdown(frame, evaluated, trades)
        self.assertEqual(sum(row['trades'] for row in report), 2)
        self.assertAlmostEqual(sum(row['netPnl'] for row in report), -5.)
        self.assertAlmostEqual(sum(row['share'] for row in report), 1.)

    def test_recent_candle_inputs_preserve_ohlc_and_are_causal(self):
        from server.strategies.rl.features import build_rl_features

        frame = market(150)
        features = build_rl_features(frame)
        for column in ('open', 'high', 'low', 'close'):
            self.assertAlmostEqual(float(features[f'candle_{column}_relative'].iloc[100]),
                                   frame[column].iloc[100]/frame.close.iloc[99]-1, places=6)
        changed = frame.copy()
        changed.loc[changed.index[101]:, ['open', 'high', 'low', 'close']] *= 2
        pd.testing.assert_frame_equal(features.iloc[:101], build_rl_features(changed).iloc[:101])
        cfg = RLSettings(lookback=4)
        values = Normalizer.fit(features.iloc[:100].to_numpy()).transform(features.to_numpy())
        env = TradingEnv(frame, values, np.ones(len(frame)), cfg, first_observation=100)
        np.testing.assert_array_equal(env.observation()[:-10], values[97:101].reshape(-1))
        if 'volume' in frame:
            self.assertAlmostEqual(float(features.candle_log_volume.iloc[100]),
                                   float(np.log1p(frame.volume.iloc[100])), places=5)

    def env(self, rows, atr=None, **kwargs):
        frame = bars(rows)
        settings = kwargs.pop('settings', RLSettings(lookback=1, drawdown_penalty=0.))
        return TradingEnv(frame, np.zeros((len(frame), 2), np.float32),
                          np.full(len(frame), 2.) if atr is None else np.array(atr), settings,
                          capital=1000., **kwargs)

    def test_observation_then_next_open_fill_and_cost_accounting(self):
        env = self.env([[100, 101, 99, 100], [100, 101, 99, 100], [102, 103, 101, 102]],
                       fee_bps=5, slippage=.1, spread=.2)
        env.step(1)
        self.assertEqual(env.position['entry_time'], env.bars.index[1])
        self.assertAlmostEqual(env.position['entry_price'], 100.2)
        env.step(0)
        trade = env.trades[0]
        self.assertAlmostEqual(trade['exit_price'], 101.8)
        expected = (101.8-100.2)*10-(100.2+101.8)*10*.0005
        self.assertAlmostEqual(trade['pnl'], expected)
        self.assertAlmostEqual(env.cash, 1000+expected)
        self.assertEqual(trade['exit_reason'], 'policy_exit')

    def test_unrealized_losses_reduce_reward_without_closing(self):
        env = self.env([[100, 100, 100, 100], [100, 100, 98, 99], [99, 99.5, 98.5, 99]])
        _, reward, terminated, truncated, _ = env.step(1)
        self.assertLess(reward, 0.)
        self.assertFalse(terminated or truncated)
        self.assertEqual(env.trades, [])
        self.assertAlmostEqual(env.equity, 990.)

    def test_atr_filter_uses_only_the_observed_candle_and_never_blocks_exit(self):
        env = self.env([[100, 100, 100, 100]]*4, atr=[.03, .1, 0., 1.])
        env.step(1)
        self.assertIsNone(env.position)
        env.step(1)
        self.assertIsNotNone(env.position)
        env.step(0)
        self.assertIsNone(env.position)
        self.assertEqual(env.trades[0]['exit_reason'], 'policy_exit')

    def test_stop_gap_fills_at_open_and_does_not_reopen_same_bar(self):
        env = self.env([[100, 100, 100, 100], [100, 100.1, 99.9, 100], [98, 98.1, 97.9, 98]],
                       atr=[.05, .05, .05])
        env.step(1)
        env.step(1)
        self.assertEqual(env.trades[0]['exit_reason'], 'stop')
        self.assertEqual(env.trades[0]['exit_price'], 98.)
        self.assertIsNone(env.position)

    def test_drawdown_limit_liquidates_and_halts(self):
        env = self.env([[100, 100, 100, 100], [100, 100, 98, 98], [98, 98, 98, 98]],
                       atr=[10., 10., 10.], settings=RLSettings(lookback=1, max_drawdown_pct=1.))
        _, _, terminated, _, _ = env.step(1)
        self.assertTrue(terminated)
        self.assertTrue(env.halted)
        self.assertIsNone(env.position)
        self.assertEqual(env.trades[0]['exit_reason'], 'risk_limit')

    def test_intrabar_drawdown_halts_even_when_candle_close_recovers(self):
        for side, future in ((1, [100, 101, 70, 100]), (2, [100, 130, 99, 100])):
            with self.subTest(side=side):
                env = self.env([[100, 100, 100, 100], future, [100, 100, 100, 100]],
                               atr=[10., 10., 10.], fee_bps=5., slippage=.1, spread=.1)
                _, _, terminated, _, _ = env.step(side)
                self.assertTrue(terminated)
                self.assertEqual(env.trades[0]['exit_reason'], 'risk_limit')
                self.assertAlmostEqual(env.cash, 800.)
                self.assertAlmostEqual(env.drawdown, .2)

    def test_drawdown_gap_fills_at_actual_open_even_if_limit_is_exceeded(self):
        env = self.env([[100, 100, 100, 100], [100, 100.1, 99.9, 100], [70, 71, 69, 70]],
                       atr=[10., 10., 10.])
        env.step(1)
        _, _, terminated, _, _ = env.step(1)
        self.assertTrue(terminated)
        self.assertEqual(env.trades[0]['exit_price'], 70.)
        self.assertAlmostEqual(env.cash, 700.)
        self.assertIsNone(env.position)

    def test_episode_end_charges_liquidation_and_short_funding(self):
        env = self.env([[100, 100, 100, 100]]*2, funding_bps=8., fee_bps=5., bar_seconds=300)
        env.step(2)
        trade = env.trades[0]
        self.assertLess(trade['funding'], 0.)
        self.assertAlmostEqual(env.cash-1000., trade['pnl'])
        self.assertEqual(trade['exit_reason'], 'period_end')

    def test_gymnasium_environment_contract(self):
        from stable_baselines3.common.env_checker import check_env
        env = self.env([[100, 100.1, 99.9, 100]]*20)
        check_env(env, warn=True)

    def test_turnover_penalty_changes_reward_without_changing_account_profit(self):
        rows = [[100, 100.1, 99.9, 100]]*4
        settings = RLSettings(lookback=1, drawdown_penalty=0., turnover_penalty=0.)
        free = self.env(rows, settings=settings)
        penalized = self.env(rows, settings=replace(settings, turnover_penalty=.001))
        rewards = [0., 0.]
        for action in (1, 1, 0):
            rewards[0] += free.step(action)[1]
            rewards[1] += penalized.step(action)[1]
        self.assertEqual(free.cash, penalized.cash)
        self.assertEqual(penalized.position_changes, 2)
        self.assertAlmostEqual(rewards[0]-rewards[1], .002)

    def test_observation_includes_atr_eligibility_and_current_costs(self):
        env = self.env([[100, 100, 100, 100]]*3, atr=[.03, .04, .04], fee_bps=5, slippage=.1)
        first = env.observation()
        self.assertEqual(first[-2], 0.)
        self.assertAlmostEqual(float(first[-1]), .003)
        env.step(0)
        self.assertEqual(env.observation()[-2], 1.)


class RLTrainingTests(unittest.TestCase):
    def setUp(self):
        CACHE.clear()
        self.addCleanup(CACHE.clear)

    def test_settings_and_api_accept_rl_and_reject_unknown_options(self):
        from server.strategies.strategy import BacktestRequest
        request = BacktestRequest(start_date='2026-01-01', end_date='2026-01-10', strategy='rl_ppo', rl={'min_atr': .04})
        self.assertEqual(request.rl['min_atr'], .04)
        for values in ({'timesteps': 0}, {'learning_rate': float('nan')}, {'min_atr': -.1}, {'lookback': 1.5}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                RLSettings(**values)
        with self.assertRaises(ValueError):
            BacktestRequest(start_date='2026-01-01', end_date='2026-01-10', strategy='rl_ppo', rl={'unknown': 1})

    def test_normalization_is_fitted_only_on_supplied_training_rows(self):
        training = np.array([[1., np.nan], [3., np.nan]])
        scaler = Normalizer.fit(training)
        np.testing.assert_allclose(scaler.mean, [2., 0.])
        self.assertTrue(np.isfinite(scaler.transform(np.array([[100000., np.nan]]))).all())
        np.testing.assert_allclose(scaler.mean, [2., 0.])

    def test_risk_adjusted_checkpoint_selection_keeps_profit_and_sample_gates(self):
        metrics = dict(trades=20, netPnl=10., winRate=70., maxDrawdownPct=-5.)
        self.assertGreater(checkpoint_rank(metrics), checkpoint_rank({**metrics, 'trades': 1, 'winRate': 100.}))
        self.assertGreater(checkpoint_rank(metrics), checkpoint_rank({**metrics, 'netPnl': -10., 'winRate': 90.}))
        self.assertGreater(checkpoint_rank({**metrics, 'returnPct': 10., 'winRate': 60.}),
                           checkpoint_rank({**metrics, 'returnPct': 5., 'winRate': 90.}))
        self.assertGreater(checkpoint_rank({**metrics, 'returnPct': 5., 'maxDrawdownPct': -2.}),
                           checkpoint_rank({**metrics, 'returnPct': 5., 'maxDrawdownPct': -10.}))

    def test_real_ppo_training_checkpoint_and_disk_cache(self):
        frame = market(600)
        features = pd.DataFrame(dict(a=np.arange(600, dtype=float), b=np.sin(np.arange(600))), index=frame.index)
        cfg = RLSettings(train_bars=600, lookback=4, timesteps=256)
        execution = dict(capital=1000., leverage=1., bar_seconds=300)
        with tempfile.TemporaryDirectory() as directory, patch('server.strategies.rl.training.MODEL_ROOT', Path(directory)):
            model, scaler, metadata = train_policy(frame, features, np.full(600, .1), cfg, execution)
            self.assertEqual(metadata['validationStart'], frame.index[480].isoformat())
            np.testing.assert_allclose(scaler.mean, features.iloc[:480].mean().to_numpy())
            self.assertEqual(len(metadata['checkpoints']), 1)
            CACHE.clear()
            with patch('stable_baselines3.PPO.learn', side_effect=AssertionError('Cache must not retrain')):
                restored, restored_scaler, restored_metadata = train_policy(frame, features, np.full(600, .1), cfg, execution)
            self.assertEqual(metadata, restored_metadata)
            observation = TradingEnv(frame, scaler.transform(features.to_numpy()), np.full(600, .1), cfg,
                                     capital=1000.).observation()
            self.assertEqual(int(model.predict(observation, deterministic=True)[0]),
                             int(restored.predict(observation, deterministic=True)[0]))

    def test_backtest_training_cutoffs_are_causal_and_artifacts_are_reused(self):
        from server.strategies.rl.strategy import run_rl_backtest
        frame = market(900)
        calls = []

        class Policy:
            def predict(self, observation, deterministic=True):
                return np.array(0), None

        def train(history, features, atr, cfg, execution, progress=None):
            calls.append(history.index[-1])
            return Policy(), Normalizer.fit(features.to_numpy()), {}

        with patch('server.strategies.rl.strategy.train_policy', side_effect=train):
            result = run_rl_backtest(frame, RLSettings(train_bars=500, retrain_every=200, lookback=4, timesteps=256),
                                     initial_capital=1000, leverage=1, start=frame.index[600])
        self.assertEqual(calls, [frame.index[599], frame.index[799]])
        self.assertTrue(result['trades'].empty)
        self.assertEqual(result['report']['kind'], 'rl')
        self.assertEqual(len(result['bars']), 300)

    def test_paper_session_can_wait_for_its_first_evaluation_candle(self):
        from server.strategies.rl.strategy import run_rl_backtest
        frame = market(600)
        with patch('server.strategies.rl.strategy.train_policy') as train:
            result = run_rl_backtest(frame, RLSettings(train_bars=500), initial_capital=1000., leverage=1.,
                                     start=frame.index[-1]+pd.Timedelta(minutes=5))
        train.assert_not_called()
        self.assertTrue(result['bars'].empty)
        self.assertEqual(result['cash'], 1000.)

    def test_rl_strategy_is_available_for_paper_but_not_live(self):
        from server.strategies.registry import get_strategy
        self.assertEqual(get_strategy('rl_ppo').label, 'RL PPO')
        self.assertFalse(get_strategy('rl_ppo').live_supported)

    def test_rl_training_uses_one_configuration_without_search(self):
        from server.strategies.rl import tuning
        from server.strategies.strategy import BacktestRequest, seconds
        frame = market(1600)
        request = BacktestRequest(start_date='2026-01-03', end_date='2026-01-06', strategy='rl_ppo',
                                  rl=dict(seed=19, learning_rate=.001))
        evaluated = frame.index[frame.index >= pd.Timestamp(seconds(request.start_date), unit='s', tz='UTC')]
        forward = evaluated[int(len(evaluated)*.8)]
        calls, progress = [], []

        def replay(source, settings, **kwargs):
            calls.append((kwargs['start'], source.index[-1], settings.seed, settings.learning_rate))
            kwargs['progress'](0, 'checkpoint')
            heldout = kwargs['start'] >= forward
            return dict(trades=100, winRate=70. if settings.seed == 7 else 60., maxDrawdownPct=-5.,
                        netPnl=(-10000. if settings.seed == 7 else 10000.) if heldout else (10. if settings.seed == 7 else 100.))

        with patch.object(tuning, 'run_rl_backtest', side_effect=replay), \
             patch.object(tuning, '_score', side_effect=lambda result, capital: result):
            result = tuning.rl_train_and_evaluate(frame, request, progress=lambda value, message: progress.append(value))
        self.assertEqual(result['bestParameters']['seed'], 19)
        self.assertEqual(result['bestParameters']['learning_rate'], .001)
        self.assertEqual(len(result['candidates']), 1)
        self.assertEqual(result['candidatesEvaluated'], 1)
        self.assertIsNone(result['gridAxes'])
        self.assertEqual([(seed, rate) for _, _, seed, rate in calls], [(19, .001)]*3)
        self.assertEqual(result['searchMethod'], 'training')
        self.assertEqual(progress, sorted(progress))
        self.assertEqual(progress[-1], 100)
        self.assertTrue(all(last < forward for _, last, _, _ in calls[:2]))

    def test_training_report_explains_loss_sample_size_and_risk_halt(self):
        from server.strategies.rl import tuning
        from server.strategies.strategy import BacktestRequest

        request = BacktestRequest(start_date='2026-01-03', end_date='2026-01-06', strategy='rl_ppo')
        training = dict(trades=25, winRate=64., netPnl=-452.15, maxDrawdownPct=-20.99)
        validation = dict(trades=100, winRate=45.76, netPnl=309.06, maxDrawdownPct=-9.58)
        with patch.object(tuning, 'run_rl_backtest', side_effect=[{'halted': True}, {'halted': False}, {'halted': False}]), \
             patch.object(tuning, '_score', side_effect=[training, validation, validation]):
            result = tuning.rl_train_and_evaluate(market(1600), request)
        case = result['candidates'][0]
        self.assertFalse(case['reliable'])
        reason = ' '.join(case['reliabilityReasons'])
        self.assertIn('-452.15', reason)
        self.assertIn('25 trades', reason)
        self.assertIn('50', reason)
        self.assertIn('drawdown risk limit', reason)

    def test_paper_trading_accepts_rl_settings_and_processes_new_candles(self):
        from server.paper.paper_trading import PaperTrading
        from server.strategies.strategy import BacktestRequest
        frame = market(700)
        clock = [int(frame.index[600].timestamp())]

        class FlatPolicy:
            def predict(self, observation, deterministic=True):
                return np.array(0), None

        def train(history, features, atr, cfg, execution, progress=None):
            return FlatPolicy(), Normalizer.fit(features.to_numpy()), {}

        with tempfile.TemporaryDirectory() as directory, patch('server.strategies.rl.strategy.train_policy', side_effect=train):
            service = PaperTrading(Path(directory)/'paper.json', loader=lambda tf: (frame, {}), now=lambda: clock[0])
            request = BacktestRequest(start_date='2026-01-01', end_date='2026-01-05', strategy='rl_ppo',
                                      rl=dict(train_bars=500, timesteps=256))
            service.begin(request)
            service.advance()
            self.assertIsNone(service.error)
            clock[0] = int(frame.index[602].timestamp())
            service.advance()
            state = service.status()['session']
        self.assertEqual(state['settings']['strategy'], 'rl_ppo')
        self.assertEqual(state['lastProcessed'], int(frame.index[601].timestamp()))
        self.assertEqual(state['trades'], [])

    def test_cash_baseline_beats_losing_or_insufficient_checkpoints(self):
        cash = dict(trades=0, netPnl=0., winRate=0., maxDrawdownPct=0.)
        loser = dict(trades=100, netPnl=-10., winRate=95., maxDrawdownPct=-5.)
        tiny = dict(trades=2, netPnl=10., winRate=100., maxDrawdownPct=-1.)
        self.assertGreater(checkpoint_rank(cash), checkpoint_rank(loser))
        self.assertGreater(checkpoint_rank(cash), checkpoint_rank(tiny))
        self.assertIsNotNone(checkpoint_rejection(loser))
        self.assertIsNotNone(checkpoint_rejection(tiny))
        self.assertIsNotNone(checkpoint_rejection({**tiny, 'trades': 100, 'halted': True}))

    def test_rejected_checkpoint_returns_cash_and_persists_rejection(self):
        frame = market(600)
        features = pd.DataFrame({'a': np.arange(600, dtype=float)}, index=frame.index)
        cash = dict(trades=0, netPnl=0., winRate=0., maxDrawdownPct=0.)
        loser = dict(trades=100, netPnl=-10., winRate=95., maxDrawdownPct=-5.)
        cfg = RLSettings(train_bars=600, lookback=4, timesteps=256)
        execution = dict(capital=1000., leverage=1., bar_seconds=300)
        with tempfile.TemporaryDirectory() as directory, \
             patch('server.strategies.rl.training.MODEL_ROOT', Path(directory)), \
             patch('server.strategies.rl.training.evaluate', side_effect=[cash, loser]):
            model, scaler, metadata = train_policy(frame, features, np.full(600, .1), cfg, execution)
            self.assertIsInstance(model, CashPolicy)
            self.assertFalse(metadata['accepted'])
            self.assertIsNone(metadata['selectedCheckpointSteps'])
            self.assertEqual(metadata['validation']['netPnl'], 0.)
            self.assertEqual(metadata['candidateValidation']['netPnl'], -10.)
            self.assertFalse((Path(directory)/metadata['key']/'policy.zip').exists())
            CACHE.clear()
            with patch('stable_baselines3.PPO.load', side_effect=AssertionError('Do not load rejected weights')):
                restored, _, restored_metadata = train_policy(frame, features, np.full(600, .1), cfg, execution)
            self.assertIsInstance(restored, CashPolicy)
            self.assertEqual(metadata, restored_metadata)

    def test_rejected_policy_cannot_open_positions_in_backtests_or_paper_replay(self):
        from server.strategies.rl.strategy import run_rl_backtest
        from unittest.mock import Mock

        frame = market(700)
        unsafe_policy = Mock()
        unsafe_policy.predict.return_value = (np.array(1), None)
        def train(history, features, atr, cfg, execution, progress=None):
            return unsafe_policy, Normalizer.fit(features.to_numpy()), {'accepted': False}
        with patch('server.strategies.rl.strategy.train_policy', side_effect=train):
            result = run_rl_backtest(frame, RLSettings(train_bars=500, timesteps=256), initial_capital=1000,
                                     leverage=1, start=frame.index[600])
        unsafe_policy.predict.assert_not_called()
        self.assertTrue(result['trades'].empty)
        self.assertEqual(result['cash'], 1000.)
        self.assertFalse(result['bars'].rl_accepted.any())

    def test_accepted_checkpoint_is_saved_and_loaded(self):
        frame = market(600)
        features = pd.DataFrame({'a': np.arange(600, dtype=float)}, index=frame.index)
        cash = dict(trades=0, netPnl=0., winRate=0., maxDrawdownPct=0.)
        winner = dict(trades=20, netPnl=10., winRate=70., maxDrawdownPct=-2.)
        cfg = RLSettings(train_bars=600, lookback=4, timesteps=256)
        execution = dict(capital=1000., leverage=1., bar_seconds=300)
        with tempfile.TemporaryDirectory() as directory, \
             patch('server.strategies.rl.training.MODEL_ROOT', Path(directory)), \
             patch('server.strategies.rl.training.evaluate', side_effect=[cash, winner, winner]):
            model, scaler, metadata = train_policy(frame, features, np.full(600, .1), cfg, execution)
            self.assertTrue(metadata['accepted'])
            self.assertEqual(metadata['selectedCheckpointSteps'], 256)
            self.assertTrue((Path(directory)/metadata['key']/'policy.zip').exists())
            CACHE.clear()
            with patch('stable_baselines3.PPO.learn', side_effect=AssertionError('Do not retrain accepted cache')):
                restored, _, _ = train_policy(frame, features, np.full(600, .1), cfg, execution)
            observation = TradingEnv(frame, scaler.transform(features.to_numpy()), np.full(600, .1), cfg,
                                     capital=1000.).observation()
            self.assertEqual(int(model.predict(observation, deterministic=True)[0]),
                             int(restored.predict(observation, deterministic=True)[0]))

    def test_training_restores_the_best_risk_adjusted_eligible_checkpoint(self):
        import torch

        frame = market(600)
        features = pd.DataFrame({'a': np.arange(600, dtype=float)}, index=frame.index)
        cash = dict(trades=0, netPnl=0., winRate=0., maxDrawdownPct=0.)
        first = dict(trades=20, netPnl=10., returnPct=1., winRate=60., maxDrawdownPct=-2.)
        second = dict(trades=30, netPnl=50., returnPct=5., winRate=70., maxDrawdownPct=-20.)
        snapshots = []
        def validate(model, *args):
            if isinstance(model, CashPolicy):
                return cash
            if len(snapshots) == 2:
                return first  # untouched confirmation of restored first checkpoint
            snapshots.append({key: value.clone() for key, value in model.policy.state_dict().items()})
            return first if len(snapshots) == 1 else second
        cfg = RLSettings(train_bars=600, lookback=4, timesteps=4096)
        with tempfile.TemporaryDirectory() as directory, \
             patch('server.strategies.rl.training.MODEL_ROOT', Path(directory)), \
             patch('server.strategies.rl.training.evaluate', side_effect=validate):
            model, _, metadata = train_policy(frame, features, np.full(600, .1), cfg,
                                               dict(capital=1000., leverage=1., bar_seconds=300))
        self.assertEqual(metadata['selectedCheckpointSteps'], 2048)
        self.assertEqual(len(metadata['checkpoints']), 2)
        self.assertEqual(metadata['validation'], first)
        for key, value in model.policy.state_dict().items():
            torch.testing.assert_close(value, snapshots[0][key])


class RLQualityTests(unittest.TestCase):
    def setUp(self):
        CACHE.clear()
        self.addCleanup(CACHE.clear)

    def test_observation_exposes_balance_exposure_and_stop_distance(self):
        frame = bars([[100, 100.1, 99.9, 100]]*4)
        env = TradingEnv(frame, np.zeros((4, 2), np.float32), np.ones(4),
                         RLSettings(lookback=1), capital=1000., fee_bps=5.)
        np.testing.assert_allclose(env.observation()[-10:-6], 0.)
        env.step(1)
        state = env.observation()[-10:]
        self.assertAlmostEqual(float(state[0]), -.0005)
        self.assertAlmostEqual(float(state[1]), -.0005)
        self.assertAlmostEqual(float(state[2]), 1.)
        self.assertAlmostEqual(float(state[3]), .03)
        self.assertEqual(len(env.observation()), env.observation_space.shape[0])

    def test_positive_drawdown_rank_uses_magnitude(self):
        base = dict(trades=20, netPnl=10., returnPct=0., winRate=60.)
        self.assertGreater(checkpoint_rank(dict(base, maxDrawdownPct=2.)),
                           checkpoint_rank(dict(base, maxDrawdownPct=10.)))
        self.assertIsNotNone(checkpoint_rejection(dict(base, maxDrawdownPct=2., returnPct=np.nan)))

    def test_confirmation_is_untouched_during_selection_and_can_veto_policy(self):
        frame = market(600)
        features = pd.DataFrame({'a': np.arange(600, dtype=float)}, index=frame.index)
        cash = dict(trades=0, netPnl=0., winRate=0., maxDrawdownPct=0.)
        winner = dict(trades=20, netPnl=10., winRate=60., maxDrawdownPct=-2.)
        loser = dict(winner, netPnl=-1.)
        calls = []

        def validate(model, source, values, atr, cfg, execution, first):
            calls.append((source.index[-1], first))
            return cash if isinstance(model, CashPolicy) else winner if len(calls) <= 3 else loser

        cfg = RLSettings(train_bars=600, lookback=4, timesteps=4096)
        with tempfile.TemporaryDirectory() as directory, \
             patch('server.strategies.rl.training.MODEL_ROOT', Path(directory)), \
             patch('server.strategies.rl.training.evaluate', side_effect=validate):
            model, scaler, metadata = train_policy(frame, features, np.ones(600), cfg,
                                                   dict(capital=1000., leverage=1., bar_seconds=300))
            self.assertEqual(calls, [(frame.index[539], 479)]*3+[(frame.index[599], 539)])
            self.assertIsInstance(model, CashPolicy)
            self.assertFalse(metadata['accepted'])
            self.assertIn('Confirmation rejected', metadata['selectionReason'])
            self.assertFalse((Path(directory)/metadata['key']/'policy.zip').exists())
            self.assertLess(metadata['trainingEpisodeBars'], 480-cfg.lookback)
            np.testing.assert_allclose(scaler.mean, features.iloc[:480].mean().to_numpy())

    def test_training_episodes_cover_different_starts_reproducibly(self):
        frame = market(480)
        env = TradingEnv(frame, np.zeros((480, 2), np.float32), np.ones(480), RLSettings(lookback=4),
                         random_start=True, episode_bars=119)
        env.reset(seed=17)
        starts = []
        for _ in range(12):
            env.reset()
            starts.append(env.t)
            self.assertLess(env.end, len(frame))
        self.assertGreater(len(set(starts)), 1)
        env.reset(seed=17)
        repeat = []
        for _ in range(12):
            env.reset()
            repeat.append(env.t)
        self.assertEqual(starts, repeat)


    def test_learning_reward_scales_without_altering_account_and_liquidation_is_terminal(self):
        from server.strategies.rl.environment import TrainingEnv

        frame = bars([[100, 100.1, 99.9, 100]]*3)
        args = (frame, np.zeros((3, 2), np.float32), np.ones(3), RLSettings(lookback=1))
        replay = TradingEnv(*args, capital=1000., fee_bps=5.)
        learning = TrainingEnv(*args, capital=1000., fee_bps=5.)
        for action in (1, 0):
            expected, actual = replay.step(action), learning.step(action)
            self.assertAlmostEqual(actual[1], 100.*expected[1])
            self.assertEqual(learning.equity, replay.equity)
        self.assertTrue(actual[2])
        self.assertFalse(actual[3])
        self.assertEqual(learning.trades, replay.trades)


    def test_atr_changes_invalidate_artifact_cache(self):
        frame = market(600)
        features = pd.DataFrame({'a': np.arange(600, dtype=float)}, index=frame.index)
        cash = dict(trades=0, netPnl=0., winRate=0., maxDrawdownPct=0.)
        cfg = RLSettings(train_bars=600, lookback=4, timesteps=256)
        execution = dict(capital=1000., leverage=1., bar_seconds=300)
        with tempfile.TemporaryDirectory() as directory, \
             patch('server.strategies.rl.training.MODEL_ROOT', Path(directory)), \
             patch('server.strategies.rl.training.evaluate', return_value=cash):
            _, _, first = train_policy(frame, features, np.ones(600), cfg, execution)
            _, _, second = train_policy(frame, features, np.full(600, 2.), cfg, execution)
        self.assertNotEqual(first['key'], second['key'])


    def test_zero_trade_report_exposes_rejected_policies_and_replay_coverage(self):
        from server.strategies.rl import tuning
        from server.strategies.strategy import BacktestRequest

        frame = market(1600)
        request = BacktestRequest(start_date='2026-01-03', end_date='2026-01-06', strategy='rl_ppo')
        replay = dict(bars=frame.iloc[:12], report=dict(
            folds=[dict(training=dict(accepted=False, selectionReason='Confirmation rejected: loss'))],
            rejectedPolicyBlocks=1, message='No policy passed confirmation'))
        score = dict(trades=0, netPnl=0., winRate=0., maxDrawdownPct=0.)
        with patch.object(tuning, 'run_rl_backtest', return_value=replay), \
             patch.object(tuning, '_score', side_effect=lambda result, capital: dict(score)):
            result = tuning.rl_train_and_evaluate(frame, request)
        metrics = result['periods']['forwardTest']['metrics']
        self.assertEqual(metrics['evaluatedBars'], 12)
        self.assertGreater(metrics['availableBars'], 0)
        self.assertEqual(metrics['policyBlocks'], 1)
        self.assertEqual(metrics['rejectedPolicyBlocks'], 1)
        self.assertEqual(metrics['rejectionReasons'], ['Confirmation rejected: loss'])

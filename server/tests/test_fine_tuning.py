import unittest
from itertools import product
from server.strategies.fine_tuning import _candidate_set, _grid_candidates
from server.strategies.bb_outer_reversal import Settings


class CandidateTypeTests(unittest.TestCase):
    def test_whole_number_continuous_parameters_do_not_use_integer_limits(self):
        base = Settings(amount_per_trade=2000, amount_unit='price', leverage=10,
                        bb_mult=3, initial_sl=1, trail_trigger=1,
                        trail_distance=1, trail_multiplier=2)
        candidates = _candidate_set(base, 16, 1729)
        self.assertEqual(len(candidates), 16)
        for params in candidates:
            Settings(**params)

    def test_integer_and_float_inputs_produce_identical_searches(self):
        left = _candidate_set(Settings(amount_per_trade=100, bb_mult=3, leverage=1), 8, 1729)
        right = _candidate_set(Settings(amount_per_trade=100., bb_mult=3., leverage=1.), 8, 1729)
        self.assertEqual(left, right)


class GridSearchTests(unittest.TestCase):
    def test_every_cartesian_combination_is_present(self):
        axes, candidates = _grid_candidates(Settings(leverage=2., amount_per_trade=10.))
        names = list(axes)
        expected = set(product(*(axes[name] for name in names)))
        actual = {tuple(candidate[name] for name in names) for candidate in candidates}
        self.assertEqual(actual, expected)
        self.assertEqual(len(candidates), 243)
        for candidate in candidates:
            self.assertEqual(candidate['leverage'], 2.)
            self.assertEqual(candidate['amount_per_trade'], 10.)
            Settings(**candidate)



class ProfitRankingTests(unittest.TestCase):
    def test_profit_objective_prefers_net_profit_over_win_rate(self):
        from server.strategies.fine_tuning import _ranking_key
        high_win = dict(trades=100, netPnl=10., maxDrawdownPct=-1., winRate=90., score=90.)
        high_profit = dict(trades=100, netPnl=100., maxDrawdownPct=-5., winRate=55., score=65.)
        self.assertGreater(_ranking_key(high_profit, 'profit'), _ranking_key(high_win, 'profit'))

    def test_profit_objective_discounts_one_trade_results(self):
        from server.strategies.fine_tuning import _ranking_key
        adequate = dict(trades=30, netPnl=100., maxDrawdownPct=-5., winRate=55., score=65.)
        tiny = {**adequate, 'trades': 1, 'netPnl': 1000.}
        self.assertGreater(_ranking_key(adequate, 'profit'), _ranking_key(tiny, 'profit'))

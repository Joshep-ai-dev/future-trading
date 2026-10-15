import unittest
from .fine_tuning import _candidate_set
from .bb_outer_reversal import Settings


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

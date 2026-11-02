from datetime import date
import unittest

import pandas as pd

from server.strategies.strategy import split_points


class SplitPointTests(unittest.TestCase):
    def setUp(self) -> None:
        self.index = pd.date_range('2026-01-01', periods=100, freq='D', tz='UTC')

    def test_automatic_split_keeps_original_proportions(self) -> None:
        self.assertEqual(split_points(self.index), (60, 80))

    def test_late_validation_moves_automatic_forward_after_it(self) -> None:
        self.assertEqual(split_points(self.index, validation_start=date(2026, 4, 1)), (90, 95))

    def test_early_forward_moves_automatic_validation_before_it(self) -> None:
        self.assertEqual(split_points(self.index, forward_start=date(2026, 2, 10)), (30, 40))

    def test_explicit_dates_are_preserved(self) -> None:
        self.assertEqual(split_points(self.index, date(2026, 3, 1), date(2026, 3, 21)), (59, 79))

    def test_invalid_dates_report_actual_candle_range(self) -> None:
        for validation, forward in [(date(2025, 12, 1), None),
                                    (date(2026, 3, 21), date(2026, 3, 1)),
                                    (None, date(2026, 5, 1))]:
            with self.subTest(validation=validation, forward=forward):
                with self.assertRaisesRegex(ValueError, 'Available candle range.*2026-01-01'):
                    split_points(self.index, validation, forward)

    def test_insufficient_candles_cannot_create_empty_periods(self) -> None:
        with self.assertRaisesRegex(ValueError, 'Each tuning period'):
            split_points(self.index[:2])

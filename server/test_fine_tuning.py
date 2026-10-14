import unittest

from .fine_tuning import _mode_key


class RecommendationTests(unittest.TestCase):
    def metrics(self, **changes):
        return dict(trades=30, averageLossPct=2., maxDrawdownPct=-10.,
                    netPnl=100., winRate=60., **changes) if not changes else {
                        **self.metrics(), **changes}

    def test_each_mode_selects_its_objective(self):
        base = self.metrics()
        for mode, changes in (
            ('lower_loss', {'averageLossPct': 1.}),
            ('higher_profit', {'netPnl': 200.}),
            ('higher_win_rate', {'winRate': 80.}),
            ('more_trades', {'trades': 60}),
        ):
            with self.subTest(mode=mode):
                self.assertGreater(_mode_key(self.metrics(**changes), mode),
                                   _mode_key(base, mode))

    def test_zero_trades_cannot_win_lower_loss(self):
        empty = self.metrics(trades=0, averageLossPct=0., maxDrawdownPct=0.)
        self.assertGreater(_mode_key(self.metrics(), 'lower_loss'),
                           _mode_key(empty, 'lower_loss'))

    def test_tiny_samples_do_not_win_on_win_rate(self):
        tiny = self.metrics(trades=1, winRate=100.)
        self.assertGreater(_mode_key(self.metrics(), 'higher_win_rate'),
                           _mode_key(tiny, 'higher_win_rate'))

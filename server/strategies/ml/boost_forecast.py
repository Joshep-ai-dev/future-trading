"""Calibrated quantile gradient-boosting forecast (LightGBM).

Targets are in ATR units at the origin candle (see ``forecast_inputs``):
``up``/``down`` excursions, the close move ``trend`` at the horizon and
optional per-step close moves for the path.

Accuracy safeguards, all fitted on a purged chronological calibration tail
that the boosted trees never train on:

* early stopping picks the tree count, then the final trees refit on all rows;
* the median close move is *shrunk* toward "no change" by the factor that
  minimises calibration MAE, so a weak signal cannot overstate moves;
* conformalised quantile regression (CQR) widens the 10%-90% band until it
  covers 80% of calibration outcomes;
* the direction probability is Platt-calibrated on the same tail.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

COVERAGE = .8
# ADX/DMI and Supertrend columns from the adx_supertrend feature group.
CORE_PREFIXES = ('adx', 'plus_di', 'minus_di', 'di_spread', 'st_')
PARAMS = dict(n_estimators=800, learning_rate=.03, num_leaves=15, min_child_samples=40,
              subsample=.8, subsample_freq=1, colsample_bytree=.7, reg_lambda=1.,
              random_state=7, n_jobs=2, verbose=-1, deterministic=True, force_row_wise=True)


def _regressor(objective: str, **extra):
    from lightgbm import LGBMRegressor
    return LGBMRegressor(**{**PARAMS, 'objective': objective, **extra})


def _fit_early(make, x_fit, y_fit, x_cal, y_cal):
    """Fit with early stopping on the calibration tail; return (model, best tree count)."""
    import lightgbm as lgb
    model = make()
    model.fit(x_fit, y_fit, eval_set=[(x_cal, y_cal)], callbacks=[lgb.early_stopping(60, verbose=False)])
    return model, max(20, int(model.best_iteration_ or PARAMS['n_estimators']))


def _anchor_steps(horizon: int, available: list[int]) -> list[int]:
    wanted = {max(1, round(horizon*f)) for f in (.25, .5, .75)}
    return sorted(step for step in wanted if step < horizon and step in available)


@dataclass
class BoostForecast:
    models: dict
    names: list[str]
    horizon: int
    anchors: list[int]
    shrink: float
    band: float
    platt: tuple[float, float]
    calibration: dict = field(default_factory=dict)
    epochs_trained: int | None = None

    @classmethod
    def fit(cls, features: pd.DataFrame, targets: pd.DataFrame, rows: slice, *, horizon: int) -> 'BoostForecast':
        from sklearn.linear_model import LogisticRegression

        start, stop = rows.start or 0, rows.stop
        index = np.arange(start, stop)
        index = index[np.isfinite(targets[['up', 'down', 'trend']].iloc[index].to_numpy()).all(axis=1)]
        if len(index) < 300:
            raise ValueError('Quantile boosting needs at least 300 complete training targets')
        # Purged chronological split: calibration tail, and no fit target whose
        # horizon reaches into it.
        cal = index[int(len(index)*.8):]
        fit = index[index+horizon < cal[0]]
        if len(fit) < 200 or len(cal) < 60:
            raise ValueError('Not enough history for a purged calibration tail; increase training candles')
        x = features.to_numpy(np.float32)
        y = targets
        steps = [int(c.rsplit('_', 1)[1]) for c in targets.columns if c.startswith('close_step_')]
        anchors = _anchor_steps(horizon, steps)
        specs = {'up': ('l1', {}), 'down': ('l1', {}), 'trend': ('quantile', {'alpha': .5}),
                 'trend_lo': ('quantile', {'alpha': (1-COVERAGE)/2}), 'trend_hi': ('quantile', {'alpha': 1-(1-COVERAGE)/2})}
        specs.update({f'step_{s}': ('l1', {}) for s in anchors})
        source = {name: ('trend' if name.startswith('trend') else f'close_step_{name[5:]}' if name.startswith('step_') else name)
                  for name in specs}
        models, trees, cal_pred = {}, {}, {}
        for name, (objective, extra) in specs.items():
            column = source[name]
            y_all = y[column].to_numpy(np.float64)
            f_rows, c_rows = fit[np.isfinite(y_all[fit])], cal[np.isfinite(y_all[cal])]
            model, count = _fit_early(lambda: _regressor(objective, **extra), x[f_rows], y_all[f_rows], x[c_rows], y_all[c_rows])
            trees[name] = count
            cal_pred[name] = model.predict(x[cal], num_iteration=count)
        truth = y['trend'].to_numpy(np.float64)[cal]
        # Shrink the median move toward zero (the random-walk baseline).
        grid = np.linspace(0, 1.5, 61)
        errors = [np.abs(s*cal_pred['trend']-truth).mean() for s in grid]
        shrink = float(grid[int(np.argmin(errors))])
        # CQR: widen [lo, hi] by the conformal quantile of the band misses.
        lo, hi = np.minimum(cal_pred['trend_lo'], cal_pred['trend_hi']), np.maximum(cal_pred['trend_lo'], cal_pred['trend_hi'])
        miss = np.maximum(lo-truth, truth-hi)
        level = min(1., COVERAGE*(1+1/len(miss)))
        band = float(np.quantile(miss, level))
        # Direction classifier, Platt-scaled on the calibration tail.
        from lightgbm import LGBMClassifier
        import lightgbm as lgb
        direction_all = y['trend'].to_numpy(np.float64)
        moving_fit, moving_cal = fit[direction_all[fit] != 0], cal[direction_all[cal] != 0]
        classifier = LGBMClassifier(objective='binary', **PARAMS)
        classifier.fit(x[moving_fit], direction_all[moving_fit] > 0, eval_set=[(x[moving_cal], direction_all[moving_cal] > 0)],
                       callbacks=[lgb.early_stopping(60, verbose=False)])
        trees['direction'] = max(20, int(classifier.best_iteration_ or PARAMS['n_estimators']))
        raw = np.clip(classifier.predict_proba(x[moving_cal], num_iteration=trees['direction'])[:, 1], 1e-4, 1-1e-4)
        labels = direction_all[moving_cal] > 0
        if labels.all() or not labels.any():
            platt = (1., 0.)
        else:
            logistic = LogisticRegression(C=1e3).fit(np.log(raw/(1-raw))[:, None], labels)
            platt = (float(logistic.coef_[0, 0]), float(logistic.intercept_[0]))
        calibrated = 1/(1+np.exp(-(platt[0]*np.log(raw/(1-raw))+platt[1])))
        moved_truth = direction_all[moving_cal]
        calibration = dict(samples=int(len(cal)), shrink=shrink, bandAtr=band,
                           maeAtr=float(np.min(errors)), baselineMaeAtr=float(np.abs(truth).mean()),
                           coverage=float(((truth >= lo-band) & (truth <= hi+band)).mean()),
                           directionAccuracy=float(((calibrated > .5) == (moved_truth > 0)).mean()) if len(moved_truth) else None,
                           brier=float(np.mean((calibrated-(moved_truth > 0))**2)) if len(moved_truth) else None)
        # Final fit on every row with the tree counts chosen above.
        final = {}
        for name, (objective, extra) in specs.items():
            y_all = y[source[name]].to_numpy(np.float64)
            rows_ok = index[np.isfinite(y_all[index])]
            model = _regressor(objective, **{**extra, 'n_estimators': trees[name]})
            model.fit(x[rows_ok], y_all[rows_ok])
            final[name] = model
        moving = index[direction_all[index] != 0]
        final_classifier = LGBMClassifier(objective='binary', **{**PARAMS, 'n_estimators': trees['direction']})
        final_classifier.fit(x[moving], direction_all[moving] > 0)
        final['direction'] = final_classifier
        gains = final['trend'].booster_.feature_importance('gain')
        core = np.array([name.startswith(CORE_PREFIXES) for name in features.columns])
        if gains.sum() > 0 and core.any():
            calibration['coreImportancePct'] = float(100*gains[core].sum()/gains.sum())
        return cls(final, list(features.columns), horizon, anchors, shrink, band, platt, calibration,
                   epochs_trained=int(max(trees.values())))

    def _predict(self, features: pd.DataFrame, rows: slice) -> dict:
        x = features.iloc[rows].to_numpy(np.float32)
        out = {name: model.predict(x) for name, model in self.models.items() if name != 'direction'}
        raw = np.clip(self.models['direction'].predict_proba(x)[:, 1], 1e-4, 1-1e-4)
        a, b = self.platt
        out['p_up'] = 1/(1+np.exp(-(a*np.log(raw/(1-raw))+b)))
        return out

    def forecast_rows(self, features: pd.DataFrame, rows: slice) -> np.ndarray:
        out = self._predict(features, rows)
        up, down = np.maximum(out['up'], 0.), np.maximum(out['down'], 0.)
        return np.column_stack([up, down, np.clip(self.shrink*out['trend'], -down, up)])

    def forecast_interval_rows(self, features: pd.DataFrame, rows: slice) -> np.ndarray:
        """Conformal 80% band for the close move at the horizon (ATR units)."""
        out = self._predict(features, rows)
        lo, hi = np.minimum(out['trend_lo'], out['trend_hi']), np.maximum(out['trend_lo'], out['trend_hi'])
        return np.column_stack([lo-self.band, hi+self.band])

    def direction_rows(self, features: pd.DataFrame, rows: slice) -> np.ndarray:
        return self._predict(features, rows)['p_up']

    def forecast_path_rows(self, features: pd.DataFrame, rows: slice) -> np.ndarray:
        out = self._predict(features, rows)
        bounds = self.forecast_rows(features, rows)
        known_steps = [0, *self.anchors, self.horizon]
        known = np.column_stack([np.zeros(len(bounds)), *[self.shrink*out[f'step_{s}'] for s in self.anchors], bounds[:, 2]])
        steps = np.arange(1, self.horizon+1)
        path = np.vstack([np.interp(steps, known_steps, row) for row in known])
        path = np.clip(path, -bounds[:, 1, None], bounds[:, 0, None])
        path[:, -1] = bounds[:, 2]
        return path

    def predict_rows(self, features: pd.DataFrame, rows: slice) -> np.ndarray:
        p = self.direction_rows(features, rows)
        return np.column_stack([1-p, np.zeros(len(p)), p])

    def importance(self) -> dict[str, float]:
        gains = self.models['trend'].booster_.feature_importance('gain')
        total = float(gains.sum()) or 1.
        return dict(zip(self.names, map(lambda v: float(v)/total, gains)))

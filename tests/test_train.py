import numpy as np

from floodline.train import average_precision, best_f1_cutoff, fit_platt


def test_platt_recovers_parameters():
    rng = np.random.default_rng(0)
    x = rng.normal(0, 3, 50_000)
    y = (rng.random(50_000) < 1 / (1 + np.exp(-(0.5 * x - 1)))).astype(float)
    a, b = fit_platt(x, y)
    assert abs(a - 0.5) < 0.03 and abs(b + 1) < 0.05


def test_platt_stays_finite_when_separable():
    x = np.r_[np.full(1000, -20.0), np.full(1000, 20.0)]
    y = np.r_[np.zeros(1000), np.ones(1000)]
    a, b = fit_platt(x, y)
    assert np.isfinite(a) and np.isfinite(b) and abs(a) < 100


def test_ap_and_cutoff():
    y = np.array([0, 0, 1, 1])
    p = np.array([0.1, 0.2, 0.8, 0.9])
    assert average_precision(y, p) == 1.0
    cut, f1 = best_f1_cutoff(y, p)
    assert cut == 0.8 and f1 == 1.0

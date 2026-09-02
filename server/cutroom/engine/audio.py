"""Voice treatments — the named chains a spoken line can be heard through.

A treatment is a sound the line arrives THROUGH: a radio speaker, a phone
earpiece, a megaphone, a room. It is never applied by default; the caller names
one, and the untreated take is always kept alongside the treated one.

  radio      band-limit, speaker resonance, saturation, AGC, wow/flutter,
             band-matched static bed
  phone      narrow band-limit and a little grit, no noise bed
  megaphone  band-limit, hard mid honk, hard clip
  hall       the dry line plus a short tail of decaying early reflections

The primitives below (bandpass, peaking EQ, saturation, compression,
wow/flutter, noise bed, delay taps) are the whole kit; a new treatment is a new
recipe over them, not new DSP.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from scipy.signal import butter, sosfilt, sosfiltfilt, tf2sos

from . import ffmpeg

SR = 44100


def bandpass(x: np.ndarray, low: float, high: float, sr: int = SR,
             order: int = 4) -> np.ndarray:
    sos = butter(order, [low, high], btype="band", fs=sr, output="sos")
    return sosfiltfilt(sos, x)  # zero-phase: no group-delay smear on transients


def lowpass(x: np.ndarray, cutoff: float, sr: int = SR,
            order: int = 4) -> np.ndarray:
    sos = butter(order, cutoff, btype="low", fs=sr, output="sos")
    return sosfiltfilt(sos, x)


def peaking(x: np.ndarray, f0: float, gain_db: float, q: float = 1.2,
            sr: int = SR) -> np.ndarray:
    """RBJ peaking EQ — the cheap-speaker mid honk."""
    A = 10 ** (gain_db / 40.0)
    w0 = 2 * math.pi * f0 / sr
    alpha = math.sin(w0) / (2 * q)
    b0, b1, b2 = 1 + alpha * A, -2 * math.cos(w0), 1 - alpha * A
    a0, a1, a2 = 1 + alpha / A, -2 * math.cos(w0), 1 - alpha / A
    sos = tf2sos([b0 / a0, b1 / a0, b2 / a0], [1.0, a1 / a0, a2 / a0])
    return sosfilt(sos, x)


def saturate(x: np.ndarray, drive: float) -> np.ndarray:
    if drive <= 1.0:
        return x
    return np.tanh(drive * x) / np.tanh(drive)


def compress(x: np.ndarray, thresh_db: float = -20.0, ratio: float = 2.5,
             atk: float = 0.005, rel: float = 0.08, sr: int = SR) -> np.ndarray:
    """Gentle feed-forward compressor with a smoothed detector (broadcast AGC)."""
    eps = 1e-9
    a_a = np.exp(-1.0 / (atk * sr))
    a_r = np.exp(-1.0 / (rel * sr))
    ax = np.abs(x)
    env = np.zeros_like(x)
    prev = 0.0
    for i in range(len(x)):
        c = a_a if ax[i] > prev else a_r
        prev = c * prev + (1 - c) * ax[i]
        env[i] = prev
    env_db = 20 * np.log10(env + eps)
    over = np.clip(env_db - thresh_db, 0, None)
    gain_db = -over * (1 - 1.0 / ratio)
    return x * (10 ** (gain_db / 20.0))


def wow_flutter(x: np.ndarray, depth: float, sr: int = SR) -> np.ndarray:
    """Slow wow (~0.6 Hz) + faint flutter (~7 Hz) via fractional resampling."""
    if depth <= 0:
        return x
    n = len(x)
    t = np.arange(n)
    wow = 0.0016 * depth * np.sin(2 * np.pi * 0.6 * t / sr)
    flut = 0.0006 * depth * np.sin(2 * np.pi * 7.0 * t / sr)
    idx = np.clip(t + (wow + flut) * sr, 0, n - 1.001)
    i0 = np.floor(idx).astype(int)
    frac = idx - i0
    return x[i0] * (1 - frac) + x[np.minimum(i0 + 1, n - 1)] * frac


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(x ** 2) + 1e-12))


def make_static(n: int, low: float, high: float,
                static_path: str | Path | None, target_db: float) -> np.ndarray:
    """Band-matched static bed at target_db RMS, length n samples."""
    if static_path and Path(static_path).exists():
        s = ffmpeg.decode_audio(static_path)
        if len(s) < n:
            s = np.tile(s, int(np.ceil(n / len(s))))
        s = s[:n]
    else:  # synthesize: white noise + sparse crackle
        s = np.random.default_rng(7).standard_normal(n) * 0.5
        crack = np.random.default_rng(11).random(n) < 0.00008
        s[crack] += np.random.default_rng(13).standard_normal(int(crack.sum())) * 2.0
    s = bandpass(s, max(low, 250), high)
    return s / (rms(s) + 1e-9) * (10 ** (target_db / 20.0))


def delay_taps(x: np.ndarray, taps: list[tuple[float, float]],
               sr: int = SR) -> np.ndarray:
    """Sum of decaying delayed copies — early reflections, no convolution."""
    y = np.zeros_like(x)
    for delay_s, gain in taps:
        d = int(delay_s * sr)
        if 0 < d < len(x):
            y[d:] += x[:len(x) - d] * gain
    return y


def normalize(x: np.ndarray, out_db: float = -3.0) -> np.ndarray:
    peak = np.max(np.abs(x)) + 1e-9
    return x / peak * (10 ** (out_db / 20.0))


# ------------------------------------------------------------------ chains

def radio(x: np.ndarray, low: float = 300.0, high: float = 3400.0,
          drive: float = 1.7, comp_db: float = -20.0, ratio: float = 2.5,
          wow: float = 0.15, static_path: str | Path | None = None,
          static_db: float = -38.0, out_db: float = -3.0) -> np.ndarray:
    """A cheap speaker on the other end of a broadcast. Order matters."""
    y = bandpass(x, low, high)
    y = peaking(y, 1600.0, 3.5, q=1.1)
    y = saturate(y, drive)
    y = compress(y, thresh_db=comp_db, ratio=ratio)
    y = wow_flutter(y, wow)
    y = y + make_static(len(y), low, high, static_path, static_db)
    return normalize(y, out_db)


def phone(x: np.ndarray, low: float = 400.0, high: float = 2800.0,
          drive: float = 1.2, comp_db: float = -18.0, ratio: float = 3.0,
          out_db: float = -3.0) -> np.ndarray:
    """An earpiece: narrower than radio, dry, no bed."""
    y = bandpass(x, low, high)
    y = peaking(y, 1000.0, 2.0, q=1.4)
    y = saturate(y, drive)
    y = compress(y, thresh_db=comp_db, ratio=ratio)
    return normalize(y, out_db)


def megaphone(x: np.ndarray, low: float = 500.0, high: float = 3800.0,
              drive: float = 3.0, clip: float = 0.55,
              out_db: float = -3.0) -> np.ndarray:
    """A horn driver pushed past its limit: honk, then hard clip."""
    y = bandpass(x, low, high)
    y = peaking(y, 2200.0, 8.0, q=0.9)
    y = saturate(y, drive)
    y = np.clip(y, -clip, clip)
    return normalize(y, out_db)


#: Early reflections of a stone room: arrival time in seconds at `size` 1.0,
#: and how much of the line comes back. Each bounce loses the top as well as
#: the level, which is what `damp` does below.
HALL_TAPS = [(0.023, 0.50), (0.041, 0.36), (0.067, 0.26), (0.101, 0.18),
             (0.149, 0.12), (0.157, 0.10), (0.181, 0.08), (0.211, 0.08),
             (0.233, 0.06), (0.277, 0.04)]


def hall(x: np.ndarray, size: float = 1.0, wet: float = 0.85,
         damp: float = 2200.0, out_db: float = -3.0) -> np.ndarray:
    """A room, not a cathedral: the dry line plus damped early reflections."""
    taps = [(d * size, g) for d, g in HALL_TAPS]
    tail = lowpass(delay_taps(x, taps), damp)
    return normalize(x + wet * tail, out_db)


#: name → chain. "none" is the default everywhere and is not in here: it means
#: ship the line as recorded, so no treated file is written at all.
TREATMENTS = {"radio": radio, "phone": phone,
              "megaphone": megaphone, "hall": hall}
TREATMENT_NAMES = ("none",) + tuple(TREATMENTS)


def treat(name: str, x: np.ndarray, **params) -> np.ndarray:
    chain = TREATMENTS.get(name)
    if chain is None:
        raise ValueError(f"no voice treatment {name!r} "
                         f"(know: {', '.join(TREATMENT_NAMES)})")
    return chain(x, **params)


def treat_file(name: str, inp: str | Path, out: str | Path, **params) -> Path:
    return ffmpeg.encode_audio(treat(name, ffmpeg.decode_audio(inp), **params),
                               out)

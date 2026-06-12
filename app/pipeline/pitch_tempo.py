from __future__ import annotations

import hashlib
import logging
import shutil
import subprocess
import threading
from pathlib import Path

from app.core.config import RUBBERBAND_BIN, TIMEOUT_FFMPEG, ffmpeg_executable

logger = logging.getLogger("stemdeck.pipeline")

PITCH_MIN = -12.0
PITCH_MAX = 12.0
TEMPO_MIN = 0.5
TEMPO_MAX = 2.0

_cache_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def is_identity(pitch_semitones: float, tempo_ratio: float) -> bool:
    return abs(pitch_semitones) < 1e-6 and abs(tempo_ratio - 1.0) < 1e-6


def cache_key(pitch_semitones: float, tempo_ratio: float, preserve_pitch: bool) -> str:
    blob = f"p={pitch_semitones:.4f};t={tempo_ratio:.6f};pp={int(preserve_pitch)}"
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def shifted_path(
    jobs_dir: Path,
    job_id: str,
    pitch_semitones: float,
    tempo_ratio: float,
    preserve_pitch: bool,
    stem_name: str,
) -> Path:
    key = cache_key(pitch_semitones, tempo_ratio, preserve_pitch)
    return jobs_dir / job_id / "shifted" / key / f"{stem_name}.wav"


def rubberband_executable() -> str | None:
    if RUBBERBAND_BIN.is_file():
        return str(RUBBERBAND_BIN)
    return shutil.which("rubberband")


def ffmpeg_has_rubberband() -> bool:
    try:
        proc = subprocess.run(
            [ffmpeg_executable(), "-filters"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        return "rubberband" in (proc.stdout or "")
    except (OSError, subprocess.TimeoutExpired):
        return False


def pitch_tempo_available() -> bool:
    return rubberband_executable() is not None or ffmpeg_has_rubberband()


def _atempo_chain(ratio: float) -> str:
    filters: list[str] = []
    r = ratio
    while r > 2.0 + 1e-9:
        filters.append("atempo=2.0")
        r /= 2.0
    while r < 0.5 - 1e-9:
        filters.append("atempo=0.5")
        r /= 0.5
    if abs(r - 1.0) > 1e-6:
        filters.append(f"atempo={r:.6f}")
    return ",".join(filters)


def _run_rubberband_cli(
    src: Path,
    dst: Path,
    pitch_semitones: float,
    tempo_ratio: float,
) -> None:
    rb = rubberband_executable()
    if not rb:
        raise RuntimeError("rubberband CLI not found")
    cmd = [
        rb,
        "-q",
        f"--pitch={pitch_semitones}",
        f"--tempo={tempo_ratio}",
        str(src),
        str(dst),
    ]
    proc = subprocess.run(  # noqa: S603
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=TIMEOUT_FFMPEG,
        check=False,
    )
    if proc.returncode != 0:
        tail = (proc.stderr or b"")[-2000:].decode("utf-8", "replace")
        raise RuntimeError(f"rubberband failed: {tail or proc.returncode}")


def _run_ffmpeg_filter(src: Path, dst: Path, filter_str: str) -> None:
    cmd = [
        ffmpeg_executable(),
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(src),
        "-af",
        filter_str,
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        str(dst),
    ]
    proc = subprocess.run(  # noqa: S603
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=TIMEOUT_FFMPEG,
        check=False,
    )
    if proc.returncode != 0:
        tail = (proc.stderr or b"")[-2000:].decode("utf-8", "replace")
        raise RuntimeError(f"ffmpeg failed: {tail or proc.returncode}")


def _run_ffmpeg_rubberband(
    src: Path,
    dst: Path,
    pitch_semitones: float,
    tempo_ratio: float,
) -> None:
    pitch_factor = 2.0 ** (pitch_semitones / 12.0)
    _run_ffmpeg_filter(src, dst, f"rubberband=pitch={pitch_factor:.8f}:tempo={tempo_ratio:.8f}")


def _run_ffmpeg_atempo(src: Path, dst: Path, tempo_ratio: float) -> None:
    chain = _atempo_chain(tempo_ratio)
    if not chain:
        shutil.copy2(src, dst)
        return
    _run_ffmpeg_filter(src, dst, chain)


def shift_wav(
    src: Path,
    dst: Path,
    pitch_semitones: float = 0.0,
    tempo_ratio: float = 1.0,
    preserve_pitch: bool = True,
) -> None:
    """Pitch-shift and/or time-stretch a WAV via Rubber Band (CLI preferred)."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    if is_identity(pitch_semitones, tempo_ratio):
        shutil.copy2(src, dst)
        return

    # Tape mode: tempo changes pitch together (no pitch preservation).
    if not preserve_pitch and is_identity(pitch_semitones, 0.0):
        _run_ffmpeg_atempo(src, dst, tempo_ratio)
        return

    if rubberband_executable():
        _run_rubberband_cli(src, dst, pitch_semitones, tempo_ratio)
        return
    if ffmpeg_has_rubberband():
        _run_ffmpeg_rubberband(src, dst, pitch_semitones, tempo_ratio)
        return
    raise RuntimeError(
        "pitch/tempo processing requires rubberband CLI or ffmpeg with librubberband"
    )


def ensure_shifted(
    src: Path,
    jobs_dir: Path,
    job_id: str,
    stem_name: str,
    pitch_semitones: float,
    tempo_ratio: float,
    preserve_pitch: bool,
) -> Path:
    """Return a cached pitch/tempo-shifted WAV, processing on first request."""
    if is_identity(pitch_semitones, tempo_ratio):
        return src

    dst = shifted_path(jobs_dir, job_id, pitch_semitones, tempo_ratio, preserve_pitch, stem_name)
    if dst.is_file() and dst.stat().st_size > 44:
        return dst

    lock = _get_lock(str(dst))
    with lock:
        if dst.is_file() and dst.stat().st_size > 44:
            return dst
        tmp = dst.with_suffix(".part.wav")
        try:
            shift_wav(src, tmp, pitch_semitones, tempo_ratio, preserve_pitch)
            tmp.replace(dst)
        finally:
            tmp.unlink(missing_ok=True)
    return dst


def _get_lock(key: str) -> threading.Lock:
    with _locks_guard:
        if key not in _cache_locks:
            _cache_locks[key] = threading.Lock()
        return _cache_locks[key]

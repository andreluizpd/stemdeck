from __future__ import annotations

import struct

import pytest

from app.pipeline import pitch_tempo as pt


def _tiny_wav(seconds: float = 0.25, sr: int = 8000) -> bytes:
    nframes = int(sr * seconds)
    data = b"\x00\x00" * nframes
    hdr = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE"
    hdr += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, sr, sr * 2, 2, 16)
    hdr += b"data" + struct.pack("<I", len(data))
    return hdr + data


def test_rubberband_prefers_bundled_binary(tmp_path, monkeypatch):
    bundled = tmp_path / "ffmpeg" / "rubberband"
    bundled.parent.mkdir(parents=True)
    bundled.write_text("#!/bin/sh\n", encoding="utf-8")
    bundled.chmod(0o755)
    monkeypatch.setenv("STEMDECK_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("STEMDECK_RUBBERBAND", "")
    from importlib import reload

    import app.core.config as config

    reload(config)
    import app.pipeline.pitch_tempo as pt

    reload(pt)
    assert pt.rubberband_executable() == str(bundled)


def test_cache_key_stable():
    a = pt.cache_key(2.0, 1.1, True)
    b = pt.cache_key(2.0, 1.1, True)
    c = pt.cache_key(2.0, 1.1, False)
    assert a == b
    assert a != c


def test_identity_skips_processing(tmp_path):
    src = tmp_path / "in.wav"
    src.write_bytes(_tiny_wav())
    dst = tmp_path / "out.wav"
    pt.shift_wav(src, dst, pitch_semitones=0, tempo_ratio=1.0)
    assert dst.read_bytes() == src.read_bytes()


def test_shift_writes_output(tmp_path):
    if not pt.pitch_tempo_available():
        pytest.skip("rubberband not available")

    src = tmp_path / "in.wav"
    src.write_bytes(_tiny_wav(seconds=0.5))
    dst = tmp_path / "out.wav"
    pt.shift_wav(src, dst, pitch_semitones=2, tempo_ratio=1.1, preserve_pitch=True)
    assert dst.is_file()
    assert dst.stat().st_size > 44


def test_ensure_shifted_caches(tmp_path, monkeypatch):
    if not pt.pitch_tempo_available():
        pytest.skip("rubberband not available")

    monkeypatch.setattr(pt, "JOBS_DIR", tmp_path, raising=False)
    job_id = "abcdefabcdef"
    stems_dir = tmp_path / job_id / "stems"
    stems_dir.mkdir(parents=True)
    src = stems_dir / "vocals.wav"
    src.write_bytes(_tiny_wav(seconds=0.5))

    out1 = pt.ensure_shifted(src, tmp_path, job_id, "vocals", 1.0, 1.05, True)
    out2 = pt.ensure_shifted(src, tmp_path, job_id, "vocals", 1.0, 1.05, True)
    assert out1 == out2
    assert out1.is_file()
    assert out1.parent.name == pt.cache_key(1.0, 1.05, True)

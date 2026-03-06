#!/usr/bin/env python3
import argparse
import os
from pathlib import Path

from faster_whisper import WhisperModel


def bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def format_ts(seconds: float) -> str:
    total_ms = max(0, int(round(seconds * 1000)))
    ms = total_ms % 1000
    total_s = total_ms // 1000
    s = total_s % 60
    total_m = total_s // 60
    m = total_m % 60
    h = total_m // 60
    return f"{h:02}:{m:02}:{s:02}.{ms:03}"


def write_vtt(path: Path, segments) -> None:
    lines = ["WEBVTT", ""]
    for segment in segments:
        start = format_ts(float(segment.start))
        end = format_ts(float(segment.end))
        text = (segment.text or "").strip()
        if not text:
            continue
        lines.append(f"{start} --> {end}")
        lines.append(text)
        lines.append("")
    if len(lines) == 2:
        lines.extend(["00:00:00.000 --> 00:00:01.000", ""])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--lang", default="")
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)
    if not input_path.exists():
        raise FileNotFoundError(f"input not found: {input_path}")

    model_name = os.getenv("SUBTITLE_LOCAL_MODEL", "small")
    model_dir = os.getenv("SUBTITLE_LOCAL_MODEL_DIR", "/home/container/data/asr_models")
    Path(model_dir).mkdir(parents=True, exist_ok=True)
    device = os.getenv("SUBTITLE_LOCAL_DEVICE", "cpu")
    compute_type = os.getenv("SUBTITLE_LOCAL_COMPUTE_TYPE", "int8")
    beam_size = int(os.getenv("SUBTITLE_LOCAL_BEAM_SIZE", "3"))
    vad_filter = bool_env("SUBTITLE_LOCAL_VAD_FILTER", True)

    model = WhisperModel(
        model_name,
        device=device,
        compute_type=compute_type,
        download_root=model_dir
    )
    lang = (args.lang or "").strip() or None
    segments, _info = model.transcribe(
        str(input_path),
        language=lang,
        beam_size=beam_size,
        vad_filter=vad_filter
    )
    write_vtt(output_path, segments)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

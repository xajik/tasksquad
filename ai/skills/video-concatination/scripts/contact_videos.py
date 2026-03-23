#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Concatenate existing video clips using ffmpeg.

Usage:
  uv run concat_videos.py \
    -i clip1.mp4 clip2.mp4 clip3.mp4 \
    -o final_output.mp4
"""

import argparse
import shlex
import subprocess
import sys
from pathlib import Path

def require_bin(name: str) -> None:
    if subprocess.run(["bash", "-lc", f"command -v {shlex.quote(name)}"], capture_output=True).returncode != 0:
        raise RuntimeError(f"Required binary not found on PATH: {name}")

def ffmpeg_concat(inputs: list[Path], out_path: Path) -> None:
    require_bin("ffmpeg")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Create concat list file.
    lst = out_path.with_suffix(out_path.suffix + ".concat.txt")
    lines = [f"file '{p.absolute().as_posix()}'" for p in inputs]
    lst.write_text("\n".join(lines) + "\n", encoding="utf-8")

    cmd = [
        "ffmpeg",
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", str(lst),
        "-c", "copy",
        str(out_path),
    ]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        # Fallback: re-encode (more compatible, slower)
        print("ffmpeg stream copy concat failed; falling back to re-encode…", file=sys.stderr)
        cmd2 = [
            "ffmpeg",
            "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", str(lst),
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "18",
            "-c:a", "aac",
            "-b:a", "192k",
            str(out_path),
        ]
        p2 = subprocess.run(cmd2, capture_output=True, text=True)
        if p2.returncode != 0:
            raise RuntimeError(
                "ffmpeg concat failed.\n"
                f"copy stderr:\n{p.stderr[-2000:]}\n\n"
                f"reencode stderr:\n{p2.stderr[-2000:]}"
            )
            
    # Clean up the temporary text file used for concatenation
    lst.unlink(missing_ok=True)

def main() -> None:
    parser = argparse.ArgumentParser(description="Concatenate video clips using ffmpeg")
    parser.add_argument(
        "--inputs", "-i",
        nargs="+",
        required=True,
        type=Path,
        help="List of input video files to concatenate (in order)",
    )
    parser.add_argument(
        "--output", "-o",
        required=True,
        type=Path,
        help="Output .mp4 path",
    )

    args = parser.parse_args()

    # Validate inputs exist
    for p in args.inputs:
        if not p.exists():
            print(f"Error: Input file does not exist: {p}", file=sys.stderr)
            sys.exit(1)

    try:
        ffmpeg_concat(args.inputs, args.output)
        full_out = args.output.resolve()
        print(f"Successfully concatenated {len(args.inputs)} files into: {full_out}")
        print(f"MEDIA: {full_out}")
    except Exception as e:
        print(f"Error concatenating segments: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "httpx>=0.27.0",
# ]
# ///
"""Generate videos using Seedance 2.0 (SuTui AI) via the xskill.ai HTTP API.

Supports multi-segment generation + automatic concatenation, with per-segment
prompting, media references (images/videos/audio), and optional continuity via
the previous segment's last frame.

Usage:
  uv run generate_video.py \
    --prompt "..." \
    --filename "out.mp4" \
    [--aspect-ratio 16:9|9:16|1:1] \
    [--duration 5] \
    [--segments 1] \
    [--media-file URL ...] \
    [--speed-mode Standard] \
    [--poll-seconds 10] \
    [--timeout-seconds 600] \
    [--api-key KEY]

Notes:
- Requires SEEDANCE_API_KEY if --api-key not provided.
- Seedance 2.0 generates 4-15s clips per request; use --segments to build longer videos.
- If --segments > 1, requires ffmpeg on PATH to concatenate the clips.
- Media files must be publicly accessible URLs. Use @image1, @video1, @audio1
  markers in the prompt to reference them.
- Prints a MEDIA: line for Claude Code to auto-attach on supported providers.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path


BASE_URL = "https://api.xskill.ai"

# Available models
MODEL_SUPER_SEED2 = "st-ai/super-seed2"                                          # original (waitlist)
MODEL_V15_T2V = "fal-ai/bytedance/seedance/v1.5/pro/text-to-video"              # text → video
MODEL_V15_I2V = "fal-ai/bytedance/seedance/v1.5/pro/image-to-video"             # image + text → video

MODEL = MODEL_V15_T2V  # default

# Models that use the v1.5 API contract (image_url, duration as string, no aspect_ratio/speed_mode)
V15_MODELS = {MODEL_V15_T2V, MODEL_V15_I2V}


def get_api_key(provided_key: str | None) -> str | None:
    if provided_key:
        return provided_key
    return os.environ.get("SEEDANCE_API_KEY") or os.environ.get("XSKILLS_AI_API_KEY")


def require_bin(name: str) -> None:
    if subprocess.run(["bash", "-lc", f"command -v {shlex.quote(name)}"], capture_output=True).returncode != 0:
        raise RuntimeError(f"Required binary not found on PATH: {name}")


def extract_last_frame_png(video_path: Path, out_png: Path) -> Path:
    """Extract the last frame of a video to a PNG using ffmpeg."""
    require_bin("ffmpeg")
    out_png.parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        "ffmpeg",
        "-y",
        "-sseof",
        "-0.05",
        "-i",
        str(video_path),
        "-frames:v",
        "1",
        "-q:v",
        "2",
        str(out_png),
    ]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg last-frame extract failed: {p.stderr[-2000:]}")
    return out_png


def upload_to_tmpfiles(file_path: Path) -> str:
    """Upload a local file to tmpfiles.org and return a direct download URL."""
    cmd = [
        "curl",
        "-s",
        "-F",
        f"file=@{file_path}",
        "https://tmpfiles.org/api/v1/upload",
    ]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"tmpfiles.org upload failed: {p.stderr[-1000:]}")

    try:
        resp = json.loads(p.stdout)
        url = resp["data"]["url"]
    except (json.JSONDecodeError, KeyError) as e:
        raise RuntimeError(f"tmpfiles.org unexpected response: {p.stdout[:500]}") from e

    # Convert to direct download URL: tmpfiles.org/123/file.png -> tmpfiles.org/dl/123/file.png
    direct_url = url.replace("tmpfiles.org/", "tmpfiles.org/dl/", 1)
    return direct_url


def _post_create(api_key: str, body: dict) -> str:
    """Send a task creation request and return the task_id."""
    import httpx

    resp = httpx.post(
        f"{BASE_URL}/api/v3/tasks/create",
        json=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        timeout=60,
    )

    if resp.status_code != 200:
        raise RuntimeError(
            f"Task creation failed (HTTP {resp.status_code}): {resp.text[:1000]}"
        )

    data = resp.json()
    task_id = data.get("data", {}).get("task_id")
    if not task_id:
        raise RuntimeError(f"No task_id in response: {json.dumps(data)[:500]}")

    return task_id


def create_task(api_key: str, prompt: str, media_files: list[str],
                aspect_ratio: str, duration: int, speed_mode: str,
                model: str = MODEL) -> str:
    """Create a video generation task and return the task_id.

    Routes to the correct API contract based on model family:
    - st-ai/super-seed2: original contract (media_files array, int duration, aspect_ratio, speed_mode)
    - fal-ai/bytedance/seedance/v1.5/pro/*: v1.5 contract (image_url, str duration, no aspect_ratio)
    """
    if model in V15_MODELS:
        return _create_task_v15(api_key, prompt, media_files, duration, model)
    else:
        return _create_task_super_seed2(api_key, prompt, media_files, aspect_ratio, duration, speed_mode, model)


def _create_task_super_seed2(api_key: str, prompt: str, media_files: list[str],
                              aspect_ratio: str, duration: int, speed_mode: str,
                              model: str) -> str:
    """Original super-seed2 API contract."""
    params: dict = {
        "prompt": prompt,
        "aspect_ratio": aspect_ratio,
        "duration": duration,
    }
    if media_files:
        params["media_files"] = media_files
    if speed_mode:
        params["speed_mode"] = speed_mode

    return _post_create(api_key, {"model": model, "params": params, "channel": None})


def _create_task_v15(api_key: str, prompt: str, media_files: list[str],
                     duration: int, model: str) -> str:
    """Seedance v1.5 API contract.

    - duration is sent as a string
    - image-to-video model uses image_url (first media_files entry)
    - text-to-video model ignores media_files
    """
    params: dict = {
        "prompt": prompt,
        "duration": str(duration),
    }

    if model == MODEL_V15_I2V and media_files:
        params["image_url"] = media_files[0]

    return _post_create(api_key, {"model": model, "params": params, "channel": None})


def poll_until_done(api_key: str, task_id: str,
                    poll_seconds: int, timeout_seconds: int) -> dict:
    """Poll the task status until completed or timeout. Returns the task data."""
    import httpx

    started = time.time()

    while True:
        elapsed = int(time.time() - started)
        if elapsed > timeout_seconds:
            raise TimeoutError(
                f"Timed out after {timeout_seconds}s waiting for task {task_id}"
            )

        resp = httpx.post(
            f"{BASE_URL}/api/v3/tasks/query",
            json={"task_id": task_id},
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            timeout=30,
        )

        if resp.status_code != 200:
            print(f"Warning: poll returned HTTP {resp.status_code}, retrying...",
                  file=sys.stderr)
            time.sleep(poll_seconds)
            continue

        data = resp.json().get("data", {})
        status = data.get("status", "")

        if status == "completed":
            return data
        elif status in ("failed", "error"):
            error_msg = data.get("error", data.get("message", "Unknown error"))
            raise RuntimeError(f"Task {task_id} failed: {error_msg}")

        print(f"Waiting for video generation to complete (status={status}, elapsed={elapsed}s)...")
        time.sleep(poll_seconds)


def extract_output_url(task_data: dict) -> str:
    """Extract the video output URL from completed task data.

    Handles multiple API response shapes:
    - v1.5:      task_data.output.video.url
    - super-seed2: task_data.result.output.images[0]
    - fallbacks for other shapes
    """
    # v1.5 shape: output.video.url
    top_output = task_data.get("output", {})
    if isinstance(top_output, dict):
        video = top_output.get("video", {})
        if isinstance(video, dict) and video.get("url"):
            return video["url"]
        # some variants put url directly
        for key in ("video_url", "url"):
            if top_output.get(key):
                return top_output[key]

    # super-seed2 shape: result.output.images[0]
    result = task_data.get("result", {})
    output = result.get("output", {})
    images = output.get("images", [])
    if images:
        url = images[0]
        if isinstance(url, dict):
            url = url.get("url", "")
        if url:
            return url

    # remaining fallbacks
    for key in ("video_url", "url"):
        u = result.get(key) or output.get(key)
        if u:
            return u

    raise RuntimeError(
        f"Could not extract output URL from task data: {json.dumps(task_data)[:500]}"
    )


def download_video(url: str, out_path: Path) -> None:
    """Download a video from URL to a local file."""
    import httpx

    out_path.parent.mkdir(parents=True, exist_ok=True)

    with httpx.stream("GET", url, follow_redirects=True, timeout=120) as resp:
        resp.raise_for_status()
        with open(out_path, "wb") as f:
            for chunk in resp.iter_bytes(chunk_size=65536):
                f.write(chunk)


def ffmpeg_concat(inputs: list[Path], out_path: Path) -> None:
    require_bin("ffmpeg")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    lst = out_path.with_suffix(out_path.suffix + ".concat.txt")
    lines = [f"file '{p.as_posix()}'" for p in inputs]
    lst.write_text("\n".join(lines) + "\n", encoding="utf-8")

    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(lst),
        "-c",
        "copy",
        str(out_path),
    ]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        # Fallback: re-encode
        print("ffmpeg stream copy concat failed; falling back to re-encode...",
              file=sys.stderr)
        cmd2 = [
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(lst),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            str(out_path),
        ]
        p2 = subprocess.run(cmd2, capture_output=True, text=True)
        if p2.returncode != 0:
            raise RuntimeError(
                "ffmpeg concat failed.\n"
                f"copy stderr:\n{p.stderr[-2000:]}\n\n"
                f"reencode stderr:\n{p2.stderr[-2000:]}"
            )

    # Clean up concat list file
    try:
        lst.unlink(missing_ok=True)
    except Exception:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate videos via Seedance 2.0 (xskill.ai API)"
    )
    parser.add_argument(
        "--prompt", "-p", required=False,
        help="Text prompt (used for all segments unless --segment-prompt is provided)",
    )
    parser.add_argument(
        "--segment-prompt",
        action="append",
        default=[],
        help="Per-segment prompt. Repeat for each segment. Overrides --prompt.",
    )
    parser.add_argument(
        "--filename", "-f", required=True,
        help="Output .mp4 path",
    )
    parser.add_argument(
        "--aspect-ratio",
        default="9:16",
        choices=["16:9", "9:16", "1:1"],
        help="Aspect ratio (default: 9:16)",
    )
    parser.add_argument(
        "--duration",
        type=int,
        default=5,
        help="Clip duration in seconds, 4-15 (default: 5)",
    )
    parser.add_argument(
        "--segments",
        type=int,
        default=1,
        help="Number of segments to generate and concatenate",
    )
    parser.add_argument(
        "--media-file",
        action="append",
        default=[],
        help="Publicly accessible URL for a media reference (image/video/audio). "
             "Repeatable. Use @image1, @video1, @audio1 markers in prompt.",
    )
    parser.add_argument(
        "--speed-mode",
        default="Standard",
        choices=["Fast", "Standard"],
        help="Generation speed mode (default: Standard)",
    )
    parser.add_argument(
        "--base-style",
        default=None,
        help="Style/system prompt prepended to every segment prompt (recommended for consistency).",
    )
    parser.add_argument(
        "--segment-style",
        choices=["same", "continuation"],
        default="continuation",
        help="How to prompt segments: same prompt each time, or continuation prompts.",
    )
    parser.add_argument(
        "--use-last-frame",
        action="store_true",
        help="For segment >=2, extract previous segment's last frame, upload to "
             "tmpfiles.org, and pass as @image1 reference for visual continuity.",
    )
    parser.add_argument(
        "--emit-segment-media",
        action="store_true",
        help="Print MEDIA: lines for each segment as they finish.",
    )
    parser.add_argument(
        "--poll-seconds",
        type=int,
        default=10,
        help="Polling interval seconds (default: 10)",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=600,
        help="Max time to wait for each segment generation (default: 600)",
    )
    parser.add_argument(
        "--model", "-m",
        default=MODEL,
        choices=[MODEL_SUPER_SEED2, MODEL_V15_T2V, MODEL_V15_I2V],
        help=(
            "Model to use. Default: fal-ai/bytedance/seedance/v1.5/pro/text-to-video.\n"
            "  text-to-video: prompt only\n"
            "  image-to-video: prompt + --media-file <image_url> (first URL used as image_url)\n"
            "  super-seed2: original model (requires waitlist)"
        ),
    )
    parser.add_argument(
        "--api-key", "-k",
        help="API key (overrides SEEDANCE_API_KEY / XSKILLS_AI_API_KEY env vars)",
    )
    parser.add_argument(
        "--keep-segments",
        action="store_true",
        help="Keep intermediate segment mp4 files",
    )

    args = parser.parse_args()

    api_key = get_api_key(args.api_key)
    if not api_key:
        print("Error: No API key provided.", file=sys.stderr)
        print("Set SEEDANCE_API_KEY or pass --api-key", file=sys.stderr)
        sys.exit(1)

    if args.segments < 1:
        print("Error: --segments must be >= 1", file=sys.stderr)
        sys.exit(1)

    if args.duration < 4 or args.duration > 15:
        print("Error: --duration must be between 4 and 15 seconds", file=sys.stderr)
        sys.exit(1)

    if args.segments > 1:
        require_bin("ffmpeg")

    # Determine per-segment prompts
    seg_prompts: list[str] = []
    if args.segment_prompt:
        seg_prompts = [p for p in args.segment_prompt if p and p.strip()]
        if not seg_prompts:
            print("Error: --segment-prompt provided but empty", file=sys.stderr)
            sys.exit(1)
        if args.segments != 1 and args.segments != len(seg_prompts):
            print(
                f"Error: --segments ({args.segments}) does not match number of "
                f"--segment-prompt ({len(seg_prompts)})",
                file=sys.stderr,
            )
            sys.exit(1)
        args.segments = len(seg_prompts)
    else:
        if not args.prompt or not args.prompt.strip():
            print("Error: provide --prompt or one/more --segment-prompt", file=sys.stderr)
            sys.exit(1)
        seg_prompts = [args.prompt]

    out = Path(args.filename)
    out.parent.mkdir(parents=True, exist_ok=True)

    base_media_files: list[str] = list(args.media_file)

    seg_paths: list[Path] = []
    base = out.with_suffix("")

    for i in range(1, args.segments + 1):
        # Build segment prompt
        raw_seg_prompt = seg_prompts[min(i - 1, len(seg_prompts) - 1)]
        if not args.segment_prompt and args.segments > 1 and args.segment_style != "same":
            raw_seg_prompt = raw_seg_prompt + (
                f"\n\nThis is segment {i} of {args.segments}. Continue seamlessly "
                "from the previous segment with consistent characters, lighting, "
                "camera style, and setting."
            )

        if args.base_style:
            seg_prompt = args.base_style.strip() + "\n\n" + raw_seg_prompt.strip()
        else:
            seg_prompt = raw_seg_prompt.strip()

        seg_out = base.parent / f"{base.name}.seg{i:02d}.mp4"

        # Build per-segment media files
        seg_media_files = list(base_media_files)

        # If --use-last-frame and segment >= 2, extract last frame and add as reference
        if args.use_last_frame and i >= 2:
            try:
                last_png = base.parent / f"{base.name}.seg{i-1:02d}.last.png"
                extract_last_frame_png(seg_paths[-1], last_png)
                print(f"Uploading last frame of segment {i-1} to tmpfiles.org...")
                frame_url = upload_to_tmpfiles(last_png)
                print(f"Last frame uploaded: {frame_url}")

                # Insert as first media file so it becomes @image1
                seg_media_files.insert(0, frame_url)

                # Prepend @image1 reference to prompt if not already present
                if "@image1" not in seg_prompt:
                    seg_prompt = (
                        "Continue from the reference image @image1 seamlessly. "
                        + seg_prompt
                    )

                # Clean up local PNG
                try:
                    last_png.unlink(missing_ok=True)
                except Exception:
                    pass
            except Exception as e:
                print(
                    f"Warning: failed to attach last frame for segment {i}: {e}",
                    file=sys.stderr,
                )

        print(f"Starting video generation segment {i}/{args.segments} "
              f"(model={MODEL}, duration={args.duration}s)...")

        try:
            task_id = create_task(
                api_key=api_key,
                prompt=seg_prompt,
                media_files=seg_media_files,
                aspect_ratio=args.aspect_ratio,
                duration=args.duration,
                speed_mode=args.speed_mode,
                model=args.model,
            )
            print(f"Task created: {task_id}")
        except Exception as e:
            print(f"Error creating task for segment {i}: {e}", file=sys.stderr)
            sys.exit(2)

        try:
            task_data = poll_until_done(
                api_key, task_id, args.poll_seconds, args.timeout_seconds
            )
        except Exception as e:
            print(f"Error while waiting for segment {i}: {e}", file=sys.stderr)
            sys.exit(2)

        try:
            video_url = extract_output_url(task_data)
            print(f"Downloading segment {i}...")
            download_video(video_url, seg_out)
        except Exception as e:
            print(f"Error downloading segment {i}: {e}", file=sys.stderr)
            sys.exit(3)

        seg_full = seg_out.resolve()
        print(f"Saved segment {i}: {seg_full}")
        if args.emit_segment_media:
            print(f"MEDIA: {seg_full}")
        seg_paths.append(seg_out)

    if args.segments == 1:
        seg_paths[0].replace(out)
        full = out.resolve()
        print(f"Generated video saved: {full}")
        print(f"MEDIA: {full}")
        return

    # Concatenate segments
    try:
        ffmpeg_concat(seg_paths, out)
    except Exception as e:
        print(f"Error concatenating segments: {e}", file=sys.stderr)
        sys.exit(4)

    full = out.resolve()
    print(f"Generated stitched video saved: {full}")
    print(f"MEDIA: {full}")

    if not args.keep_segments:
        for p in seg_paths:
            try:
                p.unlink(missing_ok=True)
            except Exception:
                pass


if __name__ == "__main__":
    main()

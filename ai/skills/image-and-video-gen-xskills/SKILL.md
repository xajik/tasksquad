---
name: seedance-video-gen
description: Generate and stitch short videos via Seedance 2.0 (SuTui AI) using the xskill.ai HTTP API. Use when you need to create video clips from prompts with optional media references (images, videos, audio for lip-sync), multi-segment stitching, and up to 2K resolution. Supports phoneme-level lip-sync, multi-shot coherent narrative, and mixed multimodal input.
---

# Seedance 2.0 Video Generation (xskill.ai API)

Use the bundled script to generate an MP4 from a text prompt, optionally referencing images, videos, or audio files.

## Generate (text → video)

```bash
uv run {baseDir}/scripts/generate_video.py \
  --prompt "A close up of a woman applying lipstick, soft lighting" \
  --filename "out.mp4" \
  --aspect-ratio "9:16" \
  --duration 5
```

## Generate with media references

Reference images/videos/audio in the prompt using `@image1`, `@video1`, `@audio1` markers. Pass the corresponding files via `--media-file`.

```bash
uv run {baseDir}/scripts/generate_video.py \
  --prompt "A woman who looks like @image1 smiling at camera" \
  --media-file "https://example.com/face.jpg" \
  --filename "out.mp4" \
  --aspect-ratio "9:16" \
  --duration 5
```

## Generate a longer video by stitching segments

Seedance generates 4-15s clips per request. Use `--segments` to generate multiple clips and concatenate them with ffmpeg.

**Important:** This skill sends **one prompt per segment** (one API request per segment). Use `--base-style` to keep style consistent across segments.

```bash
uv run {baseDir}/scripts/generate_video.py \
  --prompt "Same scene, consistent style..." \
  --filename "out-20s.mp4" \
  --aspect-ratio "9:16" \
  --duration 10 \
  --segments 2 \
  --segment-style continuation \
  --use-last-frame
```

Options:
- `--base-style "..."`: prepended to every segment prompt (recommended).
- `--segment-prompt "..."` (repeatable): provide one prompt per segment (overrides `--prompt`).
- `--segment-style continuation` (default): appends continuity instructions per segment (only when using `--prompt`).
- `--segment-style same`: uses the exact same prompt for each segment (only when using `--prompt`).
- `--use-last-frame`: for segment >=2, extract previous segment's last frame, upload to tmpfiles.org, and pass as `@image1` reference for visual continuity.
- `--emit-segment-media`: print `MEDIA:` for each segment as it finishes (useful for progress).
- `--keep-segments`: keep intermediate `*.segXX.mp4` files.
- `--media-file URL` (repeatable): reference images/videos/audio by URL. Use `@image1`, `@video1`, `@audio1` markers in prompt.
- `--duration N`: clip duration in seconds (4-15, default 5).
- `--speed-mode Fast|Standard`: generation speed (default Standard).

## Requirements

- `XSKILLS_AI_API_KEY_TASK_SQUAD` .env in project/.env file
- `ffmpeg` on PATH when using `--segments > 1` or `--use-last-frame`.

## Troubleshooting

- 401/Unauthorized: Check API key.
- Timeout: increase `--timeout-seconds` (default 600). Seedance can take several minutes per clip.
- Media references: files must be publicly accessible URLs. For local files, upload to tmpfiles.org first.

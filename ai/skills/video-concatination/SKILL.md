---
name: video-concat
description: Stitch and concatenate multiple existing video clips into a single MP4 file using ffmpeg. Use this when you already have the video segments generated and just need to combine them seamlessly.
---

# Video Concatenation

Use the bundled script to concatenate already-generated video clips into a single file. 

## Concatenate Videos

Pass your input files in the exact order you want them stitched together using the `-i` flag, followed by your desired output filename with `-o`.

```bash
uv run {baseDir}/scripts/concat_videos.py \
  -i clip1.mp4 clip2.mp4 clip3.mp4 \
  -o final_stitched_video.mp4
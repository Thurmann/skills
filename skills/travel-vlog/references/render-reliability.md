# Proxy, render, recovery, and final QA

Read this reference before any long render or when resuming a render incident. Use the current project's tested commands, CLI version, and platform; examples from older weeks are evidence, not a mandate to use a stale renderer.

## Before rendering

- Inventory selected footage for HEVC/4K, unusual frame rates, sparse or long GOPs, seek failures, and decode errors. Create H.264 proxies ahead of time for vulnerable selected sources.
- In macOS/OrbStack workflows, choose `libx264` explicitly rather than trusting automatic VideoToolbox selection. A proxy should use a short GOP (GOP 30 at 29.97/30 fps), `+faststart`, and AAC 48 kHz stereo when source audio exists.
- Proxy coverage must include the complete source or at least `media-start + selected duration + 1 second`. Verify duration, audio stream, and full video/audio decode before wiring it into the project. Maintain a manifest mapping original to proxy, encoder, duration, and covered source interval. Never modify originals.
- Before a long job, check Docker/OrbStack daemon, renderer image/tag, architecture compatibility, pinned CLI versus actual renderer, and free disk for proxies, all segments, temporary concat/re-encode, and final MP4. Record the preflight.
- Make one short representative render using the same engine and flags planned for production. Probe its streams and full-decode it. If a renderer fails to start, do not repeat the unchanged failing setup; change and document an actual precondition.

## Render strategy

- Start with preview/check. Split work by day or narrative pause; keep no more than 16 video sources in one render subcomposition when that is the current project convention. Use an explicit chronological `render-order.txt`; never assemble by alphabetical globbing.
- Render sequentially with one worker, low-memory mode, strict errors, and no best-effort. For long days, use approximately 3,000-frame capture chunks (~100 seconds at 30000/1001) when supported; otherwise use numbered, frame-contiguous parts and an explicit concat manifest.
- Write a distinct log per day/part and retain completed segments for resumability. Update checkpoint/status after each milestone. Check disk before rendering and again before concat.
- Set and document a stall period before starting. `stage still running` is not a failure when `framesCompleted` continues to rise. A slow HEVC `video_extract` phase can precede capture; distinguish that from an actual hang. Stop only after the relevant progress counter has not advanced for the full stall period.
- On failure, inspect the final log lines, daemon/process, disk, and partial output. Identify whether the output is incomplete before removing/replacing it. Retry only the failed or missing part; preserve every validated part. Do not hide failures with best-effort.

## Segment and final checks

- Validate every segment's expected frames/duration, order, video/audio streams, and full decode before concatenation.
- Concatenate strictly from the manifest. After stream-copy concat, inspect packet PTS/DTS monotonicity for both streams and full-decode the whole MP4. If AAC has boundary timestamp jumps, retain the video stream-copy and re-encode only AAC, then repeat the full decode and timestamp checks.
- Probe final duration, resolution, codecs, sample rate, and channels. Check audio decoding and scan for long digital silence; save the scan/log and report its threshold/duration. Listen to representative audio when the brief or result warrants it.
- Extract and inspect actual final-file frames for the opening, each daily card at 0/+11/+12/+13s, important transitions, and ending. Confirm full-frame containment/no zoom. Review the actual rendered MP4; a preview cannot substitute for final-file QA.
- Keep successful intermediates through final review. After approval, remove only documented regenerable render outputs that are no longer needed; preserve originals, approved project/EDL, proxies needed for editability, and final deliverables.

## Example flags from a verified project

One Japan render used HyperFrames 0.8.111 in a cached Linux arm64 Docker image with `--docker --workers=1 --low-memory-mode --no-best-effort --quality=delivery --fps=30000/1001 --strict --resume --keep-segments`. Revalidate versions and flags in each new environment rather than copying this pin blindly.

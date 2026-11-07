# Japan 2026, uke 5–6: confirmed facts

Read this only when resuming `/Users/thurmann/Documents/Japan 2026/uke 5-6` or its `videos/japan-uke-5-6` project. Do not transfer this route to another vlog. For active work, the workspace `AGENTS.md`, filled prompt, checkpoint, and latest user correction remain authoritative.

## Confirmed date/location mapping

- Trip range: 21 April–2 May 2026; recorded days are 22 April–2 May. 21 April was a travel day with no video.
- 22–24 April: Tokyo. 22 April: Shinjuku Gyoen National Garden. 23 April: Ashikaga Flower Park day trip. 24 April: travel to Hiroshima, but the only footage that date is of the apartment in Tokyo.
- 24–26 April: Hiroshima. 25 April: Peace Museum and Shukkeien Garden. 26 April: travel to Miyajima; footage that date is only of the Miyajima hotel room.
- 26–27 April: Miyajima (Itsukushima). Torii Gate and Itsukushima Shrine footage belongs on **27 April** with location Miyajima. The user corrected an accidental “27 May” to “27 April.”
- 27 April–2 May: Kyoto. 28 April: Nijō Castle. 29 April: Kyoto Imperial Palace in Kyoto Gyoen National Garden. 30 April: teamLab Biovortex Kyoto. 1 May: Saihōji (Kokedera) Temple and nearby smaller temples. 2 May: Arashiyama area.

## Confirmed production choices and lessons

- The approved storyboard/EDL is 55:18, 72 unique sources, 11 recorded dates. The final render was 55:17.657, H.264 1920×1080 plus AAC stereo 48 kHz. Use these as historical facts only; re-inventory for a new trip.
- User explicitly required no zoom. All travel videos use full-frame containment; no crop, pan, punch-in, or reframe.
- The final day, 2 May, twice stalled during a long capture around 12,000/15,656 frames. A short seek test from the same source area passed, showing the issue was the long capture context. The day succeeded when split into six numbered, frame-contiguous parts of at most 3,000 frames, verified individually, then concatenated.
- A shell render command initially consumed its CSV manifest through inherited stdin and skipped rows. Robust scripts must keep manifest input on a separate file descriptor and ensure child render processes cannot consume it. Generate concat entries relative to the list file or use absolute paths, and refuse to concatenate until every expected part has a verification marker.
- Concat with AAC stream-copy logged non-monotonic DTS adjustments at some part boundaries. The final kept video stream-copy and re-encoded only AAC; full decode and packet audit then showed monotone PTS/DTS and no packet gap over 20 ms.
- A host-side HyperFrames `check` could not launch its browser and reported many static warnings, while Docker render jobs succeeded. Distinguish host runtime availability from renderer-container results; investigate warnings and document both rather than treating a failed host browser probe as proof the rendered MP4 is bad.

## Workspace authority

For this project, the root `HYPERFRAMES_TRAVEL_VLOG_PROMPT.md` is the production brief, `AGENTS.md` contains model and workflow rules, and `production-state/CHECKPOINT.md` is the resume point. The blank files under `production-state/templates/japan-week-film/` are starting materials, not an approved storyboard. The project `videos/japan-uke-5-6/AGENTS.md` also contains HyperFrames-specific authoring rules; read it before touching compositions.

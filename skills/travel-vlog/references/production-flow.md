# Production flow

Use the production folder as the source of truth. When resuming, read the workspace `AGENTS.md`, the filled travel-vlog prompt/brief, and `production-state/CHECKPOINT.md` first. Review the approved storyboard/EDL, day plan, clip decisions, and render status before continuing. A template is only a blank starting point; do not copy another week's itinerary, runtime, or clip list as fact.

## Stages and gates

1. **Discover.** Confirm source folders and any shared audio folder. Inventory every source for filename/date evidence, duration, dimensions/orientation, video and audio codecs/tracks, frame rate, metadata, keyframe interval, and decode health. Distinguish dates with footage from travel days with no footage. A filename date or visual clue alone does not establish a location.
2. **Plan.** Record user-confirmed itinerary, unresolved facts, daily story function, and source-based clip decisions. Create a frame-consistent EDL with original filename, source in/out, timeline in/out or frames, speed, audio choice, date/location caption, and rationale. Validate continuity, total duration, and that every source range fits its source. Keep an explicit record of exclusions and uncertainty.
3. **Review the storyboard.** Get the review required by workspace instructions. Keep review scope to one concrete artifact and save the report under `production-state/reviews/`. Do not author the HyperFrames project until the required storyboard/EDL approval is in hand.
4. **Build and preview.** Start with the `/hyperframes` skill. For a custom longer film, use `/general-video`; read the relevant HyperFrames core/CLI skills before composition edits or renders. Build only from the approved EDL. Check the whole preview for chronology, framing, day-card copy/timing, and audio behavior. Get the required independent preview review before long rendering or as specified by the workspace gate.
5. **Render and resume.** Follow [render-reliability.md](render-reliability.md). Update `CHECKPOINT.md`, `day-plan.md`, and `render-status.md` at milestones and after each completed segment. When a run stops, inspect its log and partial output and retry only missing/invalid parts.
6. **Final QA and handoff.** Review the actual rendered MP4, not only the preview. Perform full decode, stream/duration and timestamp checks, audio/silence analysis, visual card/transition/end checks, and any required independent final review. Save concise control data and reports. Deliver the MP4 plus the editable HyperFrames project, approved EDL, render manifest, and relevant QA/review files.

## Editorial decision principles

- Prefer useful, varied footage that advances the trip story. Do not add repetitive filler to hit a runtime target. Let the active brief set duration; the Japan weekly-film template's 38–60 minute range is a project convention, not a universal rule.
- Treat user statements as authoritative. Preserve open questions until confirmed; avoid inventing a venue from a sign, image, or filename.
- Follow stated privacy and subject preferences. Do not infer permission to publish or distribute externally.
- The main agent owns editorial decisions, project planning, the HyperFrames project, and delivery. Delegate only independent bounded scans/reviews when workspace instructions permit it; give each worker unique outputs and avoid concurrent writes to shared master files.
- If workspace instructions specify a model, review model, or delegation policy, follow those instructions. If a required reviewer is unavailable, report that and continue with technical checks.

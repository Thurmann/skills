# Editorial, sound, cards, and framing

Follow the filled prompt and latest user choices first. The points below capture the editorial rules used in the Japan weekly-film workflow; adapt only when the user or current brief directs otherwise.

## Edit and sound

- Play at normal speed by default. Do not use slow motion or speed below 70% without explicit approval.
- Consider 1.4× or faster only for unusually long or low-activity material when it helps the story; group retimed passages into coherent blocks rather than frequent isolated jumps.
- Keep source audio for clips at 70–130%. Above 130% (and below 70% only after approval), replace source audio with a suitable local track. Track the audio decision in the EDL.
- Do not lay a continuous generic travel-music bed over the film. Use music only where the approved edit needs replacement audio or a short bridge without video, and avoid long silent stretches. Use identified local audio assets rather than unverified files.
- For the Japan family-film brief, hard chronological cuts, no narration/subtitles, and source audio at unity were specified. Treat those as brief-specific choices, not defaults for every vlog.

## Cards and text

- Show a day card only at the first footage of each recorded day. In the Japan workflow, it lasts 12 seconds over the first shot, then disappears completely.
- Show only the confirmed date and place on a day card. Keep out mood phrases, subjective scene titles, and internal production labels.
- The opening can show trip start/end dates and a short confirmed route. Do not imply a no-footage travel day has footage or create a separate shot/card for it unless the user requests that design.
- Verify each card from the actual rendered file at its start and at +11, +12, and +13 seconds. This proves it appears through 11 seconds and is gone by 12 seconds.

## Preserve the full source frame

The travel-film preference established for this user is **no zoom**. Preserve the complete source image unless the user explicitly changes that instruction. For a 1920×1080 landscape canvas, size the `<video>` element to the canvas and use proportional `object-fit: contain` with centered positioning. Do not use `cover`, scale transforms, crop, pan, masks, punch-ins, or reframing. A 4K file displayed at native pixel dimensions can be cropped by the canvas; check the video element's own CSS, not just the outer stage.

Before long renders, inspect composition CSS and render a representative short test. View the resulting frame to confirm the entire original composition remains visible. After rendering, review full-frame samples from every day plus transitions, opening, and ending; a CSS inspection alone is not enough.

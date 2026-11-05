# Design patterns

A design pattern is the visual style a video follows. It is picked per video on the
**Make** page (**Design pattern**) and has a default in **Settings**. The value is
sent to the video maker as the `design_pattern` input.

| id | Name | Status |
| --- | --- | --- |
| `elements` | Elements & animation | Default, available |
| `characters` | Characters | Coming soon (shown disabled) |

## What a pattern spec has

Each pattern is one file, `design-patterns/<id>.md`, in **each** engine repo
(`gemini-youtube-automation` and `youtube-shorts-pipeline`). It describes:

- **Purpose** — what kind of video it suits and the feeling it should give.
- **Layout** — frame layout for 16:9 and 9:16, safe areas, where text sits.
- **Visual elements** — shapes, icons, illustrations or characters; what is allowed and what is not.
- **Motion** — how things enter, move and leave; pace of cuts; transitions.
- **Colour and type** — palette, font roles, text sizes, contrast rules.
- **Scene recipe** — how a script line becomes a scene (which element, which motion, how long).
- **Audio fit** — how visuals follow the narration (pace rule 150–165 WPM) and music.
- **Do / Don't** — clear examples of right and wrong.
- **Checks** — what the engine's quality check looks at before a video is accepted.

## Process for a new pattern

1. **Owner gives reference videos** — 3–5 videos (links) that show the wanted style.
2. **We analyse them** — layout, elements, motion, pacing, colour and type, scene by scene.
3. **We write `design-patterns/<id>.md`** in each engine repo, following the spec above.
4. **The AI follows it** — the engine reads the spec for the chosen `design_pattern`
   when it plans scenes and visuals.
5. **Turn it on in the console** — add the id to `DESIGN_PATTERNS` in
   `console/functions/api/_lib/voices.js` and enable it in `PATTERNS` in
   `console/assets/js/voices.js`. Until then the console refuses that id.

Make a few test drafts with the new pattern and check them before using it for real uploads.

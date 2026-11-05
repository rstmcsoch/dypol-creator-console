# Adding and choosing voices

The narrator voice is picked per video on the **Make** page and has a default in
**Settings → Everyday settings**. The voices come from Kokoro (the free text-to-speech
both video makers use).

## 1. Pick a voice from the dashboard

1. Open **Make a new video**.
2. Choose a voice in **Voice**. The list shows the Kokoro English voices
   (US and UK, female and male) and any voices you added yourself.
3. Tap **Start making**. The voice is sent to the video maker with the video.
   **Redo** keeps the same voice as the original video.

The built-in list lives in `console/config/voices.json` (fields `id`, `label`,
`lang`, `gender`). The default is `am_michael` (Michael · US male).

## 2. Add a Kokoro voice or a blend

1. Open **Settings → Everyday settings → Add voice**.
2. Type either
   - a Kokoro voice id, e.g. `bf_emma` (any Kokoro id works, also non-English ones), or
   - a blend of 2–4 voices with weights that add up to 1, e.g. `af_bella:0.6,am_michael:0.4`.
3. Give it a name (e.g. "Warm narrator") and tap **Add**.

The voice is saved in the console (setting `customVoices`) and appears under
"Your voices" in both Voice lists. Bad ids or weights are refused with a message.

To add a voice to the built-in list for everyone, add an entry to
`console/config/voices.json` **and** its id to `KOKORO_VOICE_IDS` in
`console/functions/api/_lib/voices.js` (a test fails if the two differ).

## 3. Set the default voice

1. **Settings → Everyday settings → Default voice** (and **Default design pattern**).
2. Tap **Save changes**.

The console also tries to copy the default into both engine repos as the
Actions variables `DYPOL_DEFAULT_VOICE` and `DYPOL_DEFAULT_PATTERN`
(`gemini-youtube-automation`, `youtube-shorts-pipeline`). This needs the console's
GitHub token to have **Variables: read & write**. If GitHub refuses, the save still
works and a small notice says "Saved in console; engines still use <value>" — the
engines then keep their own default until the variable is set (by hand in
GitHub → Settings → Secrets and variables → Actions → Variables, or after the
token permission is added and you save again).

Videos started from the Make page always carry their voice, so the notice only
matters for automatic (scheduled) videos.

## 4. Custom or cloned voices

Kokoro has a fixed set of voices. It cannot clone a person's voice or learn a new
one. A truly custom or cloned voice needs a different text-to-speech engine
(for example a voice-cloning model) added to the video makers first. Only use a
cloned voice with the speaker's written permission.

## 5. Pace rule

Narration must land at **150–165 words per minute**, whatever the voice. Some voices
and blends read faster or slower than others, so make a test draft with a new voice
and check its pace (words in the script ÷ narration minutes) before using it for
real uploads. If it falls outside 150–165 WPM, adjust the voice speed in the engine
or pick another voice.

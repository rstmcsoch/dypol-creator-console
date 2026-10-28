# Orchestration, duplicate prevention & publishing safeguards

## Execution modes

Configured in **Settings → Dual-engine orchestration** (stored server-side).

### Mode 1 — Primary with fallback
* Orchestrator dispatches **Engine A (Gemini Automation)** only.
* If — and only if — the GitHub run **concludes with failure**, **nothing was
  uploaded** (upload registry checked), and the fallback policy allows it, the
  sync step dispatches **Engine B (Verticals v3)** in `draft` phase for the
  same topic.
* Fallback policies: `on_failure` (default), `never`,
  `on_failure_and_duplicate` (also fall back when the primary topic is blocked
  as duplicate).

### Mode 2 — Alternate engines
* Runs alternate between engines: by odd/even calendar day or by run index
  (configurable). Manual assignment always wins.

### Mode 3 — Both engines, draft mode
* Both engines receive `phase=draft` and produce **candidates**.
* Candidates are labelled and `publishBlocked` (“compare candidates before
  publishing”). **Neither engine can auto-publish.** The reviewer approves one
  winner; the other is rejected (artifacts kept).

## Duplicate prevention (critical)

Layers, all enforced **server-side**:

1. **Normalised topic matching** (`normalizeTopic` → `topicKey`):
   NFKD-fold, lowercase, strip punctuation, drop English stopwords, fold
   simple plurals (`ies→y`, `s→es`), collapse whitespace → SHA-256 key.
   Matching: exact key match, plus a containment heuristic for topics >12
   normalised characters. Runs **before dispatch** and **again at publish**.
2. **Central upload registry** (`uploads` table): every successful upload
   records `(topic_key, youtube_id)`. Publishing is blocked (or re-synced) when
   the topic key already exists — across BOTH engines.
3. **Existing YouTube video IDs**: the registry stores the actual IDs returned
   by successful uploads; `publish` verifies against it *before* any retry.
4. **Publishing lock** (`locks` table, atomic D1 INSERT, TTL 45 s): concurrent
   publish attempts cannot pass the gate simultaneously.
5. **Daily upload cap**: counted from the upload registry per IST day
   (default 2/day, configurable 1–10). Exceeding it returns `409 daily-cap` —
   blocked, not silently queued.

### Documented limitations of duplicate detection
* It is lexical, not semantic: “Why AI agents need memory” and “Agent memory
  explained” are different keys even if the topic is the same.
* Containment matching can over-block short generic topics (mitigated by the
  12-character floor) and under-block reordered phrasing that survives
  normalisation differently.
* No YouTube search-based dedup yet (would consume API quota); the upload
  registry covers the engines' own output history.
* Cross-account duplicates (a human uploading the same topic manually) cannot
  be detected without a channel-wide scan.

## Blind-retry protection (no duplicate uploads)

Order of checks inside `publishGate` (and the dev-server equivalent):

1. **Upload registry first** — if the topic key already has a YouTube ID,
   the console re-syncs that ID into the job and answers
   `200 “Upload state verified … No duplicate upload performed.”`
   Even a workflow that uploaded successfully but failed to update its local
   state cannot cause a second upload.
2. Review gate (`review-required` mode: only `approved`/`scheduled` may publish).
3. Publishing lock.
4. Duplicate topic check.
5. Daily cap.

Retry of failed runs (`POST /api/runs/:id/retry`) performs the same
registry verification before re-dispatching.

## Approval gate

* Default `reviewRequired: true` — a video must be explicitly approved before
  it can publish. Approval requires quality checks not to be failed.
* `autoPublish` is available only as an explicit opt-in (Settings) and is
  documented as “after review-required has been tested end-to-end”.
* Reject keeps artifacts but marks the job `rejected` — it can never publish.

## Scheduling

* Timezone: `Asia/Kolkata` (console-wide default).
* Publishing window (`windowStart–windowEnd`) + frequency (daily / twice
  daily / weekdays / manual) stored in settings and displayed on Calendar.
* **Pause automation** disables future dispatches only. It never deletes
  generated videos, published records, credentials or configuration.

## Upload visibility

Default `private`. Options `unlisted` / `public` are explicit opt-ins in
Settings or per-dispatch (`privacy` workflow input). Both engine workflows
receive `YOUTUBE_PRIVACY_STATUS` and the engines read it at upload time.

## Sync (`POST /api/sync/github`)

Pulls real GitHub Actions state into the registry:

* maps workflow runs to local runs (creating records for unknown runs),
* updates statuses, durations, failure reasons, step lists, artifacts,
* marks jobs `needs-review` / `failed` on terminal run states,
* implements the Mode-1 fallback dispatch described above,
* never invents a YouTube ID — the ID appears only after a verified upload.

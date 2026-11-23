# Architecture

Fit Check is one Node process serving a JSON API and a static React app, plus pure TypeScript logic shared by both.

```
fit-check/
├── shared/          pure logic, shared by server + web (no I/O)
│   ├── types.ts     THE data contract: Item, Outfit, Settings, DB, REST API reference
│   ├── scoring.ts   rule-based pair/outfit compatibility + formality
│   ├── optimizer.ts outfit enumeration, cheapest purchase set, Pareto frontier, per-item impact
│   └── logic.test.ts
├── server/src/
│   ├── index.ts     Hono routes, auth, background job orchestration, render cache
│   ├── ai.ts        every AI call (Gemini, Bedrock, fal.ai), prompts, mock mode
│   ├── images.ts    sharp helpers: resize/rotate, studio compositing
│   ├── db.ts        in-memory DB persisted atomically to data/db.json
│   ├── usage.ts     per-call token + cost ledger (data/usage.jsonl), price table
│   ├── backup.ts    incremental backups to BACKUP_DIR
│   └── env.ts       .env loader + config
├── web/src/
│   ├── App.tsx, api.ts, util.ts, components.tsx, styles.css
│   └── tabs/        Shop, Dress, Plan, Wardrobe, Me
└── scripts/         phone (run), tunnel-setup, service (launchd), backup, restore; dev/ = model bake-offs
```

## Data model

Everything is one `DB` object (`shared/types.ts`) persisted as `data/db.json`:

- **`items`**: garments. `status` is `owned`, `candidate` (in-store finds, with `price`/`store`), `bought` or
  `rejected`. Each item has its original photo, a studio image, AI `tags`, and optional `manualTags` overrides. The
  effective tags are `{...tags, ...manualTags}`.
- **`bases`**: photos of you, with background removed.
- **`outfits`**: keyed by a deterministic `outfitKey(pick)`. Holds AI and manual ratings, thumbs, and `renders`
  (base image → rendered file), so a render is never paid for twice.
- **`pairs`**: pairwise compatibility overrides from AI or manual input, used on top of the rule-based score.
- **`settings`**: target outfit count, minimum score, formality band, budget, active base photo.

Images are immutable files in `data/images/` named by kind and random id (`orig-…`, `studio-…`, `render-…`).

## AI pipeline (`server/src/ai.ts`)

| Step | Default model | Notes |
|---|---|---|
| Garment → studio image | `gemini-3.1-flash-image` | Redraws the exact garment as a pressed, buttoned, ghost-mannequin product shot on white. `GARMENT_FIT` steers the cut. |
| Tagging | Claude Haiku on Bedrock, falling back to `gemini-flash-latest` | JSON: slot, type, colors, pattern, formality. |
| Price tag | same vision model | Reads the price from a photo of the tag. |
| Wardrobe match | same text model | One call per new item: a 0–100 pairing score against every owned item. |
| Photo of you | Stability Remove Background (Bedrock) | Real pixels kept. Without AWS, the photo is used as-is. |
| Outfit on you | `gemini-3-pro-image` | One call with your photo plus every garment image, and an identity-preserving prompt. |

Every call goes through `timed()`, which retries once on throttling, logs latency, and records token usage and cost in
the ledger. With `MOCK_AI=1` (or no credentials at all), every function returns plausible fake output instantly, so the
whole app can be developed without spending anything.

### Why one render call per outfit?

The project tried three alternatives first:

- **Layered paper-doll compositing:** free, but garments never sit naturally on a body.
- **Sequential try-on models (FASHN):** good for a single top, but quality degrades with each chained garment, and they
  can't do shoes or belts.
- **Regenerating a "studio" version of the person:** convenient, but it drifted the face and build.

A single Gemini 3 Pro Image call with the real base photo and all garments gave the best identity preservation and
garment fidelity. Results are cached per outfit and base photo. `scripts/dev/bakeoff.ts` reproduces the comparison.

## Scoring and optimization (`shared/`)

- **Rule score** (`scoring.ts`): color harmony, neutral handling, pattern mixing, formality spread between items, and
  belt/shoe leather matching. AI or manual pair scores override the rules when present. The outfit score combines all
  of its pairs.
- **On-target outfit:** top + bottom + shoes, with an optional layer and belt, where score ≥ `minScore` and formality is
  within `[formalityMin, formalityMax]` (default 4.5–7.5, smart casual to business casual). Outfits are counted as
  distinct (top, bottom) pairs, each with its best layer, shoes and belt.
- **Optimizer** (`optimizer.ts`): finds the cheapest subset of candidates that reaches `targetOutfits`. It searches
  exhaustively over subsets when there are 16 or fewer candidates, and otherwise runs a greedy marginal-outfits-per-
  dollar search with a local-swap pass. It also returns the Pareto frontier (spend → outfit count) and each candidate's
  standalone impact.

## Server behaviors worth knowing

- **Auth:** the `x-app-password` header, or an HttpOnly `fc_session` cookie set on the first authenticated request, so
  `<img>` tags work without putting the password in URLs.
- **Background jobs:** uploads return immediately with `processing: true`; studio image, tagging and wardrobe match run
  in the background, and the client polls `GET /api/db` every 2 seconds while anything is processing. Duplicate
  concurrent requests (for example, the wardrobe match) are de-duplicated in flight.
- **Persistence:** `save()` serializes writes and renames atomically. Snapshots go to `BACKUP_DIR` every 30 minutes and
  on shutdown.
- **Costs:** `GET /api/usage` returns totals by call type and by day from the ledger.

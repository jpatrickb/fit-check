# Fit Check: original spec

> The design notes the project started from. Some details have changed since (see the UPDATE note and
> [ARCHITECTURE.md](ARCHITECTURE.md) for the current design).

Personal phone-first web app: digitize my wardrobe, virtually try outfits on a studio image of me,
and while shopping, evaluate store items and find the cheapest set of purchases that yields enough
business-casual / smart-casual outfits for a 5-day workweek plus spares.

Single user. Runs on my laptop (Node), exposed to my phone via `cloudflared tunnel --url`.
Must be portable to AWS Lambda later (keep Bedrock + storage behind small modules).

## Stack
- Root `package.json` (one package, ESM, TypeScript). Node 22+.
- `server/` — Hono on `@hono/node-server`, run with `tsx`. Port 8787. Serves `/api/*` and, in prod, `web/dist`.
- `web/` — Vite + React + TypeScript SPA, mobile-first. Dev proxy `/api` → `localhost:8787`.
- `shared/` — `types.ts` (THE contract), `scoring.ts`, `optimizer.ts`. Imported by web (and server if useful).
- Storage: `data/db.json` (whole DB, written atomically) + `data/images/<id>.(jpg|png)`. Served at `/api/images/<file>`.
- Auth: env `APP_PASSWORD`; client sends header `x-app-password` (stored in localStorage). Images route accepts `?pw=` too.
- AWS: `@aws-sdk/client-bedrock-runtime`, region `us-east-1` (Nova Canvas lives there), profile from `AWS_PROFILE`.
- `MOCK_AI=1` (default when no AWS creds) → every AI function returns plausible fake output instantly
  (cutout = original image resized; try-on = base image; tags = heuristic/random but valid). Whole app must be usable in mock mode.
- Image handling with `sharp`: auto-rotate (EXIF), resize so longest side ≤ 1536 and both sides ≥ 320 before Bedrock.

## AI pipeline

> UPDATE: Nova Canvas is EOL on Bedrock. Now: garment cutouts = Bedrock `stability.stable-image-remove-background-v1:0`;
> person studio photo + try-on = Gemini image model (GEMINI_API_KEY, one call per whole outfit), fallback Stability search-replace;
> tagging/scoring = Bedrock `global.anthropic.claude-haiku-5-5`.. Table below is the original plan.

| Function | Model | Notes |
|---|---|---|
| `studioizeItem(img)` | Nova Canvas `amazon.nova-canvas-v1:0` taskType `BACKGROUND_REMOVAL` → composite on white/very light gray, centered, square 1024 | garment "studio" image |
| `studioizePerson(img)` | Nova Canvas BACKGROUND_REMOVAL → composite on studio gray gradient, portrait 768x1344-ish | base photo |
| `neutralBase(person)` | Nova Canvas `VIRTUAL_TRY_ON` with a generated/plain neutral tee + slim chinos | optional "clean base" |
| `tryOn(base, garmentImg, garmentClass, styling)` | Nova Canvas `VIRTUAL_TRY_ON`, `maskType: GARMENT`, `garmentBasedMask.garmentClass` per item, `mergeStyle: BALANCED` | layered: bottom → top → layer (outerLayerStyle OPEN) → shoes |
| `tagItem(studioImg)` | Claude (vision) on Bedrock, JSON output | returns `ItemTags` |
| `readPriceTag(img)` | Claude vision | returns `{price:number|null, brand?, text}` |
| `scoreOutfit(items)` | Claude (text over tags + optionally images) | returns `{score 0-100, formality 1-10, label, notes}` |
| `scoreItemAgainstWardrobe(item, wardrobe)` | Claude text-only over tags, one call | pairwise compat 0-100 per wardrobe item |

Verify exact Nova Canvas request shapes against AWS docs (virtual try-on params: sourceImage, referenceImage,
maskType, garmentBasedMask.garmentClass, garmentStyling, mergeStyle). Claude model IDs via env (`CLAUDE_MODEL`),
default a fast Haiku-class Bedrock inference profile. Cache every result (keyed by input ids) — never pay twice.

## Formality scale (1–10)
1 gym · 2 lounge · 3 casual (graphic tee, shorts) · **4–5 smart casual** (polo, dark jeans, clean sneakers, chinos)
· **6–7 business casual** (OCBD/button-down, chinos/wool trousers, loafers/derbies, sweater, unstructured blazer)
· 8 business (suit separates, tie optional) · 9–10 formal. **Target band: 4.5–7.5.**

## Screens (bottom tab bar)
1. **Me** — upload/take body photo → studio version (+ optional neutral base). Pick active base.
2. **Wardrobe** — grid of studio cutouts filtered by slot; bulk upload (multi-file); tap item → edit tags/override formality, delete.
3. **Dress** — pick top / bottom / layer(optional) / shoes from carousels per slot (owned + candidates, candidates badged with price).
   Instant flat-lay board + rule score; button "AI rate" and "Render on me" (cached). Thumbs up/down + manual score override. Save outfit.
4. **Shop** — big camera button (`<input type=file accept=image/* capture=environment>`), then price: type field AND "snap tag" button.
   Shows result card within seconds: cutout, tags, formality, "works with N wardrobe items / unlocks M new on-target outfits".
   Star / rank (drag or up/down) candidates; reject. Try-on renders in background.
5. **Plan** — optimizer: budget slider, target outfit count (default 8), min outfit score (default 70).
   Shows cheapest purchase set reaching target, outfit count vs. spend curve (marginal value per item), list of resulting outfits (boards).

## Optimizer (shared/optimizer.ts, pure, fast, client-side)
Inputs: items (owned + candidates with price, not rejected), pair compatibility (rule-based, overridden by AI/manual when present),
config. Outfit = top + bottom + shoes (+ optional layer). Valid if score ≥ min and formality in band.
"Distinct" outfits = unique (top,bottom) pairs (count best shoes/layer for each). Search: exhaustive over subsets of candidates
when ≤ 16 candidates, else greedy by marginal outfits per dollar + local swap. Output: best set per budget, Pareto frontier
(cost → outfit count), per-candidate marginal contribution.

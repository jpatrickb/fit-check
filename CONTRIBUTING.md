# Contributing

Thanks for your interest! Issues and pull requests are welcome.

## Getting set up

```bash
npm install
cp .env.example .env
MOCK_AI=1 npm run dev     # full UI at http://localhost:5173 with fake AI output: no keys, no cost
```

Use real keys only when you are working on the AI pipeline itself.

## Before opening a PR

```bash
npm run typecheck
npm test
npm run build
```

CI runs the same three commands.

## Guidelines

- **`shared/types.ts` is the contract** between server and web. If you change it, update both sides and the REST API
  comment at the bottom of the file.
- **Keep `shared/` pure:** no I/O, no Node or DOM APIs. It runs in the browser and is unit-tested.
- **Every paid AI call goes through `timed()` in `server/src/ai.ts`,** so it is retried, logged and costed. If you add a
  model, add its price to `server/src/usage.ts`.
- **Cache AI results by their inputs.** Users should never pay twice for the same output.
- **Mock mode must keep working.** Each AI function needs a fast fake path for `MOCK_AI=1`.
- **Test expensive changes on one or two images first.** Prompt or model changes that affect bulk work (re-generating a
  wardrobe) should be checked on a couple of items before running on everything. `scripts/dev/` has small harnesses for
  this.
- **Never commit personal data:** no photos, `data/`, `.env` or screenshots of other people.

## Project layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

# Working conventions

- Commands: `npm run dev`, `npm test`, `npm run test:coverage`, `npm run typecheck`,
  `npm run validate` (eslint + prettier check), `npm run format`, `npm run db:migrate`,
  `npm run db:ingest`.
- Layering: router → controller → service → repository. No business logic in controllers.
- No auth, no multi-country support — out of scope per SPEC.md, don't add without an explicit new ask.
- DB: Postgres + PostGIS via Kysely. No ORM, no MongoDB.
- SPEC.md is locked — don't re-litigate its decisions; extend ARCHITECTURE.md instead.
- Build progressively, one stage at a time (see the repo's commit history for the stage
  breakdown). Stop after each stage for review before starting the next one.
- No comments in application code — reasoning lives in ARCHITECTURE.md, not inline.
  Exceptions only for genuinely non-obvious workarounds, and even then, prefer
  extending ARCHITECTURE.md first.
- Tests run against a real Postgres, not mocks (see ARCHITECTURE.md's Testing section
  for why) — always confirm Postgres is up (`docker compose up -d postgres`) before
  running the suite.
- Never `git add` or `git commit` unless explicitly asked to in that turn.
- After any change: `npm run typecheck && npm run validate && npm test` before
  considering the work done — don't rely on partial checks.

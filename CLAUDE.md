# Working conventions

- Commands: `npm run dev`, `npm test`, `npm run db:migrate`, `npm run db:ingest`
- Layering: router → controller → service → repository. No business logic in controllers.
- No auth, no multi-country support — out of scope per SPEC.md, don't add without an explicit new ask.
- DB: Postgres + PostGIS via Kysely. No ORM, no MongoDB.
- SPEC.md is locked — don't re-litigate its decisions; extend ARCHITECTURE.md instead.
- Build progressively, one stage at a time (see the repo's commit history for the stage
  breakdown). Stop after each stage for review before starting the next one.

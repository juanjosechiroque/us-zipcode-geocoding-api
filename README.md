# zipcodes-api

A geocoding API over US ZIP code data. Forward search works today; reverse lookup and
radius search are next (see [Known Limitations](#known-limitations)). Express +
TypeScript + PostgreSQL/PostGIS.

Requirements and locked decisions: [SPEC.md](SPEC.md). This README stays thin on
purpose — full reasoning and rejected alternatives live in [ARCHITECTURE.md](ARCHITECTURE.md).

## Key Decisions

- **Express + TypeScript**, not Fastify — reused a proven personal starter's hygiene
  (Zod env, structured logging, centralized errors) over building it from scratch.
- **PostgreSQL + PostGIS**, not MongoDB or Elasticsearch — one engine covers both
  geodesic queries (GiST) and fuzzy city search (`pg_trgm`); a second store would be overkill.
- **One denormalized `zip_codes` table**, not `zip → city → state` — the real data has
  almost no duplicate ZIPs, so normalizing would only add joins, not integrity.
- **Kysely, not an ORM** — Prisma has no native `geography` type; every spatial query
  would need a raw-SQL escape hatch anyway.

Why, and what was rejected for each: [ARCHITECTURE.md](ARCHITECTURE.md#decisions-log).

## Prerequisites

- Node.js 24+ (see `.nvmrc`)
- Docker + Docker Compose

## Setup

```bash
git clone <this-repo>
cd zipcodes-api
cp .env.example .env
npm install

docker compose up -d postgres    # Postgres + PostGIS
npm run db:migrate               # creates the zip_codes table + indexes
npm run db:ingest                # loads the committed dataset (41,488 ZIP codes)

npm run dev                      # http://localhost:3000
```

```bash
curl localhost:3000/v1/health
# {"status":"healthy","uptime":...,"services":{"db":"connected"}}
```

## Using it

```bash
curl "localhost:3000/v1/locations/search?q=90210"                # ZIP, exact or prefix
curl "localhost:3000/v1/locations/search?q=902&limit=5"
curl "localhost:3000/v1/locations/search?q=Beverly"               # city, fuzzy
curl "localhost:3000/v1/locations/search?q=Springfield,IL"        # city scoped by state
curl "localhost:3000/v1/locations/search?q=123+Main+St,+Beverly+Hills,+CA+90210"  # full address, resolves via the ZIP
```

Full contract (params, limits, response/error shapes): [SPEC.md](SPEC.md#functional-requirements).

## Development

```bash
npm run dev            # hot reload
npm test
npm run test:coverage
npm run typecheck
npm run validate       # eslint + prettier check
npm run format          # eslint --fix + prettier --write
```

Tests run against a real Postgres, not mocks — see [why](ARCHITECTURE.md#testing).

## Refreshing the dataset

`data/us_zip_codes.csv` (GeoNames `US.zip`, CC BY 4.0) is committed so setup works
offline. `npm run db:ingest` is idempotent, safe to re-run anytime — including against
a refreshed copy of the source file. Details: [ARCHITECTURE.md](ARCHITECTURE.md#data-ingestion).

## Project structure

```
src/
  api/<resource>/    # router → controller → service → repository
  middleware/        # request-id, error handling, validation
  utils/             # logger, response envelope, asyncHandler
  config.ts          # Zod-validated env
  database.ts        # Kysely + pg pool
  app.ts             # Express app (no listen())
index.ts             # app.listen() + graceful shutdown
db/schema.sql         # idempotent schema + indexes
scripts/               # migrate.ts, ingest.ts
data/                  # committed dataset
```

## Known Limitations

- Only forward search is implemented — reverse lookup and radius search aren't built yet.
- No street-level address parsing (dataset is ZIP/city/state-level).
- Ranking is trigram similarity only — an exact match elsewhere can outrank a more relevant one.

Full list with rationale: [ARCHITECTURE.md](ARCHITECTURE.md#known-limitations).

## Next Steps

Reverse lookup, radius search, a `Dockerfile` for one-command spin-up, and a few
smaller items. Full list: [ARCHITECTURE.md](ARCHITECTURE.md#next-steps).

# zipcodes-api

A geocoding API over US ZIP code data: forward search, reverse lookup, and radius
search. Express + TypeScript + PostgreSQL/PostGIS.

The domain is a directory of **postal-code records and their representative point
coordinates**, derived from GeoNames. It is not a street-address database, a map of ZIP
boundaries, or a Census ZCTA dataset. Reverse and radius operations compare coordinates
with those representative points.

Implemented contract: [SPEC.md](SPEC.md). This README stays thin on purpose — decisions,
trade-offs, limitations, and open production questions live in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Key Decisions

- **Express + TypeScript**, not Fastify — reused a proven personal starter's hygiene
  (Zod env, structured logging, centralized errors) over building it from scratch.
- **PostgreSQL + PostGIS**, not MongoDB or Elasticsearch — one engine covers both
  geodesic queries (GiST) and fuzzy city search (`pg_trgm`); a second store would be overkill.
- **One denormalized `zip_codes` table**, not `zip → city → state` — the real data has
  almost no duplicate ZIPs, so normalizing would only add joins, not integrity.
- **Kysely, not an ORM** — Prisma has no native `geography` type; every spatial query
  would need a raw-SQL escape hatch anyway.

Why, and the accepted cost of each choice:
[ARCHITECTURE.md](ARCHITECTURE.md#decision-summary).

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

curl "localhost:3000/v1/locations/reverse?lat=34.0901&lng=-118.4065"              # nearest location
curl "localhost:3000/v1/locations/reverse?lat=34.0901&lng=-118.4065&limit=5"      # 5 nearest, by distance

curl "localhost:3000/v1/locations/radius?lat=34.0901&lng=-118.4065&radius_km=5"   # everything within 5km
curl "localhost:3000/v1/locations/radius?lat=34.0901&lng=-118.4065&radius_km=5&limit=20&cursor=<next_cursor>"
```

Radius responses use cursor pagination, default to 20 matches, and accept `limit=1..50`.
When `meta.has_more` is true, pass `meta.next_cursor` unchanged to retrieve the next
page. Following cursors until `next_cursor` is `null` returns every match in the radius.

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

## Deployment controls

Location endpoints share this per-IP limit in the provided configuration:

```env
RATE_LIMIT_WINDOW_MINUTES=1
RATE_LIMIT_MAX=60
```

Copying `.env.example` to `.env` enables the limiter locally at 60 requests per minute.
Production must inject both variables into the process environment; startup is rejected if
either is absent. `/v1/health` is never rate-limited. The in-memory counter is suitable for
one API instance; use a shared gateway or store when deploying multiple replicas.

`TRUST_PROXY_HOPS` defaults to `0`, so client-supplied `X-Forwarded-*` headers are not
trusted. Set it to `1` only when the API is always behind exactly one trusted proxy that
overwrites those headers.

## Refreshing the dataset

`data/us_zip_codes.csv` (GeoNames `US.zip`, CC BY 4.0) is committed so setup works
offline. `npm run db:ingest` is idempotent, safe to re-run anytime — including against
a refreshed copy of the source file. Before opening the write transaction, the command
validates the complete CSV, reports at most the first 20 row-level issues plus the total,
and rejects conflicting rows for the same ZIP. The CSV is treated as the complete snapshot:
new and changed ZIPs are upserted, and ZIPs absent from it are removed. Staging, merge, and
deletion commit as one transaction, so a failed run does not publish a partial refresh. Details:
[ARCHITECTURE.md](ARCHITECTURE.md#data-ingestion) and [DATA_LICENSE.md](DATA_LICENSE.md).

## Project structure

```
src/
  api/<resource>/    # router → controller → service → repository, cursor helpers
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

- No street-level address parsing (dataset is ZIP/city/state-level).
- Reverse lookup finds the nearest ZIP _centroid_, not the ZIP whose real boundary
  contains the point (the dataset has no boundary polygons).

Full list with rationale: [ARCHITECTURE.md](ARCHITECTURE.md#known-limitations).

## Next Steps

Production priorities and the questions still requiring product or infrastructure input:
[ARCHITECTURE.md](ARCHITECTURE.md#open-production-questions). The smaller implementation
follow-ups are listed in [Next Steps](ARCHITECTURE.md#next-steps).

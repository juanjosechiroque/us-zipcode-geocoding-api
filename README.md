# zipcodes-api

A production-minded geocoding API over US ZIP-code records. It provides forward search,
nearest-location lookup, and radius search using Express, TypeScript, PostgreSQL, and PostGIS.

The API searches city/state labels and representative ZIP coordinates from GeoNames. See
[SPEC.md](SPEC.md) for the exact contract and [ARCHITECTURE.md](ARCHITECTURE.md) for
decisions and trade-offs.

## Quick Start

Requires Docker and Docker Compose.

```bash
git clone <this-repo>
cd zipcodes-api
cp .env.example .env
docker compose up --build
```

Compose starts PostGIS, runs migration and ingestion, then starts the API. `db-setup`
finishing with `Exited (0)` is expected. Data persists across restarts.

Verify from another terminal:

```bash
curl http://localhost:3000/v1/health
curl "http://localhost:3000/v1/locations/search?q=90210"
curl "http://localhost:3000/v1/locations/reverse?lat=34.0901&lng=-118.4065"
curl "http://localhost:3000/v1/locations/radius?lat=34.0901&lng=-118.4065&radius_km=5"
```

Use `docker compose down` to stop the stack while keeping its database volume.

## API

| Endpoint                                                       | Purpose                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------- |
| `GET /v1/locations/search?q=&limit=`                           | ZIP prefix, city prefix/fuzzy search, or ZIP embedded in an address |
| `GET /v1/locations/reverse?lat=&lng=&limit=`                   | Nearest ZIP point(s), ordered by distance                           |
| `GET /v1/locations/radius?lat=&lng=&radius_km=&limit=&cursor=` | Cursor-paginated ZIP points within a radius                         |
| `GET /v1/health`                                               | API and database health                                             |

Radius pages default to 20 rows and allow at most 50. Pass `meta.next_cursor` unchanged
until it becomes `null`. Parameter rules, responses, and errors are defined in
[SPEC.md](SPEC.md).

## Native Development

Requires Node.js 24+ and Docker for PostGIS.

```bash
cp .env.example .env
npm ci
docker compose up -d postgres
npm run db:migrate
npm run db:ingest
npm run dev
```

After the first setup, daily development normally needs only:

```bash
docker compose up -d postgres
npm run dev
```

Useful commands:

```bash
npm test
npm run test:coverage
npm run typecheck
npm run validate
npm run build
```

Tests use the real PostGIS database rather than repository mocks.

## Dataset Refresh

`data/us_zip_codes.csv` is committed for offline setup. `npm run db:ingest` validates the
entire CSV, then atomically reconciles it as the authoritative snapshot. Re-running the
same file makes no changes. Source URL, date, record count, and license are recorded in
[DATA_LICENSE.md](DATA_LICENSE.md).

## Deployment Notes

- The provided configuration enables a per-IP limit of 60 location requests per minute.
- Production startup requires both rate-limit variables to be supplied explicitly.
- `TRUST_PROXY_HOPS` defaults to `0`; set it only for a known proxy topology that
  overwrites forwarded headers.
- The limiter is in-memory and intended for one API instance. Multiple replicas need a
  shared gateway or store.

Known limitations and production follow-ups are documented in
[ARCHITECTURE.md](ARCHITECTURE.md#known-limitations).

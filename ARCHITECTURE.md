# Architecture

This document is a running design log. It grows one section at a time, in the same
commit as the code it describes — it is not written after the fact. For _what_ is being
built and the requirements it must satisfy, see [SPEC.md](./SPEC.md); this document
covers _why_ it's built the way it is, the trade-offs considered, and what was rejected.

## Overview

Request lifecycle: `index.ts` boots the HTTP server and owns process lifecycle
(listen, graceful shutdown on SIGTERM/SIGINT). `src/app.ts` wires the Express
middleware stack in order — `helmet` → request-id → `pino-http` access logging →
`cors` → rate limiting → JSON body parsing → the versioned router (`/v1`) → 404
handler → centralized error handler. Every request gets an `x-request-id` (client-
supplied or generated), which is attached to `req.id`, echoed in the response header,
and included on every log line for that request — that's the thread that ties a log
line back to the request that produced it.

Errors flow through one path: route handlers `throw` (or `next()`) an `AppError`
(from `src/errors.ts`) with a `statusCode`/`code`, and the centralized error
middleware (`src/middleware/errorMiddleware.ts`) is the only place that decides the
HTTP status and JSON shape returned to the client. Handlers never format error
responses themselves — `asyncHandler` forwards rejected promises into this same path,
so an unhandled exception in an `async` controller can't crash the process silently.

## Decisions Log

### Framework: Express 5 + TypeScript (not Fastify)

Reused the hygiene from a personal starter repo — Zod-validated env, pino structured
logging with request-id correlation, centralized error middleware, consistent
response envelope — rather than building request/response plumbing from scratch.
Fastify would give native JSON-schema validation and a modest throughput edge, but
Express + Zod is equally rigorous for this scope and stays close to a pattern already
proven to work, instead of re-deriving the same guarantees in an unfamiliar framework.

### Error handling: typed error factories + one centralized handler

`NotFoundError` (in `src/errors.ts`) is a plain factory that attaches
`statusCode`/`code` to a real `Error`, not a class hierarchy — enough to distinguish
404 vs 500 without ceremony. `BadRequestError` will be added back in Stage 4 alongside
the query-validation middleware that actually throws it — kept out until then so
nothing in the repo sits unused. Rejected alternative: per-route try/catch with inline
`res.status().json()` calls, which is exactly what tends to drift out of sync across a
codebase and produce inconsistent error shapes.

### Response envelope: `{ status, message, data }` on success, `{ status, code, message, details? }` on error

Chosen so a client can always branch on `status` without inspecting a nested error
object first. Kept intentionally asymmetric (success has no `code`) since a 2xx
response has no error category to report.

## Data Model

### One denormalized `zip_codes` table (not a normalized `zip → city → state` schema)

The prompt frames the dataset as "relational in nature" and hints the obvious answer
isn't the right one. Verified against the real data (GeoNames `US.zip`, 41,489 rows):
only 2 ZIP codes have more than one row. A ZIP code is, for practical purposes, a flat
entity — city/state/county attributes don't repeat across rows in any way that would
benefit from normalization. Splitting this into `zip_codes → cities → states` tables
would add a join to every read (forward search, reverse lookup, radius search are _all_
reads) for zero real data-integrity benefit. One table, one write path (the ingestion
script), read-optimized.

### Database: PostgreSQL + PostGIS (not MongoDB, not Elasticsearch)

MongoDB is what the reference starter used, but this domain needs two things Mongo
doesn't cover as one piece. First, geodesic radius/nearest-neighbor queries: `geography`
plus GiST (`ST_DWithin`, `<->` for KNN) are purpose-built for this, and Mongo's
`2dsphere` plus `$geoNear` can do it too. Second, fuzzy/prefix autocomplete on city
names needs `pg_trgm`, which has no equivalent in Mongo without bolting on a second
search engine such as Elasticsearch. Elasticsearch was rejected for the same reason: it
would solve autocomplete well, but introduces a second datastore to keep in sync for a
dataset this size, which is the "overbuilt" failure mode the assessment explicitly
warns against. One SQL engine, two purpose-built index types (GiST + GIN/pg_trgm), no
second store.

### Query layer: Kysely, not an ORM

Prisma's PostGIS support is thin (no native `geography`/`geometry` column type, raw SQL
escape hatches needed for anything spatial). Kysely gives typed query building for the
90% of normal SQL while leaving raw `sql` template fragments as a first-class citizen
for `ST_DWithin`/`ST_MakePoint`/KNN — no fighting the abstraction for the exact queries
this API is built around.

### The `location` column is derived, not written directly

`location GEOGRAPHY(Point,4326) GENERATED ALWAYS AS (...) STORED` computes itself from
`latitude`/`longitude` on every insert/update. The ingestion script (Stage 3) only ever
writes lat/lng — it can't drift out of sync with the derived geography value, and there
is no second code path that has to remember to keep both in sync.

## Data Ingestion

### Idempotency mechanism

`scripts/ingest.ts` reads `data/us_zip_codes.csv` and upserts in batches of 500 rows via
`INSERT ... ON CONFLICT (zip_code) DO UPDATE SET ... WHERE <any column actually
changed> RETURNING (xmax = 0) AS inserted`. The `xmax = 0` trick tells inserted rows
apart from updated ones (Postgres sets `xmax` on a row when it's touched by an update
within the same transaction), and the `WHERE <changed>` clause means a row that
conflicts but has identical data is skipped entirely — it never shows up in `RETURNING`
and `updated_at` isn't bumped for no reason. That's how the script reports real
inserted/updated/unchanged counts instead of just "N rows processed."

**Running it twice** on the same file: run #1 inserts ~41,488 rows; run #2 reports 0
inserted, 0 updated, all 41,488 unchanged — verified by hand this session.

**If the source dataset changes** (GeoNames re-publishes with corrected coordinates or
renamed cities): re-run `npm run db:ingest` against the refreshed CSV. Existing zip
codes get updated in place (their `updated_at` moves forward), new zip codes get
inserted, and nothing needs to be deleted/reset first — the conflict target is the
natural key (`zip_code`), not a generated surrogate id.

### Duplicate zip codes are a real failure mode, not just a data-quality footnote

GeoNames' raw file has 41,489 rows but only 41,488 unique ZIP codes (2 military-base
ZIPs in Hawaii appear twice). This matters beyond "clean data": a single
`INSERT ... ON CONFLICT DO UPDATE` statement raises `ON CONFLICT DO UPDATE command
cannot affect row a second time` if two rows in the _same_ statement share the conflict
key — and since batches are sequential 500-row chunks of a file sorted by ZIP, a
duplicate is likely to land in the same batch as its twin. Handled in two layers: the
raw-to-CSV conversion already dedupes (keeps the first occurrence), and
`scripts/ingest.ts` _additionally_ collapses rows into a `Map<zip_code, row>` before
batching, regardless of whether the input file was already clean — so a future source
with more duplicates degrades to "last row wins" instead of crashing mid-run with some
batches applied and others not.

### Dataset provenance

GeoNames `US.zip` (`download.geonames.org/export/zip/US.zip`), licensed CC BY 4.0
(attribution: geonames.org). Committed as `data/us_zip_codes.csv` so setup works cold,
with no network dependency at ingest time — only the one-time conversion (documented in
the README) needs to reach the source.

## API Design

_Added in Stage 4._

## Non-Functional Notes

_Performance, scalability, and observability reasoning — added as each concern is
addressed in its corresponding stage._

## Known Limitations

_Added progressively, finalized in Stage 6._

## Next Steps

_Added progressively, finalized in Stage 6._

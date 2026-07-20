# Architecture

A running design log, grown one section at a time alongside the code. For _what_ is
being built, see [SPEC.md](./SPEC.md) — this doc covers _why_, and what was rejected.

## Overview

`index.ts` boots the server and owns process lifecycle (listen, graceful shutdown).
`src/app.ts` wires the middleware stack: `helmet` → request-id → logging → `cors` →
rate limiting → JSON body → router → 404 → error handler. Every request carries an
`x-request-id`, echoed in the response header and in every log line for that request.

Errors flow through one path: handlers `throw` an `AppError` with a `statusCode`, and
`errorMiddleware.ts` is the only place that turns that into an HTTP response.
`asyncHandler` forwards rejected promises into the same path, so a thrown error in an
`async` controller can't crash the process silently.

## Decisions Log

**Express 5 + TypeScript, not Fastify.** Reused the hygiene of a personal starter repo
(Zod env, pino logging, centralized errors) instead of building request plumbing from
scratch. Fastify has a throughput edge, but this stays closer to a pattern already
proven to work.

**One denormalized `zip_codes` table, not `zip → city → state`.** The prompt calls the
dataset "relational" but hints the obvious answer isn't right. Checked: GeoNames has
41,489 rows, only 2 duplicate ZIPs. It's a flat entity — normalizing would add a join
to every read for zero integrity benefit.

**PostgreSQL + PostGIS, not MongoDB or Elasticsearch.** Needs geodesic radius/nearest
queries (`geography` + GiST) _and_ fuzzy city search (`pg_trgm`) — Mongo covers the
first but not the second without bolting on a search engine, which is exactly the
"overbuilt" failure mode the prompt warns against.

**Kysely, not an ORM.** Prisma has no native `geography` type — every spatial query
would need a raw-SQL escape hatch anyway. Kysely keeps typed queries and raw `sql`
fragments as equal citizens.

**`location` is a generated column**, computed from lat/lng on every write. The
ingestion script only ever touches lat/lng — there's no second code path that could
let them drift out of sync.

## Data Ingestion

`scripts/ingest.ts` upserts in batches of 500: `INSERT ... ON CONFLICT DO UPDATE ...
WHERE <changed> RETURNING (xmax = 0)`. That last trick tells inserted rows from updated
ones, and the `WHERE` clause skips rows that didn't actually change — so the script
reports real inserted/updated/unchanged counts, not just "done."

- **Idempotent**, verified: run #1 inserts 41,488 rows; run #2 reports 0/0/41,488 unchanged.
- **Source changes** re-ingest safely — the conflict target is the natural key (`zip_code`).
- **Duplicates are a real failure mode**, not just messy data: a single batch statement
  errors if two input rows share a conflict key. GeoNames has 2. Handled twice — the
  CSV is pre-deduped, and the script _also_ collapses by `zip_code` in memory before
  batching, so a dirtier future source degrades gracefully instead of crashing mid-run.
- **Dataset**: GeoNames `US.zip`, CC BY 4.0, committed to the repo so setup works cold.
- **Concurrent runs, tested for real**: launched two `db:ingest` processes at once
  against an empty table — Postgres serialized the conflicting upserts safely, zero
  errors, zero duplicate rows. Safe, but wasteful (both parse and push the whole file),
  so a Postgres advisory lock (`pg_try_advisory_lock`) now makes the second run exit
  immediately with a clear log message instead of doing redundant work. Session-scoped,
  so a crash can't leave it stuck.

## API Design

`GET /v1/locations/search?q=&limit=` — contract in [SPEC.md](./SPEC.md). Branches on
the shape of `q`: digits-only routes to a ZIP-prefix match, anything else to a city
match (fuzzy + prefix), optionally scoped by state. All paths return the same shape.

**Not a street-address parser.** The prompt asks for "partial or full address," but the
dataset has no street data. A full address resolves via whatever 5-digit ZIP is
embedded in it; the street/unit text is never matched against anything. Deliberate
scope boundary, not an oversight.

### Bugs found by testing, not by reading the code

- **Non-deterministic order.** Searching `"York"` returns 14 exact ties with no
  secondary sort key — order wasn't stable across runs. Fixed with explicit
  tie-breakers (`similarity DESC, city ASC, zip_code ASC`).
- **Wrong-city false positive.** `"Springfield, Illinois"` was falling back to
  searching for a city literally named `"Illinois"`, and confidently returning
  `"Illinois City"`. Fixed by falling back to the _first_ comma segment instead of the
  last when the state isn't a recognized 2-letter code.
- **Short queries returned nothing.** `similarity("Beverly", "Be") = 0.22`, below
  `pg_trgm`'s 0.3 threshold — so `q="Be"` excluded `"Beverly"` entirely, and `q="B"`
  (3,086 matching cities) returned zero. Trigram similarity needs more text than the
  first keystroke gives it. Fixed by matching on `city ILIKE q||'%' OR city % q` —
  prefix covers early typing, similarity still covers typos. Still uses the same GIN
  index (confirmed with `EXPLAIN ANALYZE`, no new index needed).

## Non-Functional Notes

- **Indexes verified, not assumed.** `EXPLAIN ANALYZE` before and after: ZIP prefix
  search went `Seq Scan` (29ms) → `Index Scan` (3.9ms) once a `text_pattern_ops` index
  was added (this DB's `en_US.utf8` collation can't use a plain btree for `LIKE`).
- **The GiST index for reverse/radius is already verified, ahead of building those
  endpoints.** Ran real KNN and `ST_DWithin` queries by hand — both use
  `zip_codes_location_gist_idx` (`Index Scan` / `Bitmap Index Scan`), never a seq scan.
  Absolute latency in this dev environment (~100-130ms) is inflated by Docker running
  the `linux/amd64`-only Postgres image under emulation on this arm64 machine —
  geodesic distance math is CPU-heavy, so it takes the emulation tax hardest. The index
  choice is confirmed correct; the exact latency number isn't representative of
  production hardware.
- **Load-tested, not just single-request.** 100 and 300 concurrent requests against the
  real dataset: 100% success, p50 ~170-185ms, no errors. The bounded connection pool
  (`max: 10`) queues rather than fails — that's the documented bottleneck under heavier load.
- **Rate limiting is implemented and tested, but off by default.** Search has its own,
  more permissive limiter, separate from the general one — verified working when
  enabled. Off in `.env.example` so evaluating this repo locally never hits a surprise
  `429`; one env var away from being live.
- **Query params are structured in logs** (`req.query`), not just embedded in the URL string.

## Testing

Integration tests run against the real ingested Postgres, not mocks — mocking Kysely
would mean re-encoding the same PostGIS assumptions being tested. Two of the three bugs
above were caught this way: a test failed against real data where manual curl testing
had already "passed." Trade-off: no fully isolated unit-test path for the repository
layer, by design.

## Known Limitations

- No street-level address parsing (dataset is ZIP/city/state-level only).
- Ranking is trigram similarity only — exact matches in one state can outrank a more
  relevant result elsewhere, and a short query can rank a long prefix match below an
  unrelated short name. A weighted/boosted ranking would fix both; out of scope here.
- Full US state names aren't recognized in `"City, State"` input, only 2-letter codes.
- Only forward search exists — reverse lookup and radius search aren't built yet.
- Connection pool size is hardcoded, not env-configurable.

## Next Steps

- Reverse lookup and radius search (same patterns: real-data tests, `EXPLAIN ANALYZE`-verified indexes).
- Automated idempotency test for ingestion (today it's verified by hand).
- State-name-to-code mapping for forward search.
- Prefix-aware ranking so short queries don't bury long, relevant matches.
- `Dockerfile` + `api` service in `docker-compose.yml` for one-command full-stack spin-up.
- Make the connection pool size configurable; enable rate limiting by default for real deployment.

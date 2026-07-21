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

## Domain Definition

A location in this service is a GeoNames US postal-code record with a city/state label
and a representative latitude/longitude. The point is treated as a postal-code centroid
for nearest-distance calculations. The service does **not** model deliverable street
addresses, ZIP boundary polygons, or Census ZIP Code Tabulation Areas (ZCTAs). Therefore:

- forward search resolves postal codes and locality labels, not a street address;
- reverse search means “nearest known postal-code point,” not “the polygon containing
  this coordinate”;
- radius search returns postal-code points inside the requested geodesic distance.

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

All batches execute on one connection inside a single transaction. Batching keeps each
statement reasonably sized, while the transaction makes the publication atomic: either
every batch commits or a failure rolls back the complete run. For this ~41k-row dataset,
the bounded transaction is an acceptable trade-off. A much larger or continuously
served dataset should use a staging table plus a short transactional swap/merge instead.

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

`GET /v1/locations/reverse?lat=&lng=&limit=` — KNN via `ORDER BY location <-> point`,
same GiST index radius search also uses. `distance_meters` is computed alongside and
only present on reverse/radius rows (`LocationDto` keeps it optional) — search has no
notion of distance. Verified the exact Kysely-generated SQL still uses
`zip_codes_location_gist_idx` (`Index Scan`, not a seq scan).

`GET /v1/locations/radius?lat=&lng=&radius_km=&limit=&cursor=` — `ST_DWithin` for the
bounding filter, `ST_Distance` for both the returned `distance_meters` and the ordering.
Verified the base query uses `zip_codes_location_gist_idx` (`Bitmap Index Scan`, same
plan shape as the manual verification done before either endpoint was built). Zero
matches inside the radius return `200` with `data: []`, not `404` — consistent with
search and reverse.

Radius uses keyset pagination ordered by `(distance_meters, zip_code)`, not offset
pagination. The repository requests `limit + 1`, so the service can produce `has_more`
without a separate `COUNT(*)`. The next cursor is URL-safe Base64-encoded JSON containing
the last ordering position, a format version, and the original radius parameters. It is
validated as opaque input and rejected if reused with a different query. The cursor is
not encrypted or signed; this read-only API treats it as untrusted, parameterized input.
Following cursors allows consumers to retrieve all matches while each response remains
bounded to 20 by default and 50 at most.

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

### Production policies to decide before deployment

- **Remote reverse results:** the current API always returns the nearest known point,
  even when it is far away. Product policy should choose between a hard maximum distance,
  returning a `match_quality`/distance for the consumer to assess, or requiring callers
  to provide their own maximum. A caller-provided `max_distance_km` is the most flexible;
  a server-side safety ceiling prevents obviously misleading ocean results.
- **Cancelled requests:** baseline protection is a PostgreSQL `statement_timeout` so
  abandoned work is bounded. Stronger options are propagating request cancellation to
  the database driver or routing expensive work through a separately limited pool. The
  installed Kysely/`pg` query contract does not expose an `AbortSignal`, so racing the
  promise would abandon only the HTTP response while the database keeps working. Real
  cancellation would need to retain the query connection's PostgreSQL backend PID and
  call `pg_cancel_backend` from a separate control connection, or add driver-level abort
  support. The recommended production combination is a per-query timeout first, then
  verified database cancellation when the HTTP connection closes.
- **Rate limits:** start with 60 search requests per 10 seconds and 120 reverse requests
  per minute per API key, but only 30 radius requests per minute because radius queries
  are more expensive. Enforce this in a shared gateway/store when running more than one
  replica; in-memory per-process counters are only suitable for local evaluation.

## Testing

Integration tests run against the real ingested Postgres, not mocks — mocking Kysely
would mean re-encoding the same PostGIS assumptions being tested. Two of the three bugs
above were caught this way: a test failed against real data where manual curl testing
had already "passed." Trade-off: no fully isolated unit-test path for the repository
layer, by design.

## Known Limitations

- No street-level address parsing (dataset is ZIP/city/state-level only).
- Reverse lookup has no maximum-distance confidence threshold yet, so it can return a
  technically nearest but operationally irrelevant point for remote coordinates.
- Cursor pages are stateless and do not hold a database snapshot across HTTP requests.
  An atomic dataset refresh between pages can change later results; refreshes are rare,
  and the trade-off avoids keeping transactions and connections open for clients.
- Ranking is trigram similarity only — exact matches in one state can outrank a more
  relevant result elsewhere, and a short query can rank a long prefix match below an
  unrelated short name. A weighted/boosted ranking would fix both; out of scope here.
- Full US state names aren't recognized in `"City, State"` input, only 2-letter codes.
- Connection pool size is hardcoded, not env-configurable.
- **Reverse lookup finds the nearest ZIP _centroid_, not the ZIP whose real (irregular)
  boundary actually contains the point.** The dataset has no boundary polygons, only
  one lat/lng per ZIP, so this is a nearest-point search, not point-in-polygon. Near a
  border between two unevenly-sized ZIPs, the true containing ZIP and the
  nearest-centroid ZIP can differ. Would need boundary polygon data (e.g. Census
  TIGER/Line ZCTA shapefiles) to fix — a different, larger dataset than GeoNames.
- **509 of 41,488 rows (~1.2%) are military/diplomatic ZIPs (APO/FPO/DPO)** with empty
  `state_code`/`state_name` — GeoNames fills these with `""`, not `null`, unlike
  `county` which is already nullable. Left as-is: they're real, useful ZIPs (removing
  them would make reverse lookup give worse answers near overseas military
  installations), but normalizing `""` → `null` for consistency is a cheap follow-up
  (see Next Steps).

## Next Steps

- Automated idempotency test for ingestion (today it's verified by hand).
- State-name-to-code mapping for forward search.
- Prefix-aware ranking so short queries don't bury long, relevant matches.
- `Dockerfile` + `api` service in `docker-compose.yml` for one-command full-stack spin-up.
- Make the connection pool size configurable; enable rate limiting by default for real deployment.
- Normalize empty-string `state_code`/`state_name` to `null` for military/diplomatic ZIPs.

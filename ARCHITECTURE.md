# Architecture

A running design log, grown one section at a time alongside the code. For _what_ is
being built, see [SPEC.md](./SPEC.md) — this doc covers _why_, and what was rejected.

## Overview

`index.ts` boots the server and owns process lifecycle (listen, graceful shutdown).
`src/app.ts` wires the middleware stack: `helmet` → request-id → logging → `cors` →
JSON body → router → 404 → error handler. The locations router adds optional rate
limiting before its endpoints. Every request carries an `x-request-id`, echoed in the
response header and in every log line for that request.

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

`scripts/ingest.ts` treats each CSV as the complete authoritative snapshot. After
validation it opens one transaction, creates a temporary staging table, and loads it in
batches of 500. A comparison against `zip_codes` produces real
inserted/updated/unchanged/deleted counts; changed rows are upserted and rows absent from
staging are deleted.

Staging, merge, and deletion execute on one connection inside that transaction. Readers
continue seeing the previous committed snapshot until the new one commits; any failure
rolls back the complete publication. For this ~41k-row dataset, the bounded transaction
is an acceptable trade-off. A much larger dataset should use bulk loading into persistent
run-scoped staging followed by a shorter publication transaction.

The complete file is parsed and validated before `BEGIN`; malformed source data cannot
publish even one batch. Headers must be exactly `zip_code`, `city`, `state_code`,
`state_name`, `county`, `latitude`, and `longitude` (order is flexible). ZIPs must remain
5-digit strings; city, state name, and county are capped at 150 characters; coordinates
must be finite and inside their geographic ranges; and state code/name must be jointly
present. Empty state fields are accepted only for the source's APO/FPO/DPO records. Blank
counties normalize to `NULL`. Validation scans every row, logs the total issue count and
the first 20 details, then fails the run as one unit.

- **Idempotent**, verified: run #1 inserts 41,488 rows; run #2 reports zero inserts,
  updates, or deletes and 41,488 unchanged.
- **Source changes** reconcile completely — `zip_code` is the natural key, and rows absent
  from the next validated snapshot are hard-deleted. There are no downstream foreign keys
  or history requirements that would justify soft deletes in this read-only directory.
- **Duplicates are classified before persistence.** Rows that are equivalent after the
  documented normalization collapse and are counted. Two different records claiming the
  same ZIP fail validation because silently choosing first or last would hide an ambiguous
  source change.
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
City relevance is intentionally small and explicit: exact match, then literal prefix,
then trigram match; similarity and `(city, state_code, zip_code)` provide stable
tie-breakers. PostgreSQL already supplies the required matching and index support, so a
separate search engine would add operational cost without a demonstrated need.
For one- and two-character city queries, only literal prefix matching is used and
results sort by city/state/ZIP; trigram matching and similarity start at three characters,
where they become useful. Numeric ZIP prefixes still work from one digit.

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

- **Non-deterministic order.** Searching `"York"` returns many equal-score ties with no
  secondary sort key — order wasn't stable across runs. Fixed with explicit
  relevance and tie-breakers (`exact/prefix/fuzzy`, similarity, city, state, ZIP).
- **Wrong-city false positive.** `"Springfield, Illinois"` was falling back to
  searching for a city literally named `"Illinois"`, and confidently returning
  `"Illinois City"`. Fixed by falling back to the _first_ comma segment instead of the
  last when the state isn't a recognized 2-letter code.
- **Short queries returned nothing.** `similarity("Beverly", "Be") = 0.22`, below
  `pg_trgm`'s 0.3 threshold — so `q="Be"` excluded `"Beverly"` entirely, and `q="B"`
  (3,086 matching cities) returned zero. Trigram similarity needs more text than the
  first keystroke gives it. Fixed by using prefix-only search for one or two characters,
  then `city ILIKE q||'%' OR city % q` from three characters onward. Prefix covers early
  typing, similarity still covers typos. Both use the same GIN index (confirmed with
  `EXPLAIN ANALYZE`, no new index needed).
- **Similarity alone ranked the wrong intent.** A short fuzzy match could outrank an
  exact city or a longer autocomplete prefix. Fixed by placing exact and prefix matches
  into explicit tiers before applying trigram similarity within each tier.

## Non-Functional Notes

- **Indexes verified, not assumed.** `EXPLAIN ANALYZE` before and after: ZIP prefix
  search went `Seq Scan` (29ms) → `Index Scan` (3.9ms) once a `text_pattern_ops` index
  was added (this DB's `en_US.utf8` collation can't use a plain btree for `LIKE`).
- **Short city queries avoid premature fuzzy work.** `q=B` now performs one bitmap scan
  on `zip_codes_city_trgm_idx`, followed by a 25kB top-N sort over 3,086 prefix matches;
  removing the redundant trigram-similarity branch reduced the observed local execution
  from ~52ms to ~30ms. `q=Be` completed in ~7ms. These Docker/emulation timings are
  directional, while the plan shape is the durable result.
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
- **Rate limiting is implemented and tested, but off by default.** One per-IP policy
  covers every `/v1/locations` endpoint; `/health` is outside that router and never
  consumes location quota. The suggested starting point is 60 requests per minute.
  Enabling it requires the two paired variables in `.env.example`; a custom handler
  preserves the API's JSON error contract for `429` responses.
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
- **Distributed rate limits:** the current in-memory counter is appropriate for this
  single-instance assessment. Multiple API replicas should enforce the same policy in a
  shared gateway or store; adding Redis here without that deployment need would be
  premature.

## Testing

Integration tests run against the real ingested Postgres, not mocks — mocking Kysely
would mean re-encoding the same PostGIS assumptions being tested. Two of the three bugs
above were caught this way: a test failed against real data where manual curl testing
had already "passed." Trade-off: no fully isolated unit-test path for the repository
layer, by design.

Ingestion idempotency is also tested against real PostgreSQL in an isolated schema. The
test verifies the first insert, a second unchanged run, a single-row update, final row
counts, and multi-batch behavior without mutating the API test dataset.

Source validation has a separate unit suite for header drift, numeric/range failures,
leading-zero ZIPs, military/diplomatic exceptions, and identical versus conflicting
duplicates. A transaction-boundary test additionally proves invalid CSV never issues
`BEGIN`.

Snapshot reconciliation is tested against PostgreSQL for inserts, updates, unchanged
rows, hard deletes, repeat-run idempotency, and rollback when deletion fails.

## Known Limitations

- No street-level address parsing (dataset is ZIP/city/state-level only).
- Ingestion assumes each validated CSV is a complete trusted snapshot. A syntactically
  valid but incomplete source would remove absent ZIPs; production automation should add
  source-level completeness checks if that failure mode becomes credible.
- Reverse lookup has no maximum-distance confidence threshold yet, so it can return a
  technically nearest but operationally irrelevant point for remote coordinates.
- Cursor pages are stateless and do not hold a database snapshot across HTTP requests.
  An atomic dataset refresh between pages can change later results; refreshes are rare,
  and the trade-off avoids keeping transactions and connections open for clients.
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

- State-name-to-code mapping for forward search.
- `Dockerfile` + `api` service in `docker-compose.yml` for one-command full-stack spin-up.
- Make the connection pool size configurable; configure rate limiting at deployment.
- Normalize empty-string `state_code`/`state_name` to `null` for military/diplomatic ZIPs.

# Architecture

A running design log, grown one section at a time alongside the code. For _what_ is
being built, see [SPEC.md](./SPEC.md) — this doc covers _why_, and what was rejected.

## Overview

`index.ts` boots the server and owns process lifecycle (listen, graceful shutdown).
`src/app.ts` wires the middleware stack: `helmet` → request-id → logging → `cors` →
JSON body → router → 404 → error handler. The locations router adds the configured rate
limit before its endpoints. Every request carries an `x-request-id`, echoed in the
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

## Decision Summary

| Decision                                                          | Why                                                                                                      | Accepted trade-off                                                                                             |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Express 5 + TypeScript                                            | Familiar, maintainable request plumbing with a mature middleware ecosystem.                              | Fastify could provide higher framework throughput, but framework overhead is not the measured bottleneck here. |
| PostgreSQL + PostGIS + `pg_trgm`                                  | One database supports geodesic lookup, radius filtering, ZIP prefixes, and fuzzy city search.            | Requires Postgres extensions and spatial SQL knowledge.                                                        |
| One denormalized `zip_codes` table                                | A ZIP record is the read model; normalization would add joins without useful integrity for this dataset. | Repeated city/state text is accepted in a small reference dataset.                                             |
| Kysely instead of a full ORM                                      | Keeps ordinary queries typed while allowing first-class PostGIS SQL.                                     | Spatial expressions are manually written and need real-database tests.                                         |
| Generated `location` geography column                             | Latitude, longitude, and the indexed spatial point cannot drift apart.                                   | PostgreSQL owns part of the data model rather than application code.                                           |
| Complete-snapshot ingestion in one transaction                    | Repeat runs are idempotent and readers never see a partial refresh.                                      | A valid but incomplete source can delete legitimate rows; production refreshes need a completeness policy.     |
| Radius capped at 500 km; pages default to 20 and allow at most 50 | Bounds database work and response size while cursors expose every match inside the accepted radius.      | Clients cannot request a continent-scale radius in one query and must follow cursors for large result sets.    |
| Reverse lookup always returns the nearest point                   | Simple, deterministic contract; `distance_meters` lets clients judge usefulness.                         | Remote coordinates can receive a technically correct but irrelevant result.                                    |
| One in-memory per-IP rate limit                                   | Appropriate and easy to run for a single-instance assessment.                                            | Multiple replicas require a gateway or shared store for a global quota.                                        |

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
- **Rate limiting is implemented, tested, and enabled by the provided configuration.** One per-IP policy
  covers every `/v1/locations` endpoint; `/health` is outside that router and never
  consumes location quota. The starting point is 60 requests per minute.
  Production startup requires the two paired variables to be injected explicitly.
  A custom handler preserves the API's JSON error contract for `429` responses.
- **Proxy trust is explicit.** `TRUST_PROXY_HOPS` defaults to `0`; deployments set it
  only when their known proxy topology overwrites `X-Forwarded-*`. This prevents clients
  connected directly from choosing the IP used by the rate limiter.
- **Search input remains data, not SQL or a LIKE pattern.** Kysely parameterizes all
  values, `%`, `_`, and `\` are rejected at the API boundary, and the repository still
  escapes them defensively. This prevents metacharacter-only input from forcing an
  unindexable full-table scan.
- **Request IDs are bounded before reflection and logging.** Client-provided IDs must use
  a safe character set and contain at most 128 characters; invalid values are replaced
  with a server-generated UUID.
- **Query params are structured in logs** (`req.query`), not just embedded in the URL string.

### Open Production Questions

These do not block the assessment, but they must be answered before a real launch:

- **What are the traffic model and SLOs?** The repository records local load-test results,
  but no product latency target, availability target, burst profile, or capacity margin was
  provided. Those numbers should drive pool size and rate-limit calibration.
- **Should remote reverse matches have a confidence policy?** This implementation always
  returns the nearest point and its distance. Product must decide whether clients own that
  interpretation or whether the API adds `max_distance_km` or a match-quality field.
- **What is the database query budget after HTTP cancellation?** Requests do not yet cancel
  active PostgreSQL work. Start with `statement_timeout`; add verified driver/database
  cancellation on connection close only if load data shows that it is needed.
- **What is the deployment topology?** One instance can use the current in-memory limiter.
  Multiple replicas need a shared gateway/store, an agreed proxy hop count, and a total
  database connection budget.
- **Who owns dataset refreshes?** Define cadence, minimum expected row count/checksum,
  alerting, retention, and rollback. The source URL, download date, record count, and
  license are already recorded in `DATA_LICENSE.md`.
- **Who are the external consumers?** Authentication, an OpenAPI document, compatibility
  guarantees, and deprecation policy depend on whether this is public, partner-facing, or
  internal.

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
  `county` which is nullable. This source representation is preserved deliberately:
  deriving AA/AE/AP from the city label would invent data not supplied in those fields,
  while changing them to `null` would widen the database and API contract without
  improving lookup behavior. Consumers should interpret an empty state as unavailable.

## Next Steps

Before production, prioritize a database statement timeout, source-completeness guard,
deployment/SLO decisions, and an OpenAPI contract for real consumers. Lower-priority
improvements are state-name-to-code mapping, a configurable connection pool, and a
`Dockerfile` + API service for one-command full-stack startup.

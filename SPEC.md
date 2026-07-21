# SPEC: US ZIP Geocoding API

**Status:** Assessment contract implemented. Product and deployment questions remain in
[ARCHITECTURE.md](ARCHITECTURE.md#open-production-questions).
**Version:** 1.0
**Last updated:** 2026-07-20

## Problem Statement

Build a backend service that turns a public US ZIP code dataset into a geocoding API:
forward search (partial address/city/ZIP → matching locations), reverse lookup
(lat/lng → nearest location), and radius search (lat/lng + distance → all locations in
range). Evaluated on architecture decisions, API design, data modeling, and
production-mindedness — not feature volume.

## Goals

- Three working endpoints (search, reverse, radius) with external-consumption-grade
  error handling and status codes.
- Repeatable, idempotent, observable data ingestion.
- Documented performance/scalability reasoning, not just working code.
- A codebase another senior engineer could pick up cold.

## Non-Goals (out of scope)

- Authentication / authorization.
- Countries other than the US.
- A UI/frontend.
- Write endpoints (create/update/delete locations) — the dataset is read-only reference data.
- Full OpenAPI document (not required for the assessment; recommended before external
  client integration).

## Data Ingestion Contract

- Input is a CSV with exactly these headers, in any order: `zip_code`, `city`,
  `state_code`, `state_name`, `county`, `latitude`, `longitude`.
- Validate the whole source before opening the write transaction. On failure, report the
  total number of issues and retain at most the first 20 structured details.
- ZIP is exactly five digits; city is required; coordinates are finite and within
  latitude `[-90, 90]` and longitude `[-180, 180]`. City, state name, and county have a
  maximum length of 150 characters; a present state code is exactly two letters.
- State code and name are jointly present. Both may be empty only for APO/FPO/DPO rows.
  Blank county is stored as `NULL`.
- Identical duplicate ZIP rows collapse and are counted. Conflicting records for one ZIP
  reject the complete source.
- Treat the validated CSV as the complete authoritative snapshot. Load it through
  temporary staging, upsert new/changed rows, and hard-delete records absent from the
  source in one transaction. Re-running the same source makes no data changes.

## Functional Requirements

### 1. Forward search — `GET /v1/locations/search`

| Param   | Required | Type   | Constraints                       |
| ------- | -------- | ------ | --------------------------------- |
| `q`     | yes      | string | 1–100 chars; no `%`, `_`, or `\\` |
| `limit` | no       | int    | 1–50, default 10                  |

Behavior (not a street-address parser — see ARCHITECTURE.md for why):

- `q` matching `^\d{1,5}$` → prefix match against `zip_code`.
- otherwise, if a 5-digit ZIP appears anywhere in `q` (e.g. embedded in a full address)
  → prefix match against that `zip_code`.
- otherwise → fuzzy match against `city`, scoped by state if the last comma-separated
  segment of `q` looks like a 2-letter state code (e.g. `"Beverly Hills, CA"` or
  `"123 Main St, Beverly Hills, CA"` both resolve to city `"Beverly Hills"` / state `CA`).
- One- and two-character city queries use prefix matching only. Fuzzy/trigram matching
  starts at three characters. Numeric ZIP prefixes remain valid from one digit.
- City results rank exact matches first, literal prefixes second, and other trigram
  matches third. Similarity descending, city, state code, and ZIP provide deterministic
  ordering inside those tiers.

Response `200`:

```json
{
    "status": 200,
    "message": "success",
    "data": [
        {
            "zip_code": "90210",
            "city": "Beverly Hills",
            "state_code": "CA",
            "state_name": "California",
            "county": "Los Angeles",
            "latitude": 34.0901,
            "longitude": -118.4065
        }
    ]
}
```

No matches → `200` with `data: []` (a search returning nothing is not an error).
Invalid/missing `q` → `400`.

### 2. Reverse lookup — `GET /v1/locations/reverse`

| Param   | Required | Type  | Constraints     |
| ------- | -------- | ----- | --------------- |
| `lat`   | yes      | float | -90..90         |
| `lng`   | yes      | float | -180..180       |
| `limit` | no       | int   | 1–20, default 1 |

Response `200`: array ordered by distance ascending, each row includes `distance_meters`.
Invalid/missing `lat`/`lng` → `400`.

### 3. Radius search — `GET /v1/locations/radius`

| Param       | Required | Type   | Constraints                          |
| ----------- | -------- | ------ | ------------------------------------ |
| `lat`       | yes      | float  | -90..90                              |
| `lng`       | yes      | float  | -180..180                            |
| `radius_km` | yes      | float  | >0, capped at 500                    |
| `limit`     | no       | int    | 1–50, default 20                     |
| `cursor`    | no       | string | Opaque cursor from the previous page |

Response `200`: array ordered by `distance_meters`, then `zip_code`; each row includes
`distance_meters`. The `meta` object indicates whether another page exists:

```json
{
    "status": 200,
    "message": "success",
    "data": [],
    "meta": {
        "limit": 20,
        "has_more": true,
        "next_cursor": "eyJ2ZXJzaW9uIjoxLC4uLn0"
    }
}
```

Pass `next_cursor` unchanged as the next request's `cursor`. The cursor is tied to the
original `lat`, `lng`, and `radius_km`; reusing it with different parameters or sending
a malformed cursor returns `400`. The final page has `has_more: false` and
`next_cursor: null`. Across all pages, the client can retrieve every matching location.
Zero matches → `200` with `data: []` and no next cursor.

### Error shape (all endpoints)

```json
{
    "status": 400,
    "code": "BadRequestError",
    "message": "Validation failed",
    "details": [{ "field": "lat", "error": "Number must be >= -90" }]
}
```

`500` responses never leak stack traces or internal messages in production.

With the provided configuration, all `/v1/locations` endpoints share one per-IP quota and
return `429` with `code: "RateLimitExceeded"` when it is exhausted. `/v1/health` is not
rate-limited. `.env.example` enables 60 requests per minute locally; production requires
the same two variables to be configured explicitly.

## Non-Functional Requirements (acceptance criteria)

- **Performance**: `search` (autocomplete-shaped) must be index-backed (GIN/pg_trgm), not
  a sequential scan — verified via `EXPLAIN ANALYZE` during Stage 4.
- **Scalability**: API is stateless (horizontally scalable); DB connection pool is the
  documented bottleneck under load. Caching is documented as a next step, not built now.
- **Observability**: every request logged (method, path, status, duration, request-id);
  request-id echoed in response headers after safe-character/128-character validation;
  `/health` reports DB connectivity.
- **Error handling**: 400 (validation) vs 404 (single-resource not found, if any) vs 500
  (internal) are always distinguishable, both by status code and by `code` field.
- **Rate limiting**: one per-IP limiter for location endpoints, with standard
  headers and a JSON `429` response; no distributed store is required for this assessment.
- **Testing**: critical-path coverage for the 3 endpoints + ingestion idempotency.
  Decided (see ARCHITECTURE.md): Vitest + Supertest integration tests against the real
  ingested Postgres, not mocks — remaining endpoints follow the same approach.

## Data Source

GeoNames `US.zip` (`download.geonames.org/export/zip/US.zip`), CC BY 4.0, no signup.
41,489 rows, 2 duplicate ZIPs (military bases), verified by direct download this session.
Converted to `data/us_zip_codes.csv` (`zip_code,city,state_code,state_name,county,latitude,longitude`),
committed to the repo so setup works cold with no network dependency at ingest time.

## Locked Decisions

_(rationale for each lives in `ARCHITECTURE.md` — this list is reference only)_

- Stack (constraint from the assessment): Node.js + TypeScript
- Framework: Express 5
- Database: PostgreSQL + PostGIS
- Query layer: Kysely (no ORM)
- Data model: single denormalized `zip_codes` table
- Data source: GeoNames `US.zip`

## Definition of Done

- All 3 endpoints working against the real ingested dataset, verified via curl.
- `README.md` lets a new engineer go from `git clone` to a working local API cold.
- `ARCHITECTURE.md` documents every decision above with its trade-off and rejected alternatives.
- Ingestion is demonstrably idempotent (running it twice produces zero net changes on the second run).

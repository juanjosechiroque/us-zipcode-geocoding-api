# SPEC: US ZIP Geocoding API

**Status:** Locked — decisions below are closed, not open for re-discussion without an explicit new ask.
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
- Full OpenAPI spec (documented in README as a "next steps" item instead).

## Functional Requirements

### 1. Forward search — `GET /v1/locations/search`

| Param   | Required | Type   | Constraints      |
| ------- | -------- | ------ | ---------------- |
| `q`     | yes      | string | 1–100 chars      |
| `limit` | no       | int    | 1–50, default 10 |

Behavior:

- `q` matching `^\d{1,5}$` → prefix match against `zip_code`.
- otherwise → fuzzy/prefix match against `city` (optionally scoped by state if `q` looks like "City, ST").

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

| Param       | Required | Type  | Constraints       |
| ----------- | -------- | ----- | ----------------- |
| `lat`       | yes      | float | -90..90           |
| `lng`       | yes      | float | -180..180         |
| `radius_km` | yes      | float | >0, capped at 500 |
| `limit`     | no       | int   | 1–200, default 50 |

Response `200`: array ordered by distance ascending, each row includes `distance_meters`.
Zero matches → `200` with `data: []`. Invalid params (missing/out of range, `radius_km` > cap) → `400`.

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

## Non-Functional Requirements (acceptance criteria)

- **Performance**: `search` (autocomplete-shaped) must be index-backed (GIN/pg_trgm), not
  a sequential scan — verified via `EXPLAIN ANALYZE` during Stage 4.
- **Scalability**: API is stateless (horizontally scalable); DB connection pool is the
  documented bottleneck under load. Caching is documented as a next step, not built now.
- **Observability**: every request logged (method, path, status, duration, request-id);
  request-id echoed in response headers; `/health` reports DB connectivity.
- **Error handling**: 400 (validation) vs 404 (single-resource not found, if any) vs 500
  (internal) are always distinguishable, both by status code and by `code` field.
- **Testing**: critical-path coverage for the 3 endpoints + ingestion idempotency —
  strategy to be decided in Stage 5, not now.

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

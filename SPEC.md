# API Contract

- **Status:** Implemented
- **Version:** 1.0
- **Last updated:** 2026-07-21

## Scope

The service exposes US ZIP-code forward search, nearest-location lookup, and radius
search. Results represent GeoNames postal-code records with city/state labels and one
representative coordinate.

Authentication, write endpoints, other countries, a UI, and an OpenAPI document are
outside this assessment.

## Data Ingestion Contract

- Input is a CSV with these headers in any order: `zip_code`, `city`, `state_code`,
  `state_name`, `county`, `latitude`, `longitude`.
- The complete file is validated before the write transaction. Failures report the total
  issue count and at most the first 20 details.
- ZIP is exactly five digits; city is required and at most 150 characters. State name
  and county are at most 150 characters; a present state code is exactly two letters.
  Coordinates must be finite and within latitude `[-90, 90]` and longitude `[-180, 180]`.
- State code and name must be present together. Both may be empty only for APO/FPO/DPO
  rows. Blank county is stored as `NULL`.
- Equivalent duplicate ZIP rows collapse; conflicting duplicates reject the source.
- The CSV is authoritative. Staging, upserts, and deletion of absent ZIPs occur in one
  transaction. Re-running the same source makes no data changes.

## Common Response

Successful location endpoints return:

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

`county` may be `null`; military/diplomatic records may have empty state fields.
Reverse and radius results additionally include `distance_meters`. A collection with no
matches returns `200` with `data: []`.

## Forward Search

`GET /v1/locations/search`

| Parameter | Required | Constraints                                           |
| --------- | -------- | ----------------------------------------------------- |
| `q`       | yes      | Trimmed string, 1–100 characters; no `%`, `_`, or `\` |
| `limit`   | no       | Integer 1–50; default 10                              |

Matching rules:

- One to five digits: ZIP-prefix search.
- A five-digit ZIP inside a longer input: search by that ZIP.
- Otherwise: city search, optionally scoped by a final two-letter state code.
- One- and two-character cities use prefix matching. From three characters, prefix and
  trigram matching are combined.
- City results rank exact, prefix, then fuzzy matches with deterministic tie-breakers.

## Reverse Lookup

`GET /v1/locations/reverse`

| Parameter | Required | Constraints                    |
| --------- | -------- | ------------------------------ |
| `lat`     | yes      | Finite number from -90 to 90   |
| `lng`     | yes      | Finite number from -180 to 180 |
| `limit`   | no       | Integer 1–20; default 1        |

Results are ordered by distance ascending. The service always returns the nearest known
point(s); it does not apply a maximum-distance threshold.

## Radius Search

`GET /v1/locations/radius`

| Parameter   | Required | Constraints                           |
| ----------- | -------- | ------------------------------------- |
| `lat`       | yes      | Finite number from -90 to 90          |
| `lng`       | yes      | Finite number from -180 to 180        |
| `radius_km` | yes      | Number greater than 0 and at most 500 |
| `limit`     | no       | Integer 1–50; default 20              |
| `cursor`    | no       | Opaque string, 1–1,024 characters     |

Results are ordered by `distance_meters`, then `zip_code`. Responses include:

```json
{
    "meta": {
        "limit": 20,
        "has_more": true,
        "next_cursor": "eyJ2ZXJzaW9uIjoxLC4uLn0"
    }
}
```

Pass `next_cursor` unchanged to retrieve the next page. It is tied to the original
coordinates and radius; malformed or mismatched cursors return `400`. The final page has
`has_more: false` and `next_cursor: null`.

## Health

`GET /v1/health` returns `200` when PostgreSQL is reachable and `503` when it is degraded.
It is not rate-limited.

## Errors and Rate Limiting

Validation errors use this shape:

```json
{
    "status": 400,
    "code": "BadRequestError",
    "message": "Validation failed",
    "details": [{ "field": "lat", "error": "Invalid value" }]
}
```

- Invalid inputs return `400`.
- Unknown routes return `404` with `code: "NotFoundError"`.
- Exceeded location quota returns `429` with `code: "RateLimitExceeded"`.
- Unexpected failures return `500`; production responses do not expose internal details.

The provided configuration applies one in-memory per-IP quota of 60 requests per minute
across `/v1/locations`. Production requires both rate-limit variables explicitly.

## Non-Functional Guarantees

- ZIP prefix, city trigram, reverse KNN, and radius queries use the intended indexes.
- The API is stateless; PostgreSQL and its bounded connection pool are the main shared
  capacity constraint.
- Business requests and failures emit structured logs with status, duration, query, and
  validated request ID. Successful health probes are intentionally silent.
- Critical endpoint and ingestion paths are tested with Vitest and Supertest against real
  PostGIS. CI runs migration, ingestion, lint, typecheck, build, and the full suite.

## Data Source

The committed CSV contains 41,488 GeoNames records. Source URL, download date,
transformation, record count, and license are maintained in
[DATA_LICENSE.md](DATA_LICENSE.md).

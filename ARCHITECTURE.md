# Architecture

This document explains the implementation decisions and their costs. The API contract
lives in [SPEC.md](SPEC.md).

## System Design

The request path is:

```text
Express router → validation → controller → service → Kysely repository → PostgreSQL
```

`src/app.ts` configures security headers, request IDs, structured logging, CORS, request
size limits, routing, 404 handling, and centralized errors. `index.ts` owns startup and
graceful shutdown. The API is stateless; PostgreSQL is its only persistent dependency.

## Domain

A location is a GeoNames US postal-code record with a city/state label and one
representative coordinate. Forward search works at ZIP/locality level; reverse and radius
search compare those points using geodesic distance.

## Decisions and Trade-offs

| Decision                                 | Reason                                                       | Accepted cost                                      |
| ---------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| Express 5 + TypeScript                   | Familiar request lifecycle and middleware ecosystem          | Fastify may have higher framework throughput       |
| PostgreSQL + PostGIS + `pg_trgm`         | One database supports spatial and fuzzy search               | Requires extensions and spatial SQL knowledge      |
| One denormalized `zip_codes` table       | The ZIP record is the read model; joins add little integrity | City/state text is repeated                        |
| Kysely                                   | Typed queries with first-class PostGIS SQL                   | Spatial expressions remain hand-written            |
| Generated `location` column              | Indexed geography cannot drift from latitude/longitude       | Part of the model is PostgreSQL-specific           |
| Atomic complete-snapshot ingestion       | Idempotent refreshes with no partial publication             | A valid but incomplete source could delete records |
| Radius max 500 km; cursor pages 20/50    | Bounds query and response cost while exposing every match    | Large result sets require multiple requests        |
| Reverse always returns the nearest point | Simple contract with distance for client judgment            | Remote coordinates may receive an irrelevant match |
| In-memory rate limit                     | Enough for a single-instance assessment                      | Replicas require shared enforcement                |

## Data Ingestion

The full CSV is validated before any write. Inside one transaction, 500-row batches are
staged, compared with current data, and published through upserts and deletes. Invalid
input or publication errors leave the previous snapshot unchanged.

Validation covers structure, ZIPs, coordinates, field lengths, state consistency, and
duplicates. Repeat runs are idempotent, conflicting duplicates fail, and an advisory lock
prevents concurrent refreshes. In Docker, the one-shot `db-setup` job must finish before
the API starts.

## Query Strategy

| Operation | Strategy                                                                               |
| --------- | -------------------------------------------------------------------------------------- |
| Forward   | Indexed ZIP prefix; city prefix for 1–2 characters; prefix + trigram from 3 characters |
| Reverse   | GiST KNN search, always returning the nearest point with `distance_meters`             |
| Radius    | `ST_DWithin` filter with keyset cursor ordered by distance and ZIP                     |

Forward results rank exact, prefix, then fuzzy matches with stable tie-breakers. A
five-digit ZIP embedded in the input resolves through that ZIP. `%`, `_`, and `\` are
rejected at validation and escaped again in the repository.

Radius results are capped at 500 km and paginated 20 by default, 50 at most. The opaque
Base64 cursor stores the last position and original query parameters; malformed or
mismatched cursors return `400`.

## Operational Notes

- Query plans were checked with `EXPLAIN ANALYZE` and use the intended indexes.
- Local runs at 100 and 300 concurrent requests completed without errors.
- The 10-connection pool queues excess work; production sizing depends on replicas and
  the database connection budget.
- Structured logs include status, duration, query, and request ID. Successful health
  probes are silent; failures remain visible.
- Inputs are bounded, SQL is parameterized, errors use stable JSON shapes, and production
  `500` responses hide internal messages.
- The in-memory rate limiter is suitable for one API instance, not a distributed quota.

## Testing

Integration tests use the real PostGIS database so spatial SQL and index assumptions are
not recreated in mocks. Unit tests cover parsing, validation, cursors, ranking decisions,
middleware, and error behavior. Ingestion tests use an isolated PostgreSQL schema and
verify idempotency, multi-batch publication, reconciliation, and rollback. CI performs
migration, ingestion, lint, typecheck, build, and the full suite.

## Known Limitations

- Search uses the ZIP/city/state fields supplied by GeoNames.
- Reverse results use point proximity rather than boundary containment.
- Reverse lookup can return a distant result because it has no confidence threshold.
- Cursor pages do not share a database snapshot across a dataset refresh.
- Full state names are not recognized in `City, State`; two-letter codes are.
- A syntactically valid but incomplete snapshot could delete valid rows; production needs
  a minimum-count/checksum policy and rollback plan.
- Pool size is fixed at 10 and the rate limiter is local to one process.
- Active PostgreSQL work is not cancelled when the HTTP client disconnects, and no
  `statement_timeout` is configured.
- Military/diplomatic rows preserve the source's empty state fields rather than inventing
  AA/AE/AP values or widening the API fields to nullable.

## Before Production

Product and infrastructure owners still need to define:

- traffic profile, latency/availability SLOs, and pool/rate-limit capacity;
- reverse-match confidence policy;
- dataset refresh cadence, completeness checks, retention, and rollback;
- single- versus multi-replica deployment and trusted proxy topology;
- authentication, OpenAPI/versioning, and deprecation policy for actual consumers;
- database statement timeout and whether disconnect-driven cancellation is necessary.

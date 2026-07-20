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

`BadRequestError` / `NotFoundError` (in `src/errors.ts`) are plain factories that
attach `statusCode`/`code` to a real `Error`, not a class hierarchy — enough to
distinguish 400 vs 404 vs 500 without ceremony. Rejected alternative: per-route
try/catch with inline `res.status().json()` calls, which is exactly what tends to
drift out of sync across a codebase and produce inconsistent error shapes.

### Response envelope: `{ status, message, data }` on success, `{ status, code, message, details? }` on error

Chosen so a client can always branch on `status` without inspecting a nested error
object first. Kept intentionally asymmetric (success has no `code`) since a 2xx
response has no error category to report.

## Data Model

_Added in Stage 2._

## API Design

_Added in Stage 4._

## Non-Functional Notes

_Performance, scalability, and observability reasoning — added as each concern is
addressed in its corresponding stage._

## Known Limitations

_Added progressively, finalized in Stage 6._

## Next Steps

_Added progressively, finalized in Stage 6._

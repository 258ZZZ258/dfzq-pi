# Run reconciliation

`POST /runs/lookup` is a read-only internal operation. Production requires both `X-Internal-Token` and the Java signed grant with `run:read`. Send the original `/runs` request body; retain whether `sessionId` was supplied or server-derived.

The lookup key is hashed with the grant's tenant and user, exactly as submission does. The endpoint verifies principal, session, task and stable grant scope, then compares the original input, constrained filters, client options and payload. Server-owned options are not accepted from the caller. Refreshed grant IDs/expiry do not change scope identity. JSON object key order does not matter; array order and values do. Transport fields such as `waitMs` are not execution identity.

Successful response:

```json
{"runId":"existing-run-id","status":"running","clientRequestId":"original-request-key"}
```

- `200`: exact matching persisted request found. Poll `/runs/{runId}` for the result.
- `404`: no row found. This does **not** authorize a new submission: retention, previous failures, or another deployment may explain absence.
- `409`: the key exists with different input or authorization scope. Do not adopt that run.
- `401` / `503`: invalid token / unconfigured internal boundary.
- `403`: principal, action or grant scope is not authorized.
- `400` / `422`: malformed JSON / invalid request structure.

The operation does not call `RunManager.submit`, assemble a runtime, allocate a model session, or return the stored business payload. Both SQLite test storage and PostgreSQL storage implement request-key lookup. No retention period guarantee is added by this endpoint.

Regression command from `packages/task-runtime`:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/run-lookup.test.ts test/server-routes.test.ts
```

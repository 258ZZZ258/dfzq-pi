# Run reconciliation

`POST /runs/lookup` is a read-only internal operation. It requires the same `X-Internal-Token` as other run endpoints and accepts the original `/runs` request body, including an explicit `sessionId`.

The endpoint finds the persisted run by `clientRequestId`, then compares `taskKind`, `sessionId`, `input`, `filters`, `options`, and `payload`. JSON object key order does not matter; array order and values do. Transport fields such as `waitMs` are not execution identity.

Successful response:

```json
{"runId":"existing-run-id","status":"running","clientRequestId":"original-request-key"}
```

- `200`: exact matching persisted request found. Poll `/runs/{runId}` for the result.
- `404`: no row found. This does **not** authorize a new submission: retention, previous failures, or another deployment may explain absence.
- `409`: the key exists with different input or authorization scope. Do not adopt that run.
- `401` / `503`: invalid token / unconfigured internal boundary.
- `400` / `422`: malformed JSON / invalid request structure.

The operation does not call `RunManager.submit`, assemble a runtime, allocate a model session, or return the stored business payload. Both SQLite test storage and PostgreSQL storage implement request-key lookup. No retention period guarantee is added by this endpoint.

Regression command from `packages/task-runtime`:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/run-lookup.test.ts test/server-routes.test.ts
```

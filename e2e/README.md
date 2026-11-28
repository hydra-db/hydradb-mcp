# End-to-end suite

The unit tests in `tests/` replace the SDK or the HTTP layer with fakes, so they assert the request their author believed in. This suite drives the real server process instead, the way an MCP host does, and reads back what it wrote. It exists because two bugs shipped past the unit tests: a knowledge ingest the API refused on every call, and a listing that cut stored metadata at 150 characters.

It has two tiers.

## Live tier

Runs the server against a real HydraDB API (staging in CI) and skips unless `HYDRADB_E2E=1`.

- It spawns the server over stdio and speaks MCP to it with the SDK client, plus one pass over the HTTP transport with header auth.
- It creates one throwaway database through `hydradb_database_create`, named `e2e-mcp-<utc yyyymmddhhmmss>-<4 letters>`, and deletes it at the end, also when scenarios fail.
- It seeds every item first, polls `hydradb_status` once until every id is terminal, then runs the read scenarios.
- Each scenario reads back what was written, whole: stored content, every metadata key and value, the ids, in both the text and `structuredContent`.
- `completeness.tools` fails when a tool in `tools/list` has no scenario.
- Connector tools that change things outside the test database run only against a connector id that does not exist.
- The `acl.*` scenarios seed three app items in a collection of their own (`e2e-acl`), so one read of that collection's relations holds all of them: one with no access list, one restricted to `user_email:alice@e2e.hydradb.test`, one `__private__`. Every read that takes `acl` (list, query, inspect, subgraph, relations) runs as Alice, as Alice's bare email, as Bob, as `__public__` and with no `acl`, and asserts by id which items come back and that no hidden title or body appears in the text or `structuredContent`. A fourth item restricted to Alice is made public with `hydradb_update`, read as Bob, then put back. `acl.http.list` repeats the list over the HTTP transport. The server has no default principal list in its environment or in an HTTP header, so every scenario passes `acl` per call.

Run it:

```sh
HYDRADB_E2E=1 HYDRADB_E2E_BASE_URL=https://... HYDRADB_E2E_API_KEY=... npm run test:e2e
```

Environment:

- `HYDRADB_E2E`: set to `1` to run the live tier.
- `HYDRADB_E2E_BASE_URL`: the API base URL. Required.
- `HYDRADB_E2E_API_KEY`: the API key. Required.
- `HYDRADB_E2E_DATABASE`: optional. Use this existing database for the data scenarios and never delete it. The database lifecycle scenario still creates and deletes its own.
- `HYDRADB_E2E_RESULTS`: optional. Write the results JSON to this path, also on failure.
- `HYDRADB_E2E_SERVER`: `dist` drives `dist/index.js` and `dist/http.js` (run `npm run build` first); anything else runs `src/` through tsx. CI uses `dist`.

The workflow `.github/workflows/e2e.yml` runs this tier nightly, on demand, and on pull requests from branches of this repository. It reads the `HYDRADB_E2E_API_KEY` secret and the `HYDRADB_E2E_BASE_URL` repository variable, and ends green with a notice when the secret is not set.

## Simulated tier

Runs offline inside `npm test`. `e2e/simulator.ts` listens on 127.0.0.1, records every request, and answers from `e2e/fixtures/staging.json`, which holds real staging answers.

- Every probe in `PROBES` (one tool call that reaches one route) meets every simulated result in `OUTCOMES`: `400`, `401`, `403`, `404`, `429`, `500`, `503`, a connection reset, an answer slower than the server's deadline, a non-JSON `200`, a `200` of `{}`, and a `200` with an empty list.
- Each cell asserts that the failure is reported as `isError` with the status and the server's message, inside a time budget, without the API key, and that an unsafe write is sent exactly once after a `500`, a reset or a timeout. An empty list must be reported as nothing found, not as an error.
- Connector tools replace every API failure with one fixed sentence per class (`hideConnectorFailure` in `src/server.ts`), so their cells check that sentence instead of the status and message.
- The request of every ingest mode, and of `hydradb_update` and `hydradb_feedback`, is checked against the keys the API accepts and must carry the caller's values.
- A recorded page of 50 connector rows is listed through the server and must keep every metadata key in both views.
- Every read that takes `acl` must send the caller's principals exactly, in the body field or the repeated `acl` query parameter the API reads. `hydradb_update` and an app knowledge ingest must send the complete list once.

Run it alone with `npx tsx --test e2e/simulated.test.ts`.

## Known issues

A scenario or cell that fails today because of a product bug asserts the correct behaviour and names its finding: `knownIssue` on a live scenario, an entry in `KNOWN` for a simulated cell. Node reports it as a todo, so the suite stays green. When the bug is fixed the assertion passes, and the suite turns red until the marker is removed.

A live scenario whose failure is an API behaviour the owner has accepted for now carries `skip` as well. It does not run, it is reported as `skip` with the reason, and `completeness.tools` does not count its tools as covered. Delete the `skip` line to run it again.

## Adding a scenario

- A new tool needs a live scenario in `SCENARIOS` in `live.e2e.ts` that lists the tool in `tools` and calls it, or `completeness.tools` fails.
- Seed what the scenario reads in `SEEDS`, not inside the scenario, so the run waits for indexing once.
- Assert ids, counts, stored content, metadata and statuses. Never assert on text a language model wrote.
- A new route belongs in `ROUTES` in `simulator.ts`, and a probe for it in `PROBES` in `simulated.test.ts`.

## Re-recording the fixtures

```sh
HYDRADB_E2E_BASE_URL=https://... HYDRADB_E2E_API_KEY=... npm run e2e:record
```

`record.ts` starts the simulator as a proxy in front of the real API, points the server at it, and drives one good call per route family plus a bad key, a missing id and an invalid body. It creates and deletes its own databases. It redacts the API key, presigned URLs and the API host before writing, and keeps the databases listing to its own database. Review the diff before committing it.

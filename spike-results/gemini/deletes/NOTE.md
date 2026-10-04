# Note on `run.log` in this folder (added 2026-10-04)

`run.log` lines 1-5 (written 2026-10-03 10:33 PM ET) read `body non-empty` and `verify GET 404 undefined`.
Those two words come from a logging bug in the version of `spike/delete-interactions.ts` that ran then, not
from Google:

- it printed `error.status`, but the Interactions API error shape has no `status`; it is
  `{"error":{"message":"Requested entity was not found.","code":"not_found"}}` (PLAN-GAPS 29);
- it called any non-empty body "non-empty", and a successful delete returns `{}`.

What actually came back for all 5 ids is in `results.json` and the `0N-delete.json` / `0N-verify-get.json`
dumps: `DELETE 200` with body `{}`, then `GET 404` with `error.code: "not_found"`.

The script now prints `error.code` and calls `{}` empty. `run.log` is left exactly as it was written (its lines
are the historical record and can't be regenerated without re-sending the deletes).

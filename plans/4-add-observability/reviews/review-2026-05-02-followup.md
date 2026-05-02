# Review 2026-05-02 Follow-up

Scope: uncommitted changes for issue #4 observability dashboard and model metadata.

## Findings

### P2 - Follow-ups after a session mismatch resume the stale requested session

`sendFollowup` validates, records, and resumes with `parent.meta.session_id`.
For resumed runs, `session_id` is prefilled with the requested session, while
`observed_session_id` stores the backend-reported effective session. If a
backend reports a different session after a resume or fork-like fallback, the
dashboard groups the child under the observed session, but another follow-up
from that child will still call `backend.resume(parent.meta.session_id, ...)`
and branch back to the old chat instead of continuing the observed chat.

Affected code:

- `src/orchestratorService.ts:141` rejects follow-up when `session_id` is null
  without considering `observed_session_id`.
- `src/orchestratorService.ts:165` and `src/orchestratorService.ts:166` store
  the next run's requested session from `parent.meta.session_id`.
- `src/orchestratorService.ts:176` resumes `parent.meta.session_id`.

Recommendation: derive a single `resumeSessionId` as
`parent.meta.observed_session_id ?? parent.meta.session_id`, use it for the
follow-up validity check, `requested_session_id`, initial `session_id`, and
the backend resume call. Add a regression test where a parent has
`session_id='session-1'` and `observed_session_id='session-2'`, then assert the
next backend invocation resumes `session-2`.

## Checks

- Read the changed source, tests, docs, AGENTS instructions, and relevant rules.
- Checked local CLI support with `codex exec --help`, `codex exec resume --help`,
  and `claude --help`.
- Ran `pnpm exec tsc --noEmit`.
- Ran `git diff --check`.

## Resolution

Fixed after review. `sendFollowup` now derives the resume target from
`parent.meta.observed_session_id ?? parent.meta.session_id` and uses that value
for validation, `session_id`, `requested_session_id`, and the backend resume
call. The integration test now covers a session mismatch followed by another
follow-up and asserts the second follow-up resumes the observed session.

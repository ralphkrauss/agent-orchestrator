# Merge Commit Review: f632a00

Date: 2026-05-02
Branch: `4-add-observability`
Scope: merge commit `f632a00fb11e1a45d4600e1e79ffc043d6ef04b8`

## Finding

### P2: Dashboard CLI does not apply the daemon version preflight

`src/daemon/daemonCli.ts` uses `ping()` only as a boolean connectivity check
before calling `get_observability_snapshot` for `runs`, `watch`, and
`status --verbose/--json`. This path does not call `checkDaemonVersion`, unlike
the MCP frontend in `src/server.ts`, so an old daemon that still responds to
`ping` but does not expose the new dashboard method can still fail with a stale
method/schema error instead of the structured `DAEMON_VERSION_MISMATCH` restart
hint that the merged main branch introduced.

Relevant locations:

- `src/daemon/daemonCli.ts:98`
- `src/daemon/daemonCli.ts:133`
- `src/daemon/daemonCli.ts:142`
- `src/daemon/daemonCli.ts:280`
- `src/server.ts:95`
- `src/daemonVersion.ts:8`

Suggested fix: have the daemon CLI snapshot path request `ping`, run
`checkDaemonVersion`, and either print a clear mismatch/restart message or
return a snapshot envelope with the mismatch in `error`. Add a daemon CLI
regression test for a ping-responsive stale daemon covering at least `runs` and
`status --verbose`.

Resolution: fixed after review. The dashboard snapshot path now checks
`ping` with `checkDaemonVersion`, falls back to a local store snapshot on
mismatch, and surfaces the structured restart message in the dashboard output.
`src/__tests__/daemonCli.test.ts` covers stale-daemon `runs` and
`status --verbose`.

## Notes

- The conflict resolutions correctly preserve Windows IPC usage through
  `paths.ipc.path` in the daemon CLI and daemon main.
- `processManager.ts` keeps Windows command-shim wrapping and cancellation while
  preserving observability metadata such as `worker_invocation`, model settings,
  and observed backend model/session IDs.
- I did not run the full test suite during this review. The branch had already
  passed `pnpm build` and `pnpm test` after the merge before push.

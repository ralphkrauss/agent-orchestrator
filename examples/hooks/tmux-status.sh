#!/usr/bin/env bash
# Example agent-orchestrator status hook (issue #40).
#
# Reads a v1 orchestrator_status_changed payload from stdin and renames the
# tmux pane that the supervisor was launched in. ASCII state labels are the
# default; set AGENT_ORCHESTRATOR_HOOK_USE_EMOJI=1 in the hook entry's `env`
# block to opt into emoji.
#
# Wire this up in ~/.config/agent-orchestrator/hooks.json with the same
# Claude-parity shell-command shape used in ~/.claude/settings.json:
#
#   {
#     "version": 1,
#     "hooks": {
#       "orchestrator_status_changed": [{
#         "type": "command",
#         "command": "~/.config/agent-orchestrator/hooks/tmux-status.sh",
#         "timeout_ms": 1500
#       }]
#     }
#   }
#
# This example is best-effort: missing tmux, missing display.tmux_pane, or
# unparseable JSON all fall through silently. The orchestrator never blocks
# on hook execution.

set -eu

if ! command -v tmux >/dev/null 2>&1; then
  exit 0
fi

payload="$(cat)"
if [ -z "$payload" ]; then
  exit 0
fi

# Extract fields without bringing in jq as a hard dependency. We use a tiny
# embedded Python because Python is far more universally available than jq on
# the macOS / Linux developer machines this example targets.
read_field() {
  python3 -c '
import json, sys
data = json.loads(sys.stdin.read())
keys = sys.argv[1].split(".")
for k in keys:
    if isinstance(data, dict) and k in data:
        data = data[k]
    else:
        sys.exit(0)
print(data if data is not None else "")
' "$1" <<EOF
$payload
EOF
}

state="$(read_field status.state)"
pane="$(read_field display.tmux_pane)"
label="$(read_field display.base_title)"
[ -n "$pane" ] || exit 0

# ASCII labels by default (Decision 13). Emoji opt-in via env var.
if [ "${AGENT_ORCHESTRATOR_HOOK_USE_EMOJI:-0}" = "1" ]; then
  case "$state" in
    in_progress) marker='⏳' ;;
    waiting_for_user) marker='💬' ;;
    attention) marker='⚠️' ;;
    stale) marker='💤' ;;
    idle) marker='💤' ;;
    *) marker='?' ;;
  esac
else
  case "$state" in
    in_progress) marker='[in_progress]' ;;
    waiting_for_user) marker='[waiting]' ;;
    attention) marker='[attention]' ;;
    stale) marker='[stale]' ;;
    idle) marker='[idle]' ;;
    *) marker="[$state]" ;;
  esac
fi

title="$marker"
[ -n "$label" ] && title="$marker $label"

# Rename the pane the supervisor was launched in. select-pane -T sets the
# pane title, which most tmux configs surface in the status bar.
tmux select-pane -t "$pane" -T "$title" >/dev/null 2>&1 || true

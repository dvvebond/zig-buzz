#!/usr/bin/env bash
# Sourced by the goose and goose-bg just recipes to build shared agent env_args.
# Usage: source scripts/_goose-env.sh <relay> <key> <agents> <heartbeat> <prompt>
# Sets: env_args (bash array), ready for: exec env "${env_args[@]}" <binary>
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
_relay="$1"
_key="$2"
_agents="$3"
_heartbeat="$4"
_prompt="${5:-}"

pnpm --filter @buzz/acp build
pnpm --filter @buzz/cli build
export PATH="${REPO_ROOT}/node_modules/.bin:${PATH}"

env_args=(
    BUZZ_RELAY_URL="$_relay"
    BUZZ_PRIVATE_KEY="$_key"
    BUZZ_ACP_AGENT_COMMAND=goose
    BUZZ_ACP_AGENT_ARGS=acp
    BUZZ_ACP_AGENTS="$_agents"
    GOOSE_MODE=auto
)
[[ -n "$_prompt" ]] && env_args+=(BUZZ_ACP_SYSTEM_PROMPT="$_prompt")
if [[ "$_heartbeat" != "0" ]]; then
    env_args+=(BUZZ_ACP_HEARTBEAT_INTERVAL="$_heartbeat")
fi

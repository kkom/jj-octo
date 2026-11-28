#!/usr/bin/env bash

# Sets the checkout up in a Claude Code cloud session. The environment runs the `trunk` phase
# before the session opens and `tools` in the background, as the next line declares.
# session-start-phases: trunk tools
#
# `init` sets the `jj gh` alias to the released `jj-octo` where the checkout has none, so the
# `jj config set` line points it at the source.

set -euo pipefail

# The environment reads a report from stdout, so progress goes to stderr.
exec 1>&2

case "${1:-}" in
    trunk)
        bun install --frozen-lockfile
        bun src/main.ts init
        jj config set --repo aliases.gh "[\"util\", \"exec\", \"--\", \"bun\", \"${PWD}/src/main.ts\"]"
        ;;
    tools) ;;
    *)
        echo "session-start: unknown phase '${1:-}'" >&2
        exit 1
        ;;
esac

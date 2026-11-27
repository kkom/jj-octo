#!/bin/sh
# The editor's oxc extension starts this as its oxlint. Stock oxlint fails on
# .oxlintrc.jsonc, which names the effecttsgo plugin that only effect-tsgo adds.
# effect-tsgo finds oxlint from the working directory, and the extension starts
# this from wherever the editor runs, so it moves to the repository root first.
# The bin's shebang names node, which mise.toml doesn't install, so bun runs it.
cd "$(dirname "$0")/.." || exit
exec bun ./node_modules/.bin/effect-tsgo oxlint "$@"

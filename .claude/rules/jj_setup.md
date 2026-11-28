# jj in this checkout

## The `jj gh` alias

Here `jj gh` is a jj alias for this repository's own CLI, run from source, so a change to the CLI takes effect in the next command. Set the checkout up once, from its root. `init` sets the alias to the released `jj-octo` where the checkout has none, so the second command points it back at the source. Later runs of `init` keep it:

```
bun src/main.ts init
jj config set --repo aliases.gh "[\"util\", \"exec\", \"--\", \"bun\", \"$PWD/src/main.ts\"]"
```

## Formatting with `jj fix`

`jj fix` reads its tools from the checkout's jj config, which isn't committed. Set them once per checkout:

```
jj config set --repo fix.tools.oxfmt.command '["node_modules/.bin/oxfmt", "--stdin-filepath=$path"]'
jj config set --repo fix.tools.oxfmt.patterns '["glob:\"**/*.{ts,json,jsonc,json5,yaml,yml,md,toml}\""]'
```

oxfmt skips the files that `.oxfmtrc.jsonc` ignores.

## In a Claude Code cloud session

Where the environment runs each checkout's session-start hook, `.claude/hooks/session-start.sh` runs all four commands.

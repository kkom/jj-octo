# Shell commands

## Run commands in their bare form

Don't add `2>&1` or pipe into `tail` or `head`. Claude Code already captures stderr and truncates long output.

That's because `|`, `>` and `&` break allowlist matching and cause permission prompts.

- ❌ `my_command 2>&1 | tail -20`
- ✅ `my_command`

## Read the saved file for long output

Claude Code saves long output to a file and previews the first ~2KB. Where what you need isn't in the preview, read the file at the path shown.

## Read and edit files with the Read, Edit and Write tools

Use them rather than `cat`, `sed` or a script, and find files with Grep and Glob.

That's because conditional rules load only when Claude opens a file they apply to with Read, Edit or Write, never through the shell.

- ❌ `sed -n 40,90p src/db/create.ts`, then a Python script that rewrites it
- ✅ Read `src/db/create.ts`, then Edit it

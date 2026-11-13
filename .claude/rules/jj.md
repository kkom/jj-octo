# jj and stacked pull requests

A stack is a linear chain of jj changes on top of `main`, one pull request per change, each with a bookmark naming its branch and each pull request targeting the one below. Make every change to history through jj, and do all GitHub work with `jj gh` (see `jj_setup.md`).

```
◯ top-change        claude/top
@ edited-change     claude/middle
◯ bottom-change     claude/bottom
◆ main (trunk)
```

## What a good stack looks like

Base every stack on `main`. Split related work into small pull requests, each with one goal and its own tests, each understandable without the ones above it. Start unrelated work as a separate stack with `jj new main`. Reverting upstack changes should leave a working system, unless they are irreversible, like a data migration.

Each pull request is one change, amended in place for as long as it lives. A stack must be a chain: `jj gh` fails on a change with two children, a merge, or a change with no bookmark or several.

## Commands

`jj help <command>` covers the flags.

| Command | What it does |
| --- | --- |
| `jj new main -m "<message>"` | Starts a stack |
| `jj bookmark create claude/<name> -r @` | Names the change's branch |
| `jj new -m "<message>"` | Adds a change on top of the working copy |
| `jj edit <change>` | Edits a change in place |
| `jj describe -r <change> -m "<message>"` | Rewords a change |
| `jj squash --from @ --into <change> <path>` | Moves edits into a change below |
| `jj split -r <change> <path>...` | Splits a change, the named paths first |
| `jj rebase -r <change> -B <other>` | Moves a change to just below another |
| `jj abandon <change>` | Drops a change |
| `jj log -r 'trunk()::'` | Shows the stacks |
| `jj undo` | Undoes the last operation |
| `jj gh doctor` | Checks the checkout's setup and says what fixes each problem |
| `jj gh log` | Shows the stack's changes, pull requests and push state |
| `jj gh links` | Prints the stack's pull requests as Markdown links with their state and size. `--copy` copies them |
| `jj gh checks` | Shows the state of each pull request's required checks. Read CI's result here, not from GitHub's check run list |
| `jj gh submit` | Pushes the stack up to the working copy and opens or updates its pull requests as one GitHub stack |
| `jj gh publish -r <change>` | Marks the drafts up to that change ready for review |
| `jj gh merge -r <change>` | Merges the pull requests up to that change, then syncs and republishes the rest. `--cancel-pr-runs` cancels their runs |
| `jj gh sync` | Rebases every stack onto the fetched trunk and drops what merged |
| `jj gh dissolve <stack>` | Dissolves a GitHub stack, leaving its pull requests open. Where `submit` fails because the pull requests are in several stacks, it names the commands to run: check what each stack holds first |

## Building and changing a stack

After `jj edit <change>`, every edit is part of that change: there is no staging or amend. jj rebases everything upstack as you edit, and records any conflict in the change. Clear it with `jj resolve` or by editing the file.

jj records every file in the checkout that isn't ignored, so keep scratch files outside the checkout.

Run `jj gh sync` often, since conflicts grow as a stack lags `main`. It pushes nothing, so run `jj gh submit` afterwards. Where `sync` leaves a stack in place because it would conflict, rebase it with `jj rebase` when ready.

## Publishing

`submit` opens new pull requests as drafts. Write the description the PR template asks for with `jj describe`, run `submit` again, then `jj gh publish`. `submit` keeps each pull request's title and body equal to its change's description, merging edits made on GitHub into the change. Where both sides edited the same lines, it stops and prints both.

A change dropped from the stack leaves its pull request open; close it by hand.

## Merging

Merge with `jj gh merge`, ❌ not `gh pr merge` or GitHub's merge button. That's because only `jj gh merge` syncs the checkout and republishes the rest of the stack. Run `submit` first, since `merge` fails on edits that aren't pushed.

Merge separate stacks one at a time, and run `jj gh submit` on the next stack before merging it.

❌ Don't use the `gh stack` extension: it moves branches without jj knowing.

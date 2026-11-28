# Checks

## Check each change you edit, and the ones above it

After editing a change, run `bun run fix` and `bun run check` in it, then `jj edit` each change above it in turn and run them there.

That's because jj rebases the changes above it, and CI checks each pull request's head.

## Merge only once CI passes

CI skips drafts, so `jj gh checks` says `skipped` for a draft, and after `jj gh publish` until CI's run starts. Merge only once it says `passed`.

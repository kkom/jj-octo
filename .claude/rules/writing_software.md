# Writing software

## Choose the simple, regular solution

That's because special cases, each cheap, together make code nobody can reason about as a whole.

- ❌ An `if` for the one table whose name contains a dot
- ✅ Quoting every table name

## Ask before you drop a case for simplicity

Where the general solution misses a case, name it and ask, rather than add a special case or drop it.

That's because the human decides that trade.

## Make complete fixes and implementations

Fix the root cause. Fix broken, awkward or incomplete code the task meets too, in its own change below the task's.

That's because AI agents make writing code cheap, and a partial workaround leaves a known problem unsolved.

- ❌ Catching an error at the one call site that fails
- ✅ Fixing the function that raises it

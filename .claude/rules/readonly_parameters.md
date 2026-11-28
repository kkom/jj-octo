---
paths:
  - "**/*.{ts,tsx}"
---

# Readonly parameters

## Fix the code when `prefer-readonly-parameter-types` fails

Try these in order:

1. Give our types `readonly` members.
2. Give a third-party type an `allow` entry in `.oxlintrc.jsonc`. Give one also to our own readonly type that the rule can't see is readonly, such as `SetupStep`.
3. Make a collector own its array and return a readonly view, rather than take an array to push into.

In `allow`, the rule matches the annotation as written, so a local alias of a third-party class matches only through the deprecated bare-string form.

## Keep `treatMethodsAsReadonly` off

That's because it exempts `Map` and `Set`, which change through the methods it excuses.

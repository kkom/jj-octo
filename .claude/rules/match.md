---
paths:
  - "**/*.{ts,tsx}"
---

# Matching a discriminated union

## Branch with `Match` and `Match.exhaustive`

That's because `Match.exhaustive` makes an unhandled variant a compile error, where an `if` chain or a `switch` `default` gives it another branch's result.

- ❌ A `switch` whose `default` returns 0 for `line` and `point`
- ✅ Every variant named, with `Match.whenOr` for those that share a result:

```ts
return Match.value(shape).pipe(
  Match.when({ kind: "circle" }, (circle) => Math.PI * circle.radius ** 2),
  Match.when({ kind: "rectangle" }, (rectangle) => rectangle.width * rectangle.height),
  Match.whenOr({ kind: "line" }, { kind: "point" }, () => 0),
  Match.exhaustive,
);
```

## Use `Match.orElse` only for open input

Use it for open-ended input, such as a string from the network. Parse an `unknown` with a schema first; `Match` doesn't validate.

That's because the compiler must check our own unions when they grow.

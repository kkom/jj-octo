---
paths:
  - "**/*.{ts,tsx}"
---

# Sorted keys

## Disable `sort-keys` only where the order is the meaning

Elsewhere, fix the order. Where you disable it, say what the order means.

That's because keys renamed to sort in the needed order hide the constraint, and a rename breaks it.

- ❌ Keys renamed `aFirst` and `bSecond` so that sorting keeps them in order
- ✅ `// oxlint-disable-next-line sort-keys -- the steps run in this order`

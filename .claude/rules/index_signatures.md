---
paths:
  - "**/*.{ts,tsx}"
---

# Reading an index signature

## Fix the type when the same keys keep being read

Under `noPropertyAccessFromIndexSignature`, a bracket reads a key the type doesn't declare. Use one only where the key might be missing, and handle that case. Where code keeps reading the same fixed keys off one loose value, declare the keys, or narrow once with the existing guard or schema.

That's because the compiler checks a declared key but not a bracket read. Repeated reads show the type is wrong, such as an index signature for declarable members or a fixture typed looser than it builds.

- ❌ `row["id"]` and `row["name"]` read in several places off a `Record<string, unknown>`
- ✅ The row decoded once with a schema, then `row.id` and `row.name`

## Never cast past `noPropertyAccessFromIndexSignature`

That's because a cast, `any` or expectation directive hides a wrong type instead of fixing it.

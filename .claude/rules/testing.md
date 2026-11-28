# Tests

Applies to every language.

## Prefer fakes to stubs and mocks

A fake is a working implementation with a shortcut, such as an in-memory store in place of a database. A stub returns canned answers, and a mock records calls for the test to check. Use a fake, and use a stub or a mock only where no fake can stand in.

That's because a fake behaves like the real dependency, so the test checks outcomes and still passes after a refactor. A stub or a mock encodes how the code calls its dependency. It fails when those calls change, and passes when the real dependency would fail.

- ❌ A mocked repository that returns a canned row, and an assertion on the query it received
- ✅ An in-memory repository the test writes rows to, and an assertion on what the code reads back
- ❌ A mock asserting that `send` was called once with a given message
- ✅ A fake mailer that keeps sent messages in a list the test reads

## Make a fake do what the real dependency does

A fake answers as its documentation and real responses show the real dependency does. It adds no shortcut, default or failure response that the real one lacks. A test helper takes each step as a client would, and fails in the test's own code.

That's because a test can pass against a fake that differs, while production fails.

- ✅ A fake sign-in service that asks a person in several organizations to pick one, as the real one does
- ❌ A fake that signs that person in to no organization
- ❌ A response the fake sends only to tell a test helper that something failed

## Inject dependencies the way the framework does

Give code its dependencies through the framework's own dependency injection, such as an Effect layer or a constructor parameter. The test then provides the fake in the same place where production provides the real implementation.

That's because patching a module, with `vi.mock` or `unittest.mock.patch`, replaces it for everything that imports it.

- ❌ `vi.mock("./mailer")` to capture sent messages
- ✅ A fake mailer, provided through the test's layer in place of the real one

## Derive a fixture's time from the run's clock

Where code under test compares a fixture's time with a clock, write that time as an offset from the run's clock, read once per run, such as two weeks before it or a week after it. Write expected values from the same offsets, and format them where a test expects text. Where the code reads only a clock the test provides, a fixed date stays correct.

That's because some clocks the code reads can't be faked, such as a database's `now()` or a workflow engine's start time. A fixed date passes on the day it's written, and the test starts to fail once the real clock passes that date plus the period the code checks.

- ❌ `expiresAt: "2026-11-21T00:00:00.000Z"`, a week after a fixed offer date, beside code that checks expiry against the real time
- ✅ `expiresAt` a week after the run's clock, and the expected row built from that same value
- ❌ `"2026-11-21T00:00:00.000Z"` written into an expected message
- ✅ The expected message with the formatted `expiresAt` interpolated

## Control a test's timing through the runtime

Code keeps the runtime's own timing on every path: sleeps, retries and their backoff, and event-wait timeouts. A test controls that timing by configuring or patching the runtime's local emulator. Avoid a test-only code path around the runtime's timing; where one is unavoidable, say why beside it. A test advances a test clock, and never waits in real time for a limit. Where a test hits a time or size limit, fix the contention behind it, for locks, connections, pools or memory. A test gives a limit its own value only with the reason written beside it.

That's because a test-only path runs code that production doesn't, and a loosened limit hides the failure that production hits.

- ❌ A `skipBackoff` flag that only tests set, with no reason beside it
- ✅ A test clock advanced past the backoff
- ❌ A pool timeout raised in tests until a flaky failure stops

## Assert on complete objects

Compare the whole value in one equality assertion, rather than checking its fields one at a time or matching part of it.

That's because one comparison shows the expected value in one place, and fails on a field the test didn't think to check.

- ❌ `expect(user.name).toBe("Ada")`, then `expect(user.role).toBe("admin")`
- ❌ `expect(user).toMatchObject({ name: "Ada" })`
- ✅ `expect(user).toStrictEqual({ id: created.id, name: "Ada", role: "admin" })`

## Write dynamic values into the expected value, or match them

Where a field holds a value that differs on each run, such as a generated id or a timestamp, read it from the setup or the result, and write it into the expected value.

Otherwise, put a matcher in that field: an asymmetric matcher in vitest or Jest, or a dirty-equals type in Python. Choose the most specific matcher that fits. Still write the value in if that's easy, or if the exact value matters to the test.

That's because a written-in value checks the field exactly. A matcher also keeps the comparison whole, but it accepts some wrong values.

- ✅ `expect(row).toStrictEqual({ id: created.id, name: "Ada", createdAt: now })`
- ❌ `id: expect.any(String)`, where the test already has `created.id`
- ✅ `requestId: expect.stringMatching(UUID)`, where the code generates the id internally and the test isn't about it
- ✅ `assert event == {"id": IsUUID, "sent_at": IsNow(tz="UTC")}` in Python

## Disable the TypeScript lint ban only for a deliberate use

In TypeScript, oxlint's `no-restricted-properties` and `no-restricted-imports` rules fail on these, in any file:

- Partial matchers: `toMatchObject`, `objectContaining`, `arrayContaining`, the `toContain…` matchers, `toInclude`, `toIncludeRepeated`, `toEqualIgnoringWhitespace`, `toHaveProperty`, `toMatch`, `toStartWith`, `toEndWith`, `toHaveLength`, `toBeArrayOfSize` and `toSatisfy`.
- `toEqual`, which ignores `undefined` fields and class types.
- `toThrow`, `toThrowError` and the `toThrowErrorMatching…` matchers, which match part of a failure.
- Matchers that check only one property of a value, such as `toBeInstanceOf`, `toBeDefined`, `toBeTruthy` and `toBeEmpty`.
- Mock-call matchers: `toHaveBeenCalled`, `toHaveBeenCalledOnce`, `toHaveBeenCalledTimes`, `toHaveBeenCalledWith`, `toHaveBeenLastCalledWith`, `toHaveBeenNthCalledWith`, `toHaveReturned`, `toHaveReturnedTimes`, `toHaveReturnedWith`, `toHaveLastReturnedWith` and `toHaveNthReturnedWith`, and their aliases `toBeCalled`, `toBeCalledTimes`, `toBeCalledWith`, `lastCalledWith` and `nthCalledWith`.
- Mocking APIs: `vi.mock`, `vi.doMock`, `vi.fn` and `vi.spyOn`, and `jest`, `mock` and `spyOn` imported from `bun:test`.

Where a test needs one of them, disable the rule on that line, and say why in the comment. That's because the comment tells a reviewer the use is deliberate, rather than a check someone skipped.

- ❌ `// oxlint-disable-next-line no-restricted-properties`
- ✅ `// oxlint-disable-next-line no-restricted-properties -- the patched comparison inside objectContaining is what's tested`

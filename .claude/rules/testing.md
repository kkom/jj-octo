# Tests

Applies to every language.

## Prefer fakes to stubs and mocks

A fake is a working implementation with a shortcut, such as an in-memory database. Use a stub or a mock only where no fake can stand in.

That's because a stub or mock encodes how code calls its dependency, so it fails on a refactor and passes where the real dependency would fail.

- ❌ A mocked repository returning a canned row, and an assertion on the query it received
- ✅ An in-memory repository the test writes rows to, and an assertion on what the code reads back

## Make a fake do what the real dependency does

Give a fake no shortcut, default or failure response the real dependency lacks. A test helper takes each step as a client would.

That's because a test can pass against a differing fake while production fails.

- ❌ A fake sign-in service that signs a member of several organizations in to none of them
- ✅ A fake that asks them to pick one, as the real service does

## Inject dependencies the way the framework does

That's because patching a module replaces it for every importer.

- ❌ `vi.mock("./mailer")` to capture sent messages
- ✅ A fake mailer, provided through the test's Effect layer

## Derive a fixture's time from the run's clock

Where code compares a fixture's time with a clock the test can't fake, such as a database's `now()`, write the time and the expected values as offsets from the run's clock.

That's because a fixed date fails once the real clock passes that date plus the period the code checks.

- ❌ `expiresAt: "2026-11-21T00:00:00.000Z"` beside code that checks expiry against the real time
- ✅ `expiresAt` a week after the run's clock, and the expected row and message built from it

## Control a test's timing through the runtime

Keep the runtime's sleeps, retries and timeouts on every path. Avoid a test-only path around the runtime's timing; where one is unavoidable, say why beside it. Advance a test clock, and never wait in real time for a limit. Where a test hits a time or size limit, fix the contention behind it. A test gives a limit its own value only with the reason written beside it.

That's because a test-only path runs code production doesn't, and a loosened limit hides production's failure.

- ❌ A `skipBackoff` flag only tests set, or a pool timeout raised until a flaky failure stops
- ✅ A test clock advanced past the backoff

## Assert on complete objects

That's because one equality assertion on the whole value also fails on a field the test didn't think to check.

- ❌ `expect(user.name).toBe("Ada")`
- ✅ `expect(user).toStrictEqual({ id: created.id, name: "Ada", role: "admin" })`
- ❌ `expect(failure.message).toContain("needs a bookmark")`
- ✅ `expect(failure).toStrictEqual(NotAStack.make({ message: … }))`, which also checks the tag
- ✅ A partial matcher, such as `toStartWith`, only in an extraordinary case your judgment highly justifies, with the reason in a comment beside it

## Write dynamic values into the expected value, or match them

Read a generated value from the setup or result, and write it in. Otherwise use the most specific matcher that fits.

That's because a matcher accepts some wrong values.

- ❌ `id: expect.any(String)`, where the test already has `created.id`
- ✅ `requestId: expect.stringMatching(UUID)`, where the code generates the id internally

## Disable a lint ban only for a deliberate use

Where a test needs a matcher or mocking API that `.oxlintrc.jsonc` bans, disable the rule on that line and say why.

That's because the reason tells a reviewer the use is deliberate.

- ❌ `// oxlint-disable-next-line no-restricted-properties`
- ✅ `// oxlint-disable-next-line no-restricted-properties -- the patched comparison inside objectContaining is what's tested`

import { describe, expect, it } from "bun:test";

import { approvedBy } from "./approval";

describe("approvedBy", () => {
  it.each([
    ["one approval", ["APPROVED"], true],
    ["no reviews", [], false],
    ["only a comment", ["COMMENTED"], false],
    ["a comment after an approval", ["APPROVED", "COMMENTED"], true],
    ["a request for changes after an approval", ["APPROVED", "CHANGES_REQUESTED"], false],
    ["an approval after a request for changes", ["CHANGES_REQUESTED", "APPROVED"], true],
    [
      "an approval after a request for changes after an approval",
      ["APPROVED", "CHANGES_REQUESTED", "APPROVED"],
      true,
    ],
    ["a dismissed review after an approval", ["APPROVED", "DISMISSED"], true],
    ["a dismissed review alone", ["DISMISSED"], false],
  ] as const)("reads %s as approving: %p", (_, states, approved) => {
    expect(approvedBy(states.map((state) => ({ state })))).toBe(approved);
  });
});

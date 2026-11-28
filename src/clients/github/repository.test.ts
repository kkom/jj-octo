import { describe, expect, it } from "bun:test";

import { Option } from "effect";

import { repositoryFromUrl } from "./repository";

describe("repositoryFromUrl", () => {
  it.each(["https://github.com/kkom/jj-octo", "https://github.com/kkom/jj-octo.git"])(
    "reads %s",
    (url) => {
      expect(repositoryFromUrl(url)).toStrictEqual(Option.some({ name: "jj-octo", owner: "kkom" }));
    },
  );

  it("reads nothing from a remote elsewhere", () => {
    expect(repositoryFromUrl("https://gitlab.com/kkom/jj-octo")).toStrictEqual(Option.none());
  });
});

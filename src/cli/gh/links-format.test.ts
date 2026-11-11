import { describe, expect, it } from "bun:test";

import { pullRequest } from "../../testing/fake-github";
import { inStack, linked } from "../../testing/links";
import { htmlLinks, markdownLinks } from "./links";

describe("markdownLinks and htmlLinks", () => {
  const listed = [
    linked(pullRequest(5, "closed", "x"), 123, 45),
    linked(pullRequest(4, "draft", "x"), 0, 7),
    { ...linked(pullRequest(3, "ready", "x")), state: "approved" as const },
    linked(pullRequest(2, "ready", "x")),
    { ...linked(pullRequest(1, "merged", "x")), title: `Escape <b> & "quotes"` },
  ];

  it("writes a Markdown line per pull request, marked with its state", () => {
    expect(markdownLinks(listed)).toBe(
      [
        "🚫 [#5 Pull request 5](https://github.com/kkom/jj-octo/pull/5) `+123/-45`",
        "📝 [#4 Pull request 4](https://github.com/kkom/jj-octo/pull/4) `+0/-7`",
        "✅ [#3 Pull request 3](https://github.com/kkom/jj-octo/pull/3) `+1/-0`",
        "👀 [#2 Pull request 2](https://github.com/kkom/jj-octo/pull/2) `+1/-0`",
        `🏁 [#1 Escape <b> & "quotes"](https://github.com/kkom/jj-octo/pull/1) \`+1/-0\``,
      ].join("\n"),
    );
  });

  it("writes the same lines as HTML, escaping the titles", () => {
    expect(htmlLinks(listed)).toBe(
      [
        '<meta charset="utf-8">🚫 <a href="https://github.com/kkom/jj-octo/pull/5">#5 Pull request 5</a> <code>+123/-45</code>',
        '📝 <a href="https://github.com/kkom/jj-octo/pull/4">#4 Pull request 4</a> <code>+0/-7</code>',
        '✅ <a href="https://github.com/kkom/jj-octo/pull/3">#3 Pull request 3</a> <code>+1/-0</code>',
        '👀 <a href="https://github.com/kkom/jj-octo/pull/2">#2 Pull request 2</a> <code>+1/-0</code>',
        '🏁 <a href="https://github.com/kkom/jj-octo/pull/1">#1 Escape &lt;b&gt; &amp; &quot;quotes&quot;</a> <code>+1/-0</code>',
      ].join("<br>"),
    );
  });
});

describe("markdownLinks and htmlLinks with stacks", () => {
  it("links no stack where no pull request is open", () => {
    const merged = inStack(linked(pullRequest(1, "merged", "x")), 7);
    expect(markdownLinks([merged])).toBe(
      "🏁 [#1 Pull request 1](https://github.com/kkom/jj-octo/pull/1) `+1/-0`",
    );
  });

  // A stack registered again under a new number leaves its merged pull requests in the old one.
  const listed = [
    inStack(linked(pullRequest(3, "ready", "x")), 8),
    inStack(linked(pullRequest(2, "ready", "x")), 8),
    inStack(linked(pullRequest(1, "merged", "x")), 7),
  ];

  it("links the stack of the open pull requests, above the pull requests", () => {
    expect([markdownLinks(listed), htmlLinks(listed)]).toStrictEqual([
      [
        "📚 Current stack: [#8](https://github.com/kkom/jj-octo/stack/8)",
        "👀 [#3 Pull request 3](https://github.com/kkom/jj-octo/pull/3) `+1/-0`",
        "👀 [#2 Pull request 2](https://github.com/kkom/jj-octo/pull/2) `+1/-0`",
        "🏁 [#1 Pull request 1](https://github.com/kkom/jj-octo/pull/1) `+1/-0`",
      ].join("\n"),
      [
        '<meta charset="utf-8">📚 Current stack: <a href="https://github.com/kkom/jj-octo/stack/8">#8</a>',
        '👀 <a href="https://github.com/kkom/jj-octo/pull/3">#3 Pull request 3</a> <code>+1/-0</code>',
        '👀 <a href="https://github.com/kkom/jj-octo/pull/2">#2 Pull request 2</a> <code>+1/-0</code>',
        '🏁 <a href="https://github.com/kkom/jj-octo/pull/1">#1 Pull request 1</a> <code>+1/-0</code>',
      ].join("<br>"),
    ]);
  });
});

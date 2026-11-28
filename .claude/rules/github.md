# GitHub

## Try every path before concluding GitHub is unreachable

`gh`, `git` over HTTPS and, in a cloud session, the GitHub MCP tools are each authorized separately. An access error describes only its own path, however it's worded. Try the other paths, and report the error itself.

That's because once you decide something is unavailable, you stop trying it and do less than asked.

- ❌ "GitHub is unavailable", after `gh` returns a 403
- ✅ The repository read through the MCP tools, and the branch pushed with `git push`

## Read an empty listing as "not yet"

Checks and runs take minutes to appear.

## Leave an abandoned branch in place

A cloud session can't delete a remote branch. `branch-cleanup.yaml` deletes it once its last commit is two weeks old, unless an open pull request has it as head or base, it's protected, or GitHub Pages publishes from it. It keeps a branch pushed to after its latest pull request closed only until two weeks after that close, so give work that follows a closed pull request a new branch.

## Follow the PR template

Structure the description as `.github/pull_request_template.md` says.

## Write the description before publishing

Submit a draft, write its description, then publish. Update the description as the changes evolve.

That's because reviewers may start once a PR is published.

## Name only repositories every reader can see

Name a private repository only where another rule here says every reader can see it. This covers its name, links, pull requests, issues and contents, in everything you write. Name a public repository anywhere.

That's because naming it tells a reader who may lack access that it exists and what it holds.

- ❌ A link to a private repository's pull request as the source of a rule
- ✅ The rule itself, with no word on where it came from

## Disclose that you're an AI

When you use a human's access token, end PR descriptions and comments with the model, the harness and the level of autonomy: prescriptive instruction, vague instruction, or acting autonomously to solve a goal.

That's because your actions could otherwise be mistaken for theirs.

- ✅ _(sent by Claude Opus 5 from local Claude Code on behalf of @user, acting autonomously)_

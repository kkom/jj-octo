# Terminology

## Use "change", "bookmark" and "branch" for three different things

- A change is the work: edits and a description, like a git commit. It becomes one pull request.
- A bookmark is jj's label on a change. A change can have none, one or several.
- A branch is on GitHub. `jj git push` creates one with the bookmark's name.

That's because each word says where the value lives, and a bookmark may not be pushed yet.

- ❌ `stackBranches`, for names read from jj
- ✅ `stackBookmarks`

## Keep the name "bookmark" until the value reaches the GitHub client

GitHub's own names stay, such as `openPullRequest(branch)` and a pull request's `head` and `base`.

That's because copying it into a `branch` variable gives one value two names.

- ❌ `const branch = bookmark;`
- ✅ `github.openPullRequest(bookmark)`

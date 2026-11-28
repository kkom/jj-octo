# This repository is public

## Never mention a private repository

Don't name or describe a private repository anywhere here, even for work copied from it or kept aligned with it. A mention is any of these:

- Its name, owner or URL.
- Its paths, package names, service names and hostnames.
- Markers its tooling reads, and configuration that only makes sense there.
- The fact that it exists, or that something here matches it.

That's because anyone can read what's pushed here, and GitHub keeps description edits and force-pushed commits.

- ❌ "Moved from `packages/some-cli` in the private monorepo."
- ✅ "Adds the CLI."

## Check before the first push

Search the files, commit messages and pull request text for those names before you push. Trim configuration copied from elsewhere to what this repository uses.

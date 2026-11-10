# Writing rules

A rule is one of three kinds, and each has its own structure.

## Style guides

A style guide says how to write something — code, tests, comments, names. It's written as a list of conventions:

- Each heading is a rule, stated as an instruction: "Avoid casts", "Keep sentences short".
- The reason follows in a sentence or two, often starting "That's because".
- Concrete ❌/✅ examples give the detail, rather than abstract explanation.

## Instructions and indexes

An instruction or index says what exists and how to use it — a tool, a system, a process. It's written as a description:

- Headings name areas, not rules: "Commands", "Merging and cleaning up".
- Capabilities are indexed in a list or table, one line each.
- A process is walked through in the order it's done, with each trap beside the step it belongs to.

## Designs

A design states how one part of the system works, or will work: its parts, what each part does, and the order things happen in. It's written as a specification:

- Headings name parts of the design, numbered where sections refer to each other: "2. The lock table", "5. Retrying a failed step".
- Each part is stated concretely, as the tables and columns, the functions and what each returns, and the steps in order, not as principles a reader has to turn into a design.
- Terms are defined once, in a table near the top, and used the same way throughout.
- Where the code doesn't follow the design yet, a section at the end lists each gap with its issue.

That's because a reader builds the part from the design, so every choice has to be on the page.

## Every kind

- In a rule that applies beyond this repository, describe the kind of thing rather than naming a package, path or worker only this repository has.
- Claim only what the configuration behind the rule enforces.
- Write them according to the guidance in `language.md`.

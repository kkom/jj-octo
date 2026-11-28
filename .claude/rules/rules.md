# Writing rules

A rule is one of three kinds, each with its own structure.

## Style guides

A style guide says how to write something. It's a list of conventions:

- Each heading is a rule, stated as an instruction: "Avoid casts".
- A sentence of reason follows, often starting "That's because".
- One ❌/✅ pair per point gives the detail.

## Instructions and indexes

An instruction or index says what exists and how to use it. It's a description:

- Headings name areas, not rules: "Commands".
- A list or table indexes capabilities, one line each.
- A process is walked through in order, each trap beside its step.

## Designs

A design states how one part of the system works or will work. It's a specification:

- Headings name parts, numbered where sections refer to each other: "2. The lock table".
- Each part is concrete: tables and columns, functions and their returns, steps in order.
- Terms are defined once, in a table near the top.
- A final section lists each gap between code and design, with its issue.

That's because a reader builds the part from the design, so every choice must be on the page.

## Every kind

- In a rule that applies beyond this repository, describe the kind of thing, not a package or path only this repository has.
- Claim only what the configuration behind the rule enforces, and don't restate what it already names.
- Write them as `language.md` says.

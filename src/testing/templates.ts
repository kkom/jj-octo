import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

// Running jj and git a dozen times per test is most of what the tests cost, so each kind of
// repository is built once per test process and copied.
const templates = new Map<string, string>();

// A template that a run still copies is a few minutes old at most.
const STALE_AFTER_MS = 60 * 60 * 1000;

// Bun doesn't run a test process's exit handlers, so a run can't remove its own templates.
const removeStaleTemplates = (parent: string): void => {
  for (const name of readdirSync(parent).filter((entry) => entry.startsWith("template-"))) {
    const template = path.join(parent, name);
    const modified = statSync(template, { throwIfNoEntry: false })?.mtimeMs ?? Date.now();
    if (Date.now() - modified > STALE_AFTER_MS) {
      rmSync(template, { force: true, recursive: true });
    }
  }
};

/**
 * The directory in `parent` that `build` filled for the name, built on first use. Before the
 * first build, removes the templates that earlier runs left there.
 */
export const templateOf = (parent: string, name: string, build: (root: string) => void): string => {
  mkdirSync(parent, { recursive: true });
  let template = templates.get(name);
  if (template === undefined) {
    if (templates.size === 0) {
      removeStaleTemplates(parent);
    }
    template = mkdtempSync(path.join(parent, `template-${name}-`));
    templates.set(name, template);
    build(template);
  }
  return template;
};

/**
 * The full-loop scenario, shared by tests and sanity scripts so the loop is
 * exercised identically whether asserted or watched.
 *
 * A tmp workspace holds two fake scripts that hardcode a wrong value; a scripted
 * driver investigates, diagnoses, fixes one, verifies on the real stack, and
 * closes with a structured summary.
 *
 * Uses only the `terminal` core tool (the only built-in tool after cleanup).
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DriverAction } from "./driver.js";
import { DATA_ROOT_VARIABLES, requiredDataRoot } from "./data-roots.js";

/** The sibling lab-store repo (single source of truth for skillpack content). */
/**
 * The real lab-store, resolved and validated on USE.
 *
 * Not at import time: a module-level throw takes down every test file that imports this one,
 * whether or not it ever seeds a skillpack, turning one missing variable into a suite-wide outage.
 */
const realLabStore = (): string => requiredDataRoot(...DATA_ROOT_VARIABLES.store);

/**
 * Copy named modules (skillpacks/conventions) from the REAL lab-store into a
 * disposable store, so a sanity/test run gets the authored skillpack content
 * (one source of truth) while keeping writes contained to the tmp store.
 */
export function seedSkillpacks(storeRoot: string, names: readonly string[]): void {
  const source = realLabStore();
  for (const name of names) {
    let copied = false;
    for (const type of ["skills", "conventions"]) {
      const src = join(source, type, `${name}.md`);
      if (!existsSync(src)) continue;
      mkdirSync(join(storeRoot, type), { recursive: true });
      copyFileSync(src, join(storeRoot, type, `${name}.md`));
      copied = true;
      break;
    }
    if (!copied) throw new Error(`seedSkillpacks: module "${name}" not found in ${source}`);
  }
}

export const WRONG_VALUE = "TIMEOUT=30";
export const RIGHT_VALUE = "TIMEOUT=60";
export const SKILL_NAME = "grep-verify-after-edit";

export const APP_BEFORE = `#!/bin/sh
RETRIES=3
${WRONG_VALUE}
echo "running with TIMEOUT=$TIMEOUT"
`;

export const APP_AFTER = `#!/bin/sh
RETRIES=3
${RIGHT_VALUE}
echo "running with TIMEOUT=$TIMEOUT"
`;

const LIB_CONTENT = `# mirror of app.sh
${WRONG_VALUE}
`;

/** Create a tmp workspace with the two fake scripts. Returns its root. */
export function createWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "lab-ws-"));
  writeFileSync(join(root, "app.sh"), APP_BEFORE);
  writeFileSync(join(root, "lib.sh"), LIB_CONTENT);
  return root;
}

/** Create a tmp lab-store: a real git repo with an empty skills/ dir. Returns its root. */
export function createLabStore(): string {
  const root = mkdtempSync(join(tmpdir(), "lab-store-"));
  mkdirSync(join(root, "skills"), { recursive: true });
  mkdirSync(join(root, "conventions"), { recursive: true });
  writeFileSync(join(root, "skills", ".gitkeep"), "");
  git(["init", "-q"], root);
  git(["config", "user.email", "lab@lab.local"], root);
  git(["config", "user.name", "pehlichi test"], root);
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "fixture: seed"], root);
  return root;
}

/** The canned driver sequence for the full-loop scenario. */
export function scenarioActions(): DriverAction[] {
  return [
    { kind: "narrate", phase: "investigate", text: "Reading the two scripts to find the timeout setting." },
    { kind: "tool", tool: "terminal", args: { command: "cat app.sh" } },
    { kind: "tool", tool: "terminal", args: { command: "cat lib.sh" } },
    { kind: "tool", tool: "terminal", args: { command: `grep -n '${WRONG_VALUE}' *.sh` } },
    {
      kind: "root-cause",
      text: `Both scripts hardcode ${WRONG_VALUE}, which is too low; app.sh must use ${RIGHT_VALUE}.`,
    },
    { kind: "narrate", phase: "act", text: "Raising the timeout to 60 in app.sh." },
    {
      kind: "tool",
      tool: "terminal",
      args: { command: `printf '%s\\n' '#!/bin/sh' 'RETRIES=3' 'TIMEOUT=60' 'echo "running with TIMEOUT=$TIMEOUT"' > app.sh` },
    },
    { kind: "narrate", phase: "verify", text: "Grepping the file to confirm the corrected value landed." },
    { kind: "tool", tool: "terminal", args: { command: "grep TIMEOUT app.sh" } },
    { kind: "tool", tool: "terminal", args: { command: "cat app.sh" } },
    {
      kind: "done",
      summary: {
        rootCause: `app.sh hardcoded ${WRONG_VALUE}.`,
        changes: [`Set ${RIGHT_VALUE} in app.sh`],
        verification: ["grep TIMEOUT app.sh shows TIMEOUT=60 (exit 0)", "cat app.sh confirms the line"],
      },
    },
  ];
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

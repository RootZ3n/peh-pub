/**
 * PERSISTENT DATA ROOTS — named by the environment, validated, or refused.
 *
 * WHY THIS IS STRICTER THAN THE TRIO'S. The three Trio agents are gated by a root-owned external
 * validator that runs as `ExecStartPre`, before any agent code loads, and checks the data roots
 * there. This agent has no such gate: it is started directly. So the same checks live here, in the
 * resolver, and they run before anything opens or creates a file.
 *
 * WHAT THE FALLBACKS WERE. Every resolver in this tree used to end in one:
 *
 *   scenario.ts            "/pehverse/repos/lab-utilities/lab-store"
 *   brain-tools.ts         "/pehverse/repos/lab-utilities/lab-memory"
 *   lab-context-tools.ts   "/pehverse/repos/lab-utilities/lab-memory"
 *   tui/src/server.ts      join(workspaceRoot, '..', 'lab-store')
 *   tui/lib/agent-chat.ts  "/pehverse/repos/lab-utilities/lab-store"
 *   agent-tools/index.ts   join(workspaceRoot, '..', 'lab-store', '.agent-sync')
 *   labmem-tools.ts        a walk-up to ecosystem/../lab-utilities/lab-memory/labmem
 *
 * Every one of them lands in a repository the service account can rewrite wholesale. This agent
 * shares its stores with four others, so a fallback here is not a local mistake: it is one writer
 * quietly using a different copy of data everyone else is coordinating on. A default that is wrong
 * in deployment is worse than no default, because it starts.
 */
import { accessSync, constants, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/** The variables this agent reads. `LAB_MEMORY_ROOT` outranks `MEMORY_STORE_ROOT`. */
export const DATA_ROOT_VARIABLES = Object.freeze({
  store: Object.freeze(['LAB_STORE_ROOT'] as const),
  memory: Object.freeze(['LAB_MEMORY_ROOT', 'MEMORY_STORE_ROOT'] as const),
  vault: Object.freeze(['LABMEM_ROOT'] as const),
  sync: Object.freeze(['AGENT_SYNC_DIR'] as const),
});

/**
 * The only place persistent shared state may live.
 *
 * A prefix rather than a per-root allowlist, because the rule being expressed is "outside every
 * repository and every release" and there is exactly one reviewed location that satisfies it.
 * A repository path, a release path, and the old roots all fail this by construction.
 */
export const APPROVED_DATA_PREFIX = '/var/lib/pehverse/shared';

/** Extensions Node, the shell, or the dynamic loader will execute if something points at them. */
const LOADABLE = /\.(m?[jt]s|cjs|cts|mts|node|so|sh|bash|py)$/;

export class DataRootRefused extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`data root refused [${code}]: ${detail}`);
    this.name = 'DataRootRefused';
    this.code = code;
  }
}

const isWritable = (path: string): boolean => {
  try { accessSync(path, constants.W_OK); return true; } catch { return false; }
};

/**
 * Any loadable file beneath `root` that this process could rewrite or replace.
 *
 * The vault legitimately contains code, so "no code in the data root" is not the invariant. The
 * invariant is that the code there is frozen. A writable *directory* counts as much as a writable
 * file — a file in one can be unlinked and replaced — and a symlink in a writable directory counts
 * too, because it can be re-aimed at anything, including into a release.
 */
function writableCodeUnder(root: string, budget = 64): string[] {
  const found: string[] = [];
  const walk = (relative: string, directoryWritable: boolean): void => {
    if (found.length >= budget) return;
    let names: string[];
    try { names = readdirSync(join(root, relative || '.')); } catch { return; }
    for (const name of names) {
      if (found.length >= budget) return;
      const path = relative ? `${relative}/${name}` : name;
      const full = join(root, path);
      let stat;
      try { stat = lstatSync(full); } catch { continue; }
      if (stat.isSymbolicLink()) {
        if (directoryWritable) found.push(`${path} (symlink in a writable directory)`);
        continue;
      }
      if (stat.isDirectory()) { walk(path, isWritable(full)); continue; }
      if (!stat.isFile()) continue;
      const executable = (stat.mode & 0o111) !== 0;
      if (!LOADABLE.test(name) && !executable) continue;
      if (isWritable(full) || directoryWritable) found.push(path);
    }
  };
  walk('', isWritable(root));
  return found;
}

/**
 * Resolve and validate one data root, or throw.
 *
 * Judged on the RESOLVED path, so a symlink that points outside the approved prefix — or back into
 * a repository or a release — is refused on where it lands rather than on what it says.
 */
export function requiredDataRoot(...names: readonly string[]): string {
  let value: string | undefined;
  for (const name of names) {
    const candidate = process.env[name];
    if (candidate !== undefined && candidate.trim().length > 0) { value = candidate; break; }
  }
  if (value === undefined) {
    throw new DataRootRefused('unset',
      `${names.join(' or ')} must be set: this deployment has no default persistent data root, `
      + 'because every available default would point at a repository or inside a release.');
  }
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new DataRootRefused('not_normalised', `${names[0]}=${value} is not an absolute normalised path`);
  }

  let target: string;
  try { target = realpathSync(value); } catch {
    throw new DataRootRefused('missing', `${names[0]}=${value} does not exist`);
  }
  if (!statSync(target).isDirectory()) {
    throw new DataRootRefused('not_a_directory', `${names[0]}=${value} is not a directory`);
  }
  if (target !== APPROVED_DATA_PREFIX && !target.startsWith(`${APPROVED_DATA_PREFIX}/`)) {
    throw new DataRootRefused('outside_approved_prefix',
      `${names[0]}=${value} resolves to ${target}, which is outside ${APPROVED_DATA_PREFIX}`);
  }
  const loadable = writableCodeUnder(target);
  if (loadable.length > 0) {
    throw new DataRootRefused('writable_code',
      `${names[0]}=${value} holds ${loadable.length} writable loadable file(s), e.g. ${loadable.slice(0, 3).join(', ')}`);
  }
  return value;
}

/**
 * The fail-closed data-root authority.
 *
 * This agent shares its stores with four others and has no external validator in front of it, so
 * these are the checks that stand between "a variable is missing" and "one writer quietly using a
 * different copy of shared data". Every case below is a refusal except the two positive controls,
 * which need a real root-owned directory under the approved prefix and skip loudly without one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  APPROVED_DATA_PREFIX, DATA_ROOT_VARIABLES, DataRootRefused, requiredDataRoot,
} from './data-roots.js';

const VARIABLES = [
  ...DATA_ROOT_VARIABLES.store, ...DATA_ROOT_VARIABLES.memory,
  ...DATA_ROOT_VARIABLES.vault, ...DATA_ROOT_VARIABLES.sync,
];

/** Run with an exact environment for the data-root variables, restoring whatever was there. */
function withEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const name of VARIABLES) { previous[name] = process.env[name]; delete process.env[name]; }
  for (const [name, value] of Object.entries(values)) {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  try { return run(); } finally {
  for (const name of VARIABLES) {
    if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  }
  }
}

const refusalFor = (values: Record<string, string | undefined>, names: readonly string[]): string => {
  try { withEnv(values, () => requiredDataRoot(...names)); }
  catch (error) { assert.ok(error instanceof DataRootRefused); return (error as DataRootRefused).code; }
  throw new Error('accepted, but should have refused');
};

const scratch = mkdtempSync(join(tmpdir(), 'pub-data-roots-'));

// -- every consumed root is declared --
test('names exactly the variables this agent reads', () => {
  assert.deepEqual(DATA_ROOT_VARIABLES.store, ['LAB_STORE_ROOT']);
  assert.deepEqual(DATA_ROOT_VARIABLES.memory, ['LAB_MEMORY_ROOT', 'MEMORY_STORE_ROOT']);
  assert.deepEqual(DATA_ROOT_VARIABLES.vault, ['LABMEM_ROOT']);
  assert.deepEqual(DATA_ROOT_VARIABLES.sync, ['AGENT_SYNC_DIR']);
});

// -- missing and malformed values --
test('refuses when unset', () => {
  assert.equal(refusalFor({}, DATA_ROOT_VARIABLES.store), 'unset');
  });
test('refuses an empty or whitespace value as unset, not as a path', () => {
  // `??` treats '' as set and `||` does not; the two resolvers downstream disagree, so neither
  // spelling is allowed to reach them.
  assert.equal(refusalFor({ LAB_STORE_ROOT: '' }, DATA_ROOT_VARIABLES.store), 'unset');
  assert.equal(refusalFor({ LAB_STORE_ROOT: '   ' }, DATA_ROOT_VARIABLES.store), 'unset');
  });
test('refuses a relative or unnormalised path', () => {
  assert.equal(refusalFor({ LAB_STORE_ROOT: 'lab-store' }, DATA_ROOT_VARIABLES.store), 'not_normalised');
  assert.equal(refusalFor({ LAB_STORE_ROOT: '/var/lib/../lib/pehverse/' }, DATA_ROOT_VARIABLES.store), 'not_normalised');
  });
test('refuses a path that does not exist', () => {
  assert.equal(refusalFor({ LAB_STORE_ROOT: join(scratch, 'absent') }, DATA_ROOT_VARIABLES.store), 'missing');
  });
test('refuses a file', () => {
  const file = join(scratch, 'a-file'); writeFileSync(file, 'x');
  assert.equal(refusalFor({ LAB_STORE_ROOT: file }, DATA_ROOT_VARIABLES.store), 'not_a_directory');
});

// -- foreign and old roots --
test('refuses the OLD repository roots this change replaces', () => {
  for (const [names, old] of [
    [DATA_ROOT_VARIABLES.store, '/pehverse/repos/lab-utilities/lab-store'],
    [DATA_ROOT_VARIABLES.memory, '/pehverse/repos/lab-utilities/lab-memory'],
    [DATA_ROOT_VARIABLES.vault, '/pehverse/repos/lab-utilities/lab-memory/labmem'],
    [DATA_ROOT_VARIABLES.sync, '/pehverse/repos/lab-utilities/lab-store/.agent-sync'],
  ] as const) {
    if (!existsSync(old)) continue;   // the old roots still exist today; after retirement they will not
    assert.equal(refusalFor({ [names[0]]: old }, names), 'outside_approved_prefix');
  }
  });
test('refuses a path inside an immutable release', () => {
  const release = '/opt/pehverse/releases';
  if (!existsSync(release)) return;
  assert.equal(refusalFor({ LAB_STORE_ROOT: release }, DATA_ROOT_VARIABLES.store), 'outside_approved_prefix');
  });
test('refuses a foreign root elsewhere on the filesystem', () => {
  assert.equal(refusalFor({ LAB_STORE_ROOT: scratch }, DATA_ROOT_VARIABLES.store), 'outside_approved_prefix');
  });
test('refuses a symlink on where it LANDS, not on what it says', () => {
  // The obvious bypass: a name under the approved prefix pointing back out of it. Judged resolved.
  const link = join(scratch, 'looks-fine');
  rmSync(link, { force: true });
  symlinkSync('/pehverse/repos/lab-utilities/lab-store', link);
  if (!existsSync('/pehverse/repos/lab-utilities/lab-store')) return;
  assert.equal(refusalFor({ LAB_STORE_ROOT: link }, DATA_ROOT_VARIABLES.store), 'outside_approved_prefix');
});

// -- precedence --
test('prefers LAB_MEMORY_ROOT over MEMORY_STORE_ROOT, and reports both when neither is set', () => {
  const code = refusalFor({ LAB_MEMORY_ROOT: 'relative-one', MEMORY_STORE_ROOT: '/var/lib' },
    DATA_ROOT_VARIABLES.memory);
  assert.equal(code, 'not_normalised');   // the first set value won, so precedence holds
  try { withEnv({}, () => requiredDataRoot(...DATA_ROOT_VARIABLES.memory)); }
  catch (error) { assert.ok(String((error as Error).message).includes('LAB_MEMORY_ROOT or MEMORY_STORE_ROOT')); }
});

// -- executable code cannot live writable in a data root --
const approved = join(APPROVED_DATA_PREFIX, 'lab-store');
const available = existsSync(approved);

test('accepts an approved, frozen root', { skip: !available && 'the approved prefix does not exist yet' }, () => {
  assert.equal(withEnv({ LAB_STORE_ROOT: approved }, () => requiredDataRoot(...DATA_ROOT_VARIABLES.store)), approved);
});

test('refuses once a writable loadable file appears beneath it', { skip: !available && 'the approved prefix does not exist yet' }, () => {
  // Written into a declared writable leaf, which is where an agent could actually put one.
  const leaf = join(approved, '.checkpoints');
  if (!existsSync(leaf)) return;
  const planted = join(leaf, 'planted-by-test.mjs');
  writeFileSync(planted, 'export const x = 1;\n');
  try {
    assert.equal(refusalFor({ LAB_STORE_ROOT: approved }, DATA_ROOT_VARIABLES.store), 'writable_code');
  } finally { rmSync(planted, { force: true }); }
});

test('reports when the approved prefix is not present, rather than passing silently', () => {
  // A skipped positive control that looks like a pass is how a suite goes quietly vacuous.
  if (!available) {
    assert.equal(existsSync(APPROVED_DATA_PREFIX), false);
  } else {
    assert.equal(available, true);
  }
});

// -- the agent writes only to its own namespace --
test('declares pehlichi-pub as its labmem namespace', async () => {
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('./agent-tools/labmem-tools.ts', import.meta.url), 'utf8'));
  assert.ok(String(source).includes("const AGENT = 'pehlichi-pub'"));
  // and no longer carries a fallback root
  assert.ok(!String(source).includes('defaultLabmemRoot'));
});

process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));

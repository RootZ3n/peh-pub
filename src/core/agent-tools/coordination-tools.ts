/**
 * COORDINATION TOOL — agent_sync (Blocker 7).
 *
 * A minimal, durable channel that lets the three agents share results WITHOUT a
 * shared process or runtime: each entry is a small JSON file under a SHARED sync
 * directory (one source of truth for the whole lab), so a value written by one
 * agent is readable by any other and survives restarts.
 *
 * Actions:
 *   write     — store/overwrite a keyed value (records the writing agent + timestamp)
 *   read      — fetch a value by key
 *   list      — list all keys with their writer/timestamp
 *   broadcast — append a value to a shared, append-only broadcast log
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import type { ToolSpec, ToolHandler, ToolResult } from '../tools.js';

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });

export const coordinationToolSpecs: ToolSpec[] = [
  {
    name: 'agent_sync',
    description:
      'Share results with the other lab agents through a durable shared store. ' +
      'Actions: write (store a keyed value), read (fetch by key), list (all keys), broadcast (append to a shared log).',
    parameters: obj(
      {
        action: { type: 'string', enum: ['write', 'read', 'list', 'broadcast'], description: 'What to do.' },
        key: { type: 'string', description: 'Entry key (for write/read).' },
        value: { type: 'string', description: 'Value to store (for write/broadcast).' },
      },
      ['action'],
    ),
  },
];

export interface CoordinationConfig {
  /** Shared directory all agents read/write — the cross-agent source of truth. */
  /**
   * The shared sync directory, or a thunk resolving it.
   *
   * A thunk so a fail-closed root is demanded when `agent_sync` is actually used rather than when
   * the registry is built -- the registry is assembled by callers that never touch this tool.
   */
  readonly syncDir: string | (() => string);
  /** Identifier of the agent doing the writing (recorded on each entry). */
  readonly agentId: string;
  /** Injectable clock for deterministic timestamps in tests. */
  readonly clock?: () => number;
}

interface SyncEntry {
  readonly key: string;
  readonly value: string;
  readonly agentId: string;
  readonly ts: number;
}

/** Safe filename for a key — never escapes the sync dir. */
function keyFile(syncDir: string, key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(syncDir, `${safe}.json`);
}

export function createCoordinationToolHandlers(config: CoordinationConfig): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const clock = config.clock ?? Date.now;

  const syncDir = (): string => (typeof config.syncDir === 'function' ? config.syncDir() : config.syncDir);

  const ensureDir = (): string => {
    const dir = syncDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  };

  handlers.set('agent_sync', async (args): Promise<ToolResult> => {
    const action = args.action as string;
    try {
      const dir = ensureDir();
      switch (action) {
        case 'write': {
          const key = args.key as string;
          if (typeof key !== 'string' || key.trim() === '') {
            return { ok: false, output: '', error: 'write requires a key' };
          }
          const entry: SyncEntry = { key, value: String(args.value ?? ''), agentId: config.agentId, ts: clock() };
          // ATOMIC WRITE (N2): write to a per-writer temp file, then rename into place.
          // rename(2) is atomic within a directory, so a concurrent reader never sees a
          // half-written entry and two agents writing the same key never tear the file —
          // the last rename wins cleanly instead of interleaving bytes.
          const dest = keyFile(dir, key);
          const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_');
          // Temp name ends in `.tmp` (not `.json`) so a concurrent `list` never sees it.
          const tmp = join(dir, `.${safe}.${process.pid}.${clock()}.tmp`);
          writeFileSync(tmp, JSON.stringify(entry, null, 2));
          renameSync(tmp, dest);
          return { ok: true, output: `wrote "${key}" (${entry.value.length} chars) as ${config.agentId}` };
        }
        case 'read': {
          const key = args.key as string;
          const file = keyFile(dir, key);
          if (typeof key !== 'string' || !existsSync(file)) {
            return { ok: false, output: '', error: `no entry for key "${key}"` };
          }
          const entry = JSON.parse(readFileSync(file, 'utf-8')) as SyncEntry;
          return {
            ok: true,
            output: `[${entry.agentId} @ ${new Date(entry.ts).toISOString()}] ${entry.value}`,
          };
        }
        case 'list': {
          const files = existsSync(dir)
            ? readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'broadcast.log.json')
            : [];
          const entries = files.map((f) => {
            try {
              const e = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as SyncEntry;
              return { key: e.key, agentId: e.agentId, ts: new Date(e.ts).toISOString() };
            } catch {
              return null;
            }
          }).filter(Boolean);
          return {
            ok: true,
            output: entries.length > 0 ? JSON.stringify(entries, null, 2) : 'No shared entries.',
          };
        }
        case 'broadcast': {
          const line = JSON.stringify({ agentId: config.agentId, value: String(args.value ?? ''), ts: clock() });
          appendFileSync(join(dir, 'broadcast.log'), line + '\n');
          return { ok: true, output: `broadcast from ${config.agentId}` };
        }
        default:
          return { ok: false, output: '', error: `unknown agent_sync action: ${action}` };
      }
    } catch (err) {
      return { ok: false, output: '', error: err instanceof Error ? err.message : String(err) };
    }
  });

  return handlers;
}

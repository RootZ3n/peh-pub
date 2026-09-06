/**
 * LAB CONTEXT TOOLS — bridge agents to lab-memory (the shared project state store).
 *
 * Three tools that give every agent access to the lab's shared memory:
 * - lab_context_read: read current entries for a project, or view a specific entry
 * - lab_context_write: create new entries or supersede existing ones
 * - lab_context_query: query by project, status, tags
 *
 * lab-memory is the DIRECT STORE — agents write to it directly.
 * ikbi reads from it for intelligence (patterns, projections, drift detection).
 *
 * Storage: git-versioned markdown files with YAML frontmatter in
 * <root>/memory/*.md. Every mutation is a git commit (full audit trail).
 *
 * Key invariant: supersession chains have exactly ONE current entry.
 */

import { join } from 'node:path';
import type { ToolSpec, ToolHandler } from '../tools.js';
import { scanForInjection } from './prompt-injection.js';
import { sanitizeMessage } from './input-sanitization.js';
import { DATA_ROOT_VARIABLES, requiredDataRoot } from '../data-roots.js';

/** Lazy-loaded lab-memory store — initialized on first use. */
let _store: any = null;
let _storeRoot: string | null = null;

function getStoreRoot(): string {
  return requiredDataRoot(...DATA_ROOT_VARIABLES.memory);
}

async function getStore() {
  if (_store && _storeRoot === getStoreRoot()) return _store;
  const root = getStoreRoot();
  // Dynamic import so we don't crash if lab-memory isn't installed.
  // NOTE: reads only. createMemoryStore({ root }) is unguarded; this handler never
  // calls its createMemory/supersedeMemory — durable writes go through governance
  // (proposeMemoryCreate / proposeMemorySupersede) below.
  const { createMemoryStore } = await import(join(root, 'src/store.js'));
  _store = createMemoryStore({ root });
  _storeRoot = root;
  return _store;
}

/** Load lab-memory's agent-facing proposal API (no durable write — returns a pending proposal). */
async function getGovernance() {
  const root = getStoreRoot();
  const { proposeMemoryCreate, proposeMemorySupersede } = await import(join(root, 'src/governance.js'));
  return { proposeMemoryCreate, proposeMemorySupersede };
}

/** Render a lab-memory proposal as a clear, non-installed tool result. */
function renderProposal(p: any): string {
  return [
    `Lab memory ${p.kind} PROPOSAL created — NOT installed.`,
    `  target:    ${p.target}`,
    `  project:   ${p.project}`,
    `  risk:      ${p.risk}`,
    `  status:    ${p.status} — pending verification + human approval`,
    `  installed: no (shared lab memory is unchanged)`,
    ``,
    `Durable lab memory is governed: this proposal must be verified and approved through`,
    `improvement-governance before it is installed. Nothing was written to disk.`,
  ].join('\n');
}

// ── Tool specs ───────────────────────────────────────────────────────────────

export const labContextToolSpecs: ToolSpec[] = [
  {
    name: 'lab_context_read',
    description: `Read shared lab memory. Two modes:
- List mode: provide 'project' to get all current entries for that project (cheap frontmatter scan)
- View mode: provide 'id' to get a specific entry's full body

Returns memory entries with: id, title, description, project, status, version, tags, body.`,
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name to list current entries for (e.g. "nusika", "ikbi")' },
        id: { type: 'string', description: 'Specific memory entry id to view full body' },
        status: { type: 'string', enum: ['current', 'superseded', 'all'], description: 'Filter by status (default: current)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'lab_context_write',
    description: `Propose a change to shared lab memory. Two modes:
- Create: provide id, title, description, project, body to propose a new entry
- Supersede: provide oldId, newId, title, description, project, body to propose replacing an entry

GOVERNED: this does NOT install durable memory. It creates a governance proposal
(returns its target + risk) that must be verified and approved by a human through
improvement-governance before anything is written. Reads are direct; writes are proposals.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'supersede'], description: 'Write mode' },
        id: { type: 'string', description: 'New entry id (slug: lowercase, digits, hyphens)' },
        oldId: { type: 'string', description: 'For supersede: the current entry being replaced' },
        newId: { type: 'string', description: 'For supersede: the new entry id' },
        title: { type: 'string', description: 'Short title' },
        description: { type: 'string', description: 'One-line description' },
        project: { type: 'string', description: 'Project name (e.g. "nusika", "ikbi")' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
        body: { type: 'string', description: 'Markdown body (what happened, what is current)' },
      },
      required: ['action', 'title', 'description', 'project', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'lab_context_query',
    description: `Query shared lab memory with filters. Returns matching entries (frontmatter only, no body).
Use this to find entries by project, status, or tags before reading specific ones.`,
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Filter by project name' },
        status: { type: 'string', enum: ['current', 'superseded'], description: 'Filter by status' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (all must match)' },
        chainHealth: { type: 'string', description: 'Get chain health for a project (current + stranded)' },
      },
      additionalProperties: false,
    },
  },
];

// ── Tool handlers ────────────────────────────────────────────────────────────

const readHandler: ToolHandler = async (args) => {
  try {
    const store = await getStore();

    // View mode: specific entry
    if (args.id && typeof args.id === 'string') {
      const entry = store.viewMemory(args.id);
      return {
        ok: true,
        output: formatEntry(entry),
      };
    }

    // List mode: project entries
    const project = args.project as string | undefined;
    const status = (args.status as string) || 'current';
    const entries = store.listMemory({
      ...(project ? { project } : {}),
      ...(status !== 'all' ? { status } : {}),
    });

    if (entries.length === 0) {
      return { ok: true, output: project ? `No entries for project "${project}"` : 'No entries found' };
    }

    const formatted = entries.map((e: any) =>
      `- ${e.id} (v${e.version}, ${e.status}): ${e.description} [${e.tags.join(', ')}]`
    ).join('\n');

    return { ok: true, output: `Found ${entries.length} entries:\n${formatted}` };
  } catch (err) {
    return { ok: false, output: '', error: `lab_context_read failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};

const writeHandler: ToolHandler = async (args) => {
  try {
    const action = args.action as string;

    // Scan for injection in the body
    const body = args.body as string;
    const scan = scanForInjection(body, 'strict');
    if (scan.detected) {
      return {
        ok: false,
        output: '',
        error: `Content flagged for potential injection: ${scan.patterns.join(', ')}. Please revise.`,
      };
    }

    // Sanitize all text fields
    const sanitize = (s: unknown) => typeof s === 'string' ? sanitizeMessage(s) : '';

    // GOVERNANCE BOUNDARY: this agent-facing tool may PROPOSE durable lab-memory
    // changes but may NOT install them. It calls lab-memory's proposal API (which
    // never writes) instead of the store's createMemory/supersedeMemory. Install
    // happens only after the proposal is verified + approved through
    // improvement-governance.
    const { proposeMemoryCreate, proposeMemorySupersede } = await getGovernance();

    if (action === 'create') {
      if (!args.id || typeof args.id !== 'string') {
        return { ok: false, output: '', error: 'create requires an id (slug)' };
      }
      const proposal = proposeMemoryCreate({
        id: args.id,
        title: sanitize(args.title),
        description: sanitize(args.description),
        project: sanitize(args.project),
        tags: Array.isArray(args.tags) ? args.tags.map(sanitize) : [],
        body: sanitize(body),
      });
      return { ok: true, output: renderProposal(proposal) };
    }

    if (action === 'supersede') {
      if (!args.oldId || typeof args.oldId !== 'string') {
        return { ok: false, output: '', error: 'supersede requires oldId' };
      }
      if (!args.newId || typeof args.newId !== 'string') {
        return { ok: false, output: '', error: 'supersede requires newId' };
      }
      const proposal = proposeMemorySupersede({
        oldId: args.oldId,
        newId: args.newId,
        title: sanitize(args.title),
        description: sanitize(args.description),
        project: sanitize(args.project),
        tags: Array.isArray(args.tags) ? args.tags.map(sanitize) : [],
        body: sanitize(body),
      });
      return { ok: true, output: renderProposal(proposal) };
    }

    return { ok: false, output: '', error: `Unknown action: ${action}. Use 'create' or 'supersede'.` };
  } catch (err) {
    return { ok: false, output: '', error: `lab_context_write failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};

const queryHandler: ToolHandler = async (args) => {
  try {
    const store = await getStore();

    // Chain health mode
    if (args.chainHealth && typeof args.chainHealth === 'string') {
      const health = store.chainHealth(args.chainHealth);
      const current = health.current.map((e: any) =>
        `  ✅ ${e.id} (v${e.version}): ${e.description}`
      ).join('\n');
      const stranded = health.stranded.map((e: any) =>
        `  ⚠️ ${e.id} (v${e.version}): ${e.description} → broken chain`
      ).join('\n');
      return {
        ok: true,
        output: [
          `Chain health for "${args.chainHealth}":`,
          `Current (${health.current.length}):`,
          current || '  (none)',
          `Stranded (${health.stranded.length}):`,
          stranded || '  (none)',
        ].join('\n'),
      };
    }

    // Filter query
    const entries = store.listMemory({
      ...(args.project ? { project: args.project } : {}),
      ...(args.status ? { status: args.status } : {}),
      ...(Array.isArray(args.tags) ? { tags: args.tags } : {}),
    });

    if (entries.length === 0) {
      return { ok: true, output: 'No matching entries found' };
    }

    const formatted = entries.map((e: any) =>
      `- ${e.id} (v${e.version}, ${e.status}, ${e.project}): ${e.description} [${e.tags.join(', ')}]`
    ).join('\n');

    return { ok: true, output: `Found ${entries.length} entries:\n${formatted}` };
  } catch (err) {
    return { ok: false, output: '', error: `lab_context_query failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatEntry(entry: any): string {
  const lines = [
    `# ${entry.title}`,
    ``,
    `**ID:** ${entry.id} | **Status:** ${entry.status} | **Version:** ${entry.version} | **Project:** ${entry.project}`,
    `**Description:** ${entry.description}`,
    entry.tags.length > 0 ? `**Tags:** ${entry.tags.join(', ')}` : '',
    entry.supersedes ? `**Supersedes:** ${entry.supersedes}` : '',
    entry.supersededBy ? `**Superseded by:** ${entry.supersededBy}` : '',
    ``,
    '---',
    ``,
    entry.body,
  ].filter(Boolean);
  return lines.join('\n');
}

// ── Handler map ──────────────────────────────────────────────────────────────

export function createLabContextToolHandlers(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  handlers.set('lab_context_read', readHandler);
  handlers.set('lab_context_write', writeHandler);
  handlers.set('lab_context_query', queryHandler);
  return handlers;
}

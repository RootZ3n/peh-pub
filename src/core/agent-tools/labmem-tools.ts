/**
 * LABMEM TOOLS — bridge this agent to labmem, the lab-wide memory system
 * (lab-utilities/lab-memory/labmem). Distinct from lab_context_* (the legacy
 * lab-memory project store): labmem holds scope/confidence/provenance memory,
 * shared lab rules, the repo map, the graph, and this agent's OWN private +
 * project memory.
 *
 * - labmem_recall:   what THIS agent should remember (shared + own + project),
 *                    or search visible memory. Read-only, always safe.
 * - labmem_remember: record a memory. The agent may freely write its OWN memory
 *                    (scope:agent/project, this agent's namespace). Writes to
 *                    GLOBAL/shared lab memory are forced to DRY-RUN — an agent
 *                    proposes; a human applies via the `memory` CLI. Every write
 *                    emits a receipt with rollback; existing ids are never
 *                    silently overwritten (use correction via the CLI).
 *
 * We dynamic-import labmem's BUILT dist (works whether this agent runs under tsx
 * or compiled node), falling back to its TS source under tsx. A missing labmem
 * never crashes the agent — reads/writes degrade to a clear tool error.
 */

import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolSpec, ToolHandler } from '../tools.js';
import { scanForInjection } from './prompt-injection.js';
import { sanitizeMessage } from './input-sanitization.js';
import { DATA_ROOT_VARIABLES, requiredDataRoot } from '../data-roots.js';

/** This agent's labmem namespace (scope:agent / scope:project key). */
const AGENT = 'pehlichi-pub';

function labmemRoot(): string {
  return requiredDataRoot(...DATA_ROOT_VARIABLES.vault);
}

/** Lazy dynamic import of labmem: built dist first (compiled-safe), TS source fallback (tsx dev). */
let _core: any = null;
async function core(): Promise<any> {
  if (_core) return _core;
  const root = labmemRoot();
  try {
    _core = await import(join(root, 'dist/index.js'));
  } catch {
    _core = await import(join(root, 'core/index.js'));
  }
  return _core;
}

const sanitize = (s: unknown): string => (typeof s === 'string' ? sanitizeMessage(s) : '');
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const labmemToolSpecs: ToolSpec[] = [
  {
    name: 'labmem_recall',
    description: `Recall from lab-wide memory (labmem): shared lab rules, the repo map, cross-agent facts, plus THIS agent's own private + project memory. Other agents' private memory is never returned.
- No args: returns your full recall block.
- Provide 'query' to search your visible memory by substring.`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional substring to search visible lab memory' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'labmem_remember',
    description: `Record a memory in labmem. You may freely write your OWN memory (scope 'agent' or 'project' — stored under your namespace). Writes to scope 'global'/'user' (shared lab memory) are recorded as a DRY-RUN proposal only — a human applies them via the memory CLI. Existing ids are never overwritten. Every write returns a receipt with rollback.`,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Entry id (slug: lowercase, digits, hyphens)' },
        title: { type: 'string', description: 'Short title' },
        description: { type: 'string', description: 'One-line description' },
        body: { type: 'string', description: 'Markdown body (the fact / decision / state)' },
        scope: { type: 'string', enum: ['agent', 'project', 'global', 'user'], description: "Default 'agent' (your private memory)" },
        type: { type: 'string', enum: ['semantic', 'procedural', 'project', 'shared'], description: 'Memory type (default semantic; project for scope project)' },
        confidence: { type: 'string', enum: ['observed', 'user-stated', 'inferred'], description: 'How you know this (default observed)' },
        subject: { type: 'string', description: 'Optional stable subject key (e.g. "repo:x:owner") to enable conflict detection' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
        apply: { type: 'boolean', description: 'Apply the write (own memory only). Default false = dry-run preview.' },
      },
      required: ['id', 'title', 'description', 'body'],
      additionalProperties: false,
    },
  },
];

const recallHandler: ToolHandler = async (args) => {
  try {
    const c = await core();
    const root = labmemRoot();
    if (args.query && typeof args.query === 'string') {
      const store = c.createStore({ root });
      const q = args.query.toLowerCase();
      const visible = store.visibleToAgent(AGENT).filter((m: any) => m.status === 'current');
      const hits = visible.filter((m: any) =>
        [m.id, m.title, m.description, (m.tags || []).join(' '), m.subject || ''].join(' ').toLowerCase().includes(q),
      );
      if (hits.length === 0) return { ok: true, output: `No lab memory matches "${args.query}"` };
      return { ok: true, output: hits.map((m: any) => `- ${m.fqid} [${m.confidence}]: ${m.title} — ${m.description}`).join('\n') };
    }
    return { ok: true, output: c.renderRecall(c.recall(root, AGENT)) };
  } catch (err) {
    return { ok: false, output: '', error: `labmem_recall failed: ${msg(err)}` };
  }
};

const rememberHandler: ToolHandler = async (args) => {
  try {
    const body = String(args.body ?? '');
    const scan = scanForInjection(body, 'strict');
    if (scan.detected) {
      return { ok: false, output: '', error: `Content flagged for potential injection: ${scan.patterns.join(', ')}. Please revise.` };
    }
    const scope = (typeof args.scope === 'string' ? args.scope : 'agent');
    const isGlobal = scope === 'global' || scope === 'user';
    const apply = args.apply === true;
    // Agents may apply their OWN memory; GLOBAL/shared writes are always dry-run proposals.
    const dryRun = isGlobal ? true : !apply;
    const namespace = isGlobal ? (scope === 'user' ? 'user' : 'global') : AGENT;

    const c = await core();
    const store = c.createStore({ root: labmemRoot() });
    const res = store.addMemory({
      id: String(args.id ?? ''),
      scope,
      namespace,
      memoryType: (typeof args.type === 'string' ? args.type : scope === 'project' ? 'project' : 'semantic'),
      confidence: (typeof args.confidence === 'string' ? args.confidence : 'observed'),
      source: `agent:${AGENT}`,
      actor: AGENT,
      title: sanitize(args.title),
      description: sanitize(args.description),
      body: sanitize(body),
      tags: Array.isArray(args.tags) ? args.tags.map((t: unknown) => sanitize(t)) : [],
      shared: args.shared === true,
      subject: typeof args.subject === 'string' ? args.subject : null,
    }, { dryRun });
    // Applied own-memory writes refresh the index; dry-run/shared proposals leave a
    // DURABLE proposal receipt instead (the memory write itself is NOT applied).
    let proposalPath: string | undefined;
    if (!dryRun) {
      c.rebuildIndex(labmemRoot());
    } else if (typeof c.writeProposal === 'function') {
      proposalPath = c.writeProposal(labmemRoot(), res.receipt);
    }

    const lines = [`${res.receipt.result}: ${res.meta.fqid}`];
    if (isGlobal) lines.push(`(shared lab memory is not applied by agents — recorded as a dry-run proposal; a human applies it via the \`memory\` CLI)`);
    lines.push(`rollback: ${res.receipt.rollback}`);
    if (proposalPath) lines.push(`proposal receipt: ${proposalPath}`);
    if (res.conflicts.length > 0) lines.push(`⚠️ conflict on subject: ${res.conflicts.map((cf: any) => cf.subject).join(', ')} — surface this, do not paper over it`);
    return { ok: true, output: lines.join('\n') };
  } catch (err) {
    return { ok: false, output: '', error: `labmem_remember failed: ${msg(err)}` };
  }
};

export function createLabmemToolHandlers(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  handlers.set('labmem_recall', recallHandler);
  handlers.set('labmem_remember', rememberHandler);
  return handlers;
}

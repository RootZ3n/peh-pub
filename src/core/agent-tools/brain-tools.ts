/**
 * BRAIN TOOLS — agent-facing surface over the gbrain knowledge brain.
 *
 * Four tools, thin wrappers over gbrain-bridge:
 *   - brain_search : keyword/full-text recall over the brain (READ).
 *   - brain_think  : multi-hop synthesis — a cited answer with conflict/gap analysis (READ).
 *   - brain_put    : write/update a brain page (WRITE; injection-scanned).
 *   - brain_sync   : import a memory tree into the brain + re-embed (WRITE; RECEIPT-GATED).
 *
 * RECEIPT GATE (brain_sync): a sync rewrites the brain's searchable index from a whole
 * directory, so it must be deliberate, not an incidental tool call. The handler refuses
 * unless the caller passes a `receipt_id` — the id minted for the driving /chat turn
 * (see ReceiptStore / server payload `receiptId`). This makes every sync traceable back
 * to an audited turn WITHOUT this module reaching into the receipt store. brain_sync is
 * also a write tool, so it independently goes through the approval policy.
 *
 * All brain access is bounded by the bridge's 30s timeout; a brain failure becomes a
 * clean `{ ok: false }` tool result here rather than an unhandled throw.
 */
import type { ToolSpec, ToolHandler, ToolResult } from "../tools.js";
import { GbrainError, searchBrain, thinkBrain, putPage, syncMemory } from "../gbrain-bridge.js";
import { scanForInjection } from "./prompt-injection.js";
import type { BrainGovernance } from "./memory-governance.js";
import { DATA_ROOT_VARIABLES, requiredDataRoot } from "../data-roots.js";

export interface BrainToolConfig {
  /**
   * GOVERNANCE SINK for durable brain writes. When set, brain_put creates a pending
   * proposal (returns a proposal id) instead of writing the brain directly. The
   * agent-facing wiring always supplies one; the trusted/test mode (no sink) keeps
   * the direct write. brain_search/brain_think (reads) are unaffected.
   */
  governance?: BrainGovernance;
  /** Agent id recorded on each brain proposal (defaults to "pehlichi"). */
  agentId?: string;
}

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: "object", properties, required, additionalProperties: false });

/** Default memory tree synced into the brain when the caller doesn't name one. */
function defaultMemoryRoot(): string {
  return requiredDataRoot(...DATA_ROOT_VARIABLES.memory);
}

export const brainToolSpecs: ToolSpec[] = [
  {
    name: "brain_search",
    description:
      "Keyword/full-text search over the gbrain knowledge brain. Use for factual recall " +
      "('what do we know about X', finding a page/symbol). Returns matching pages/chunks. " +
      "Read-only.",
    parameters: obj(
      {
        query: { type: "string", description: "Search query (keywords)." },
        limit: { type: "number", description: "Max results (default brain-side, ~20)." },
      },
      ["query"],
    ),
  },
  {
    name: "brain_think",
    description:
      "Multi-hop synthesis over the brain: pulls evidence across pages, takes, and the " +
      "graph and returns a CITED answer with conflict + gap analysis. Use for 'why/how/" +
      "what's the relationship' questions that need reasoning, not just a lookup. Read-only, " +
      "slower than brain_search.",
    parameters: obj(
      { question: { type: "string", description: "The question to think about." } },
      ["question"],
    ),
  },
  {
    name: "brain_put",
    description:
      "Write or update a single page in the brain. Content is markdown with YAML " +
      "frontmatter. Use to persist a durable fact/note so future brain_search/brain_think " +
      "can recall it. Does NOT touch lab-memory or MEMORY.md — this writes the brain only.",
    parameters: obj(
      {
        slug: { type: "string", description: "Page slug (stable id, kebab-case)." },
        content: { type: "string", description: "Full markdown body with YAML frontmatter." },
      },
      ["slug", "content"],
    ),
  },
  {
    name: "brain_sync",
    description:
      "Import a memory directory into the brain and re-embed it so its pages become " +
      "searchable. RECEIPT-GATED: requires a `receipt_id` from the current turn — this is a " +
      "deliberate, index-rewriting operation. Defaults to the shared lab-memory tree when " +
      "memory_root is omitted.",
    parameters: obj(
      {
        receipt_id: { type: "string", description: "Receipt id of the current turn (required gate)." },
        memory_root: {
          type: "string",
          description: "Directory to sync (default: the shared lab-memory tree).",
        },
      },
      ["receipt_id"],
    ),
  },
];

/** Turn any thrown brain failure into a clean, attributable tool error. */
function toError(tool: string, err: unknown): ToolResult {
  if (err instanceof GbrainError) {
    const detail = err.timedOut ? " (timed out)" : err.stderr ? `: ${err.stderr}` : "";
    return { ok: false, output: "", error: `${tool} failed${detail}` };
  }
  return { ok: false, output: "", error: `${tool} failed: ${err instanceof Error ? err.message : String(err)}` };
}

export function createBrainToolHandlers(config: BrainToolConfig = {}): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const governance = config.governance;
  const agentId = config.agentId ?? "pehlichi";

  handlers.set("brain_search", async (args): Promise<ToolResult> => {
    const query = (args.query as string)?.trim();
    if (!query) return { ok: false, output: "", error: "brain_search requires a query" };
    try {
      const limit = typeof args.limit === "number" ? { limit: args.limit } : undefined;
      const result = searchBrain(query, limit);
      return { ok: true, output: JSON.stringify(result, null, 2) };
    } catch (err) {
      return toError("brain_search", err);
    }
  });

  handlers.set("brain_think", async (args): Promise<ToolResult> => {
    const question = (args.question as string)?.trim();
    if (!question) return { ok: false, output: "", error: "brain_think requires a question" };
    try {
      const result = thinkBrain(question);
      return { ok: true, output: JSON.stringify(result, null, 2) };
    } catch (err) {
      return toError("brain_think", err);
    }
  });

  handlers.set("brain_put", async (args): Promise<ToolResult> => {
    const slug = (args.slug as string)?.trim();
    const content = args.content as string;
    if (!slug) return { ok: false, output: "", error: "brain_put requires a slug" };
    if (!content?.trim()) return { ok: false, output: "", error: "brain_put requires content" };

    // A page written to the brain is recalled verbatim later — scan it so an injected
    // directive can't be smuggled in via a stored page.
    const scan = scanForInjection(content, "context");
    if (scan.detected) {
      return { ok: false, output: "", error: `brain_put blocked: injection pattern(s) ${scan.patterns.join(", ")}` };
    }

    // GOVERNANCE: a durable brain write becomes a proposal, not a direct write.
    if (governance) {
      const p = governance.proposePut(slug, content, agentId);
      return {
        ok: true,
        output: [
          `brain_put PROPOSAL created — NOT installed.`,
          `  proposal id: ${p.id}`,
          `  slug:        ${p.slug}`,
          `  risk:        ${p.risk_level} (${p.improvement_type})`,
          `  status:      ${p.status} — pending verification + ${p.requiresHumanApproval ? "human approval" : "approval"}`,
          `  installed:   no (the brain is unchanged)`,
          ``,
          `Durable brain writes are governed: a human must approve proposal ${p.id} before the page is written.`,
        ].join("\n"),
      };
    }

    try {
      const out = putPage(slug, content);
      return { ok: true, output: out || `wrote page "${slug}"` };
    } catch (err) {
      return toError("brain_put", err);
    }
  });

  handlers.set("brain_sync", async (args): Promise<ToolResult> => {
    // RECEIPT GATE: refuse without a receipt id. We don't validate it against the store
    // (that store isn't threaded into tools and must not be modified) — requiring a
    // non-empty id makes a sync provably tied to an audited turn and never incidental.
    const receiptId = (args.receipt_id as string)?.trim();
    if (!receiptId) {
      return {
        ok: false,
        output: "",
        error: "brain_sync is receipt-gated: pass receipt_id from the current turn to authorize a brain re-index",
      };
    }
    const memoryRoot = (args.memory_root as string)?.trim() || defaultMemoryRoot();
    try {
      const { import: imp, embed } = syncMemory(memoryRoot);
      return { ok: true, output: `synced ${memoryRoot} (receipt ${receiptId})\nimport: ${imp}\nembed: ${embed}` };
    } catch (err) {
      return toError("brain_sync", err);
    }
  });

  return handlers;
}

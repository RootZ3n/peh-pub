/**
 * AGENT TOOLS — full tool suite for lab agents.
 *
 * Provides the same tool registry as Hermes:
 * - Browser tools (Playwright-based)
 * - Web tools (search, extract)
 * - Enhanced file tools (read, write, search, patch)
 * - Vision tools (image analysis)
 * - Execute code (sandboxed Python/Node)
 * - Delegate task (sub-agent spawning)
 * - Todo (task management)
 *
 * Usage:
 *   import { createFullToolRegistry } from './agent-tools/index.js';
 *   const extraTools = createFullToolRegistry({ workspaceRoot, agentServerUrl, apiKey });
 *   const registry = createToolRegistry(extraTools);
 */
import type { ToolDef } from '../tools.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAgentInShadow } from '../loop.js';
import { MimoDriver } from '../drivers/mimo.js';
import type { AgentEvent, AgentProfile } from '../index.js';

import { browserToolSpecs, createBrowserToolHandlers } from './browser-tools.js';
import { webToolSpecs, createWebToolHandlers } from './web-tools.js';
import { enhancedFileToolSpecs, createEnhancedFileToolHandlers } from './enhanced-file-tools.js';
import { visionToolSpecs, createVisionToolHandlers } from './vision-tools.js';
import { executeCodeToolSpecs, createExecuteCodeToolHandlers } from './execute-code-tools.js';
import { delegateToolSpecs, createDelegateToolHandlers } from './delegate-tools.js';
import { todoToolSpecs, createTodoToolHandlers } from './todo-tools.js';
import { skillToolSpecs, createSkillToolHandlers } from './skill-tools.js';
import { memoryToolSpecs, createMemoryToolHandlers } from './memory-tools.js';
import { createFileMemoryGovernance, createFileBrainGovernance } from './memory-governance.js';
import { cronToolSpecs, createCronToolHandlers } from './cron-tools.js';
import { clarifyToolSpecs, createClarifyToolHandlers } from './clarify-tools.js';
import { coordinationToolSpecs, createCoordinationToolHandlers } from './coordination-tools.js';
import { brainToolSpecs, createBrainToolHandlers } from './brain-tools.js';
import { ikbiToolSpecs, createIkbiToolHandlers } from './ikbi-tools.js';
import { musicToolSpecs, createMusicToolHandlers } from './music-tools.js';
import { labContextToolSpecs, createLabContextToolHandlers } from './lab-context-tools.js';
import { labmemToolSpecs, createLabmemToolHandlers } from './labmem-tools.js';
import { bridgeToolSpecs, createBridgeToolHandlers } from '../bridges/bridge-tools.js';
import { bridgeRegistry } from '../bridges/registry.js';
// OPTIONAL tool modules (Phase C): present in the SHARED registry, enabled per-agent via
// AgentToolConfig flags so this file is identical across every agent. Default OFF.
import { teachingToolSpecs, createTeachingToolHandlers } from './teaching-tools.js';
import { workOrderToolSpecs, createWorkOrderToolHandlers } from '../../tools/work-order-tools.js';
import { occasioToolSpecs, createOccasioToolHandlers } from '../occasio-bridge.js';
import { DATA_ROOT_VARIABLES, requiredDataRoot } from '../data-roots.js';

export interface AgentToolConfig {
  /** Workspace root for file operations */
  workspaceRoot: string;
  /** Agent's own HTTP server URL (retained for compatibility; delegation no longer uses it) */
  agentServerUrl: string;
  /** API key for vision/LLM calls */
  apiKey?: string;
  /** Skills directory root */
  skillsRoot?: string;
  /** Memory directory root */
  memoryDir?: string;
  /**
   * Path to the sub-agent runner script `delegate_task` spawns. Defaults to the
   * sub-agent entry next to this module, with the extension and node args chosen
   * automatically for the runtime (see resolveSubagentRunner). Override in tests to
   * point at a fixture runner.
   */
  subagentRunnerPath?: string;
  /**
   * Node args inserted BEFORE the runner path when spawning the sub-agent. Defaults
   * to `['--import','tsx']` under tsx (so the `.ts` entry runs directly) and `[]`
   * when running compiled `.js`. Override alongside `subagentRunnerPath` in tests.
   */
  subagentNodeArgs?: readonly string[];
  /** Hard timeout (ms) for a delegated sub-agent (default 5 minutes). */
  delegateTimeoutMs?: number;
  /**
   * APPROVAL (N5): whether delegated sub-agents may run write/destructive tools.
   * Defaults to false — a sub-agent inherits the restrictive posture so delegation
   * cannot escalate authority beyond the agent that spawned it. Servers thread their
   * own write posture (`allowWrites`) in here.
   */
  delegateAllowWrites?: boolean;
  /**
   * COORDINATION (Blocker 7): the SHARED directory agent_sync reads/writes so the
   * agents can exchange results. Defaults to $AGENT_SYNC_DIR, else the sibling
   * lab-store's `.agent-sync` dir — one source of truth for the whole lab.
   */
  coordinationDir?: string;
  /** This agent's id, recorded on each agent_sync entry. Defaults to the workspace basename. */
  agentId?: string;
  /**
   * PERSISTENCE (Blocker 3): where cron jobs are persisted (a JSON file). Defaults to
   * `<workspaceRoot>/.cron-jobs.json`. Jobs are reloaded and active ones rescheduled
   * when the registry is built, so schedules survive a restart.
   */
  cronStorePath?: string;
  /**
   * Override the cron execute callback (tests inject a mock so no model runs). Unset =>
   * the default runs a REAL agent loop in a disposable shadow workspace.
   */
  cronExecute?: (prompt: string) => Promise<string>;
  /**
   * OPTIONAL TOOL MODULES (Phase C) — agent-specialization as config, not forked code. The
   * shared registry contains every optional module; each agent enables only the ones its role
   * uses, so `index.ts` is byte-identical across all agents. All default OFF.
   */
  /** pehlichi-pub teaching tools: teach_lesson / teach_hover / teach_challenge (lesson cards). */
  enableTeaching?: boolean;
  /** Ptah work-order tools: typed CRUD over the lab repair queue. */
  enableWorkOrders?: boolean;
  /** Ptah occasio bridge: file a detection as a work order + route it through the trio. */
  enableOccasio?: boolean;
}

/**
 * The default cron executor (Blocker 3): runs a REAL, independent agent loop in a
 * fresh disposable shadow workspace and returns its closing summary. This is what
 * makes a scheduled job actually DO work instead of reporting a hollow success.
 */
function defaultCronExecute(config: AgentToolConfig): (prompt: string) => Promise<string> {
  const profile: AgentProfile = {
    name: 'CronRunner',
    role: 'builder',
    personaPreamble: 'You are a scheduled task runner. Accomplish the task, then finish with done.',
    skillTags: [],
  };
  return async (prompt: string): Promise<string> => {
    const events: AgentEvent[] = [];
    const labStore = join(config.workspaceRoot, '.cron-store');
    await runAgentInShadow({
      profile,
      task: prompt,
      labStoreRoot: labStore,
      driver: new MimoDriver(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
      sinks: [(e) => events.push(e)],
      plan: false,
    });
    const summary = events.find((e): e is Extract<AgentEvent, { kind: 'summary' }> => e.kind === 'summary');
    return summary
      ? [summary.rootCause, ...summary.changes, ...summary.verification].join('\n')
      : '(cron job finished without a summary)';
  };
}

/**
 * Resolve the sub-agent runner for the CURRENT runtime.
 *
 * Under tsx, this module is loaded as `src/core/agent-tools/index.ts`, so
 * `import.meta.url` ends in `.ts`; the sibling `subagent-entry.js` does NOT exist
 * (only the `.ts` source does), and a `.js` runner path would fail to spawn. We
 * detect that by the extension of THIS module's own path: a `.ts` module means we
 * are under tsx, so the runner is `subagent-entry.ts` spawned with `--import tsx`.
 * Compiled (`.js`) mode keeps the proven `.js` runner with no extra node args.
 */
export function resolveSubagentRunner(): { runnerPath: string; nodeArgs: readonly string[] } {
  const thisFile = fileURLToPath(import.meta.url);
  const underTsx = thisFile.endsWith('.ts');
  const ext = underTsx ? '.ts' : '.js';
  return {
    runnerPath: join(dirname(thisFile), '..', `subagent-entry${ext}`),
    nodeArgs: underTsx ? ['--import', 'tsx'] : [],
  };
}

/**
 * Create the full set of extra tools matching Hermes' tool registry.
 * Returns a ToolDef[] that can be passed to createToolRegistry(extraTools).
 */
export function createFullToolRegistry(config: AgentToolConfig): ToolDef[] {
  const browserHandlers = createBrowserToolHandlers();
  const webHandlers = createWebToolHandlers();
  const fileHandlers = createEnhancedFileToolHandlers(config.workspaceRoot);
  const visionHandlers = createVisionToolHandlers(config.apiKey);
  const executeCodeHandlers = createExecuteCodeToolHandlers();
  const resolved = resolveSubagentRunner();
  const delegateHandlers = createDelegateToolHandlers({
    runnerPath: config.subagentRunnerPath ?? resolved.runnerPath,
    nodeArgs: config.subagentNodeArgs ?? resolved.nodeArgs,
    ...(config.delegateTimeoutMs !== undefined ? { timeoutMs: config.delegateTimeoutMs } : {}),
    ...(config.delegateAllowWrites !== undefined ? { allowWrites: config.delegateAllowWrites } : {}),
  });
  const todoHandlers = createTodoToolHandlers();
  const skillsRoot = config.skillsRoot ?? join(config.workspaceRoot, 'skills');
  const skillHandlers = createSkillToolHandlers(skillsRoot);
  const memoryDir = config.memoryDir ?? join(config.workspaceRoot, 'memories');
  // GOVERNANCE BOUNDARY: the agent-facing memory tool ALWAYS gets a governance sink,
  // so durable add/replace/remove create proposals (returns a proposal id, no durable
  // write) instead of installing memory directly. Proposals land in <memoryDir>/.proposals
  // for human verification + approval. The raw handler keeps a trusted direct-write mode
  // (no sink) for internal callers/tests only.
  const memoryGovernance = createFileMemoryGovernance({ proposalsDir: join(memoryDir, '.proposals') });
  const memoryAgentId = config.agentId ?? config.workspaceRoot.split('/').filter(Boolean).pop() ?? 'pehlichi';
  const memoryHandlers = createMemoryToolHandlers({ memoryDir, governance: memoryGovernance, agentId: memoryAgentId });
  // CRON (Blocker 3): the execute callback runs a REAL agent loop in a disposable
  // shadow workspace and returns its summary — not a stub string. Jobs persist to a
  // JSON file and active ones re-arm on the next process start.
  const cronExecute = config.cronExecute ?? defaultCronExecute(config);
  const cronStorePath = config.cronStorePath ?? join(config.workspaceRoot, '.cron-jobs.json');
  const cronHandlers = createCronToolHandlers(cronExecute, { persistPath: cronStorePath, rearmOnLoad: true });

  // COORDINATION (Blocker 7): agent_sync over a shared directory.
  /*
    Fails closed: see ../data-roots.js. The sync directory is shared with four other agents, so a
    fallback here means one writer coordinating against a copy nobody else can see.

    Resolved LAZILY -- when the tool is used, not when the registry is wired. Refusal belongs at the
    moment data would be opened or created; refusing at construction takes down every caller that
    assembles a registry and never touches agent_sync, which is most of them.
  */
  const coordinationDir = config.coordinationDir !== undefined
    ? config.coordinationDir
    : (): string => requiredDataRoot(...DATA_ROOT_VARIABLES.sync);
  const agentId = config.agentId ?? config.workspaceRoot.split('/').filter(Boolean).pop() ?? 'agent';
  const coordinationHandlers = createCoordinationToolHandlers({ syncDir: coordinationDir, agentId });

  const clarifyHandlers = createClarifyToolHandlers();

  // BRAIN (gbrain bridge): search/think recall + put/sync write-back over the knowledge
  // brain. brain_sync is receipt-gated inside the handler. brain_put (durable write) is
  // routed through a governance proposal — the agent cannot write the brain directly.
  const brainGovernance = createFileBrainGovernance({ proposalsDir: join(memoryDir, '.proposals') });
  const brainHandlers = createBrainToolHandlers({ governance: brainGovernance, agentId: memoryAgentId });

  // IKBI (Phase 10.3): thin HTTP client over ikbi's build engine API. No config —
  // the base URL comes from IKBI_API_URL (default http://localhost:18796).
  const ikbiHandlers = createIkbiToolHandlers();

  // MUSIC: MiniMax Music 2.6 API for song generation, lyrics, and covers.
  // API key from MINIMAX_API_KEY env var.
  const musicHandlers = createMusicToolHandlers();

  // LAB CONTEXT: bridge agents to lab-memory (shared project state store).
  const labContextHandlers = createLabContextToolHandlers();

  // LABMEM: lab-wide memory system (recall shared/own/project memory; record own).
  const labmemHandlers = createLabmemToolHandlers();

  // BRIDGES: inter-agent communication via HTTP. getServiceUrl resolves service
  // names to base URLs using the bridge registry (known ports).
  const bridgeHandlers = createBridgeToolHandlers((name: string) => {
    const info = bridgeRegistry.get(name);
    if (!info || info.port === 0) return undefined;
    return `http://localhost:${info.port}`;
  });

  const tools: ToolDef[] = [];

  // Browser tools
  for (const spec of browserToolSpecs) {
    const handler = browserHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Web tools
  for (const spec of webToolSpecs) {
    const handler = webHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Enhanced file tools
  for (const spec of enhancedFileToolSpecs) {
    const handler = fileHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Vision tools
  for (const spec of visionToolSpecs) {
    const handler = visionHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Execute code tools
  for (const spec of executeCodeToolSpecs) {
    const handler = executeCodeHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Delegate tools
  for (const spec of delegateToolSpecs) {
    const handler = delegateHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Todo tools
  for (const spec of todoToolSpecs) {
    const handler = todoHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Skill tools
  for (const spec of skillToolSpecs) {
    const handler = skillHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Memory tools
  for (const spec of memoryToolSpecs) {
    const handler = memoryHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Cron tools
  for (const spec of cronToolSpecs) {
    const handler = cronHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Clarify tools
  for (const spec of clarifyToolSpecs) {
    const handler = clarifyHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Coordination tools (agent_sync)
  for (const spec of coordinationToolSpecs) {
    const handler = coordinationHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Brain tools (gbrain bridge)
  for (const spec of brainToolSpecs) {
    const handler = brainHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Ikbi tools (build engine HTTP bridge)
  for (const spec of ikbiToolSpecs) {
    const handler = ikbiHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Music tools (MiniMax Music 2.6)
  for (const spec of musicToolSpecs) {
    const handler = musicHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Lab context tools (lab-memory read/write/query)
  for (const spec of labContextToolSpecs) {
    const handler = labContextHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Labmem tools (lab-wide memory recall/record)
  for (const spec of labmemToolSpecs) {
    const handler = labmemHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Bridge tools (inter-agent communication via HTTP)
  // Bridge handlers use a simpler signature (args only); adapt to core ToolHandler (args, ctx).
  for (const spec of bridgeToolSpecs) {
    const bridgeHandler = bridgeHandlers.get(spec.name);
    if (bridgeHandler) {
      const handler = async (args: Record<string, unknown>, _ctx: any) => {
        const result = await bridgeHandler(args);
        return { ok: result.ok, output: result.output, ...(result.error !== undefined ? { error: result.error } : {}) };
      };
      tools.push({ spec, handler });
    }
  }

  // OPTIONAL tool modules (Phase C): identical code in every agent; enabled per role via config.
  if (config.enableTeaching) {
    const teachingHandlers = createTeachingToolHandlers();
    for (const spec of teachingToolSpecs) {
      const handler = teachingHandlers.get(spec.name);
      if (handler) tools.push({ spec, handler });
    }
  }
  if (config.enableWorkOrders) {
    const workOrderHandlers = createWorkOrderToolHandlers();
    for (const spec of workOrderToolSpecs) {
      const handler = workOrderHandlers.get(spec.name);
      if (handler) tools.push({ spec, handler });
    }
  }
  if (config.enableOccasio) {
    const occasioHandlers = createOccasioToolHandlers();
    for (const spec of occasioToolSpecs) {
      const handler = occasioHandlers.get(spec.name);
      if (handler) tools.push({ spec, handler });
    }
  }

  return tools;
}

// Re-export types for consumers
export type { ToolSpec, ToolHandler, ToolResult, ToolDef } from '../tools.js';
export { buildMemorySnapshot } from './memory-tools.js';

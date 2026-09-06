/**
 * AGENT CHAT SESSION — cache-first tool-calling loop with full infrastructure.
 *
 * Architecture (borrowed from Reasonix):
 * ┌──────────────────────────────────────┐
 * │ IMMUTABLE PREFIX  (frozen at start)   │ ← 85-95% cache target
 * │ system prompt + tool definitions      │   never changes mid-session
 * ├──────────────────────────────────────┤
 * │ APPEND-ONLY LOG  (monotonic growth)   │ ← grows each turn
 * │ [user₁][assistant₁][tool₁]...         │   never reordered, never mutated
 * ├──────────────────────────────────────┤
 * │ DYNAMIC CONTEXT  (per-turn)           │ ← injected as user message prefix
 * │ cwd, task context, instructions       │   NOT in system prompt
 * └──────────────────────────────────────┘
 *
 * Infrastructure wired in:
 * - Circuit breaker (provider failure protection)
 * - Iteration budget (runaway loop prevention)
 * - Prompt injection scanning (27 patterns, 3 scopes)
 * - Token monitoring (usage tracking, cost estimation)
 * - Input sanitization (surrogates, JSON repair, control chars)
 * - Schema sanitizer (llama.cpp/Ollama compatibility)
 * - Error classification (11 categories with actionable hints)
 * - Retry with jittered backoff
 */
import { join } from "node:path";
import { loadPersonality, buildPersonalityPrompt, type Personality } from './personality.js';
import { loadSkin, type Skin } from './skin.js';
import { createToolRegistry, toolSpecs, type ToolRegistry, type ToolResult } from '../../../src/core/tools.js';
import { createFullToolRegistry, buildMemorySnapshot, type AgentToolConfig } from '../../../src/core/agent-tools/index.js';
import { bridgeToolSpecs, createBridgeToolHandlers } from '../../../src/tools/bridge-tools.js';
import { ContextCompressor, type CompressResult } from '../../../src/core/context-compressor.js';

// Infrastructure imports
import { CircuitBreaker } from '../../../src/core/agent-tools/circuit-breaker.js';
import { IterationBudget } from '../../../src/core/agent-tools/iteration-budget.js';
import { scanForInjection, type ScanResult } from '../../../src/core/agent-tools/prompt-injection.js';
import { TokenMonitor } from '../../../src/core/agent-tools/token-monitor.js';
import { sanitizeMessage, sanitizeToolOutput } from '../../../src/core/agent-tools/input-sanitization.js';
import { sanitizeToolDefinitions } from '../../../src/core/agent-tools/schema-sanitizer.js';
import { classifyError } from '../../../src/core/agent-tools/error-classifier.js';
import { withRetry, isRetryable, sleep } from '../../../src/core/agent-tools/retry.js';
import { labContextToolSpecs, createLabContextToolHandlers } from '../../../src/core/agent-tools/lab-context-tools.js';
import { DATA_ROOT_VARIABLES, requiredDataRoot } from '../../../src/core/data-roots.js';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  tool_call_id?: string;
  name?: string;
}

export interface ChatResponse {
  content: string;
  thinkingVerb?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; result: ToolResult }>;
  cacheHit?: CacheHitInfo;
  tokenUsage?: ReturnType<TokenMonitor['summary']>;
  injectionDetected?: boolean;
}

export interface CacheHitInfo {
  cachedTokens: number;
  totalPromptTokens: number;
  hitPercent: string;
}

export type StreamCallback = (chunk: string) => void;

const MAX_TOOL_ITERATIONS = 20;
const MAX_TOKENS = 4096;
const CONTEXT_WINDOW = 128_000; // MiMo v2.5 context window

/**
 * Full agent chat session with cache-first tool-calling loop
 * and full infrastructure wiring.
 */
export class AgentChatSession {
  private messages: ChatMessage[] = [];
  private personality: Personality;
  private skin: Skin;
  private apiKey: string | undefined;
  private baseUrl: string;
  private model: string;
  private toolRegistry: ToolRegistry;
  private toolSchemas: Array<Record<string, unknown>>;
  private compressor: ContextCompressor;
  private workspaceRoot: string;

  // Infrastructure
  private circuitBreaker: CircuitBreaker;
  private budget: IterationBudget;
  private tokenMonitor: TokenMonitor;

  // Cache tracking
  private totalCacheHits = 0;
  private totalPromptTokens = 0;

  constructor(opts?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    workspaceRoot?: string;
    agentServerUrl?: string;
    maxIterations?: number;
  }) {
    this.personality = loadPersonality();
    this.skin = loadSkin();
    this.apiKey = opts?.apiKey ?? process.env.MIMO_API_KEY;
    this.baseUrl = opts?.baseUrl ?? 'https://api.xiaomimimo.com/v1';
    this.model = opts?.model ?? 'mimo-v2.5';
    this.workspaceRoot = opts?.workspaceRoot ?? process.cwd();

    // Build full tool registry
    const agentServerUrl = opts?.agentServerUrl ?? `http://localhost:${process.env.PORT || '18830'}`;

    const agentToolConfig: AgentToolConfig = {
      workspaceRoot: this.workspaceRoot,
      agentServerUrl,
      apiKey: this.apiKey,
    };

    const extraTools = createFullToolRegistry(agentToolConfig);

    // Add bridge tools
    const bridgeHandlers = createBridgeToolHandlers();
    for (const spec of bridgeToolSpecs) {
      const handler = bridgeHandlers.get(spec.name);
      if (handler) {
        extraTools.push({ spec, handler });
      }
    }

    // Add lab context tools (bridge to lab-memory)
    const labContextHandlers = createLabContextToolHandlers();
    for (const spec of labContextToolSpecs) {
      const handler = labContextHandlers.get(spec.name);
      if (handler) {
        extraTools.push({ spec, handler });
      }
    }

    this.toolRegistry = createToolRegistry(extraTools);

    // Sanitize tool schemas for provider compatibility
    const rawSchemas = toolSpecs(this.toolRegistry).map((spec) => ({
      type: 'function' as const,
      function: {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
      },
    }));
    this.toolSchemas = sanitizeToolDefinitions(rawSchemas);

    // Initialize context compressor
    this.compressor = new ContextCompressor({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      model: this.model,
      protectFirstN: 2,
      protectLastN: 3,
      thresholdPercent: 0.80,
      maxRuntimeMs: 30_000,
    });

    // Initialize infrastructure
    const providerId = this.detectProviderId();
    this.circuitBreaker = new CircuitBreaker(providerId, {
      failureThreshold: 5,
      cooldownMs: 30_000,
      successThreshold: 3,
    });
    this.budget = new IterationBudget(opts?.maxIterations ?? MAX_TOOL_ITERATIONS);
    this.tokenMonitor = new TokenMonitor({ model: this.model });

    // FROZEN SYSTEM PROMPT — never changes mid-session
    const frozenSystemPrompt = this.buildFrozenSystemPrompt();
    this.messages.push({
      role: 'system',
      content: frozenSystemPrompt,
      timestamp: Date.now(),
    });
  }

  /** Detect provider ID from base URL for circuit breaker. */
  private detectProviderId(): string {
    const url = this.baseUrl.toLowerCase();
    if (url.includes('xiaomimimo') || url.includes('mimo')) return 'mimo';
    if (url.includes('openrouter')) return 'openrouter';
    if (url.includes('localhost') || url.includes('127.0.0.1')) {
      if (url.includes('11434')) return 'ollama';
      return 'local';
    }
    return 'unknown';
  }

  getPersonality(): Personality {
    return this.personality;
  }

  getSkin(): Skin {
    return this.skin;
  }

  getHistory(): ChatMessage[] {
    return [...this.messages];
  }

  getToolNames(): string[] {
    return [...this.toolRegistry.keys()];
  }

  getCacheStats(): { totalHits: number; totalPromptTokens: number; hitRate: string } {
    const hitRate = this.totalPromptTokens > 0
      ? ((this.totalCacheHits / this.totalPromptTokens) * 100).toFixed(1)
      : '0.0';
    return {
      totalHits: this.totalCacheHits,
      totalPromptTokens: this.totalPromptTokens,
      hitRate: `${hitRate}%`,
    };
  }

  /** Get infrastructure status for monitoring. */
  getInfrastructureStatus(): {
    circuit: { state: string; failures: number };
    budget: { consumed: number; remaining: number; max: number };
    tokens: ReturnType<TokenMonitor['summary']>;
  } {
    return {
      circuit: this.circuitBreaker.status(),
      budget: this.budget.status(),
      tokens: this.tokenMonitor.summary(),
    };
  }

  /**
   * Send a user message and get the agent's response.
   * Executes the full cache-first tool-calling loop with infrastructure.
   */
  async send(userMessage: string, onStream?: StreamCallback): Promise<ChatResponse> {
    // 1. PROMPT INJECTION SCAN — check user input
    const injectionResult = scanForInjection(userMessage, 'context');
    if (injectionResult.detected) {
      console.warn(`[security] Prompt injection detected: ${injectionResult.patterns.join(', ')}`);
      if (onStream) {
        onStream(`⚠️ Input flagged for potential injection: ${injectionResult.patterns.join(', ')}\n`);
      }
      // Return a safe response instead of processing
      return {
        content: `I detected potentially unsafe content in your message (${injectionResult.patterns.join(', ')}). Please rephrase your request.`,
        injectionDetected: true,
      };
    }

    // 2. SANITIZE user message
    const sanitizedMessage = sanitizeMessage(userMessage);

    // Dynamic context prefix — rides in user message, NOT system prompt
    const dynamicPrefix = this.buildDynamicPrefix();
    const fullUserMessage = dynamicPrefix
      ? `${dynamicPrefix}\n\n${sanitizedMessage}`
      : sanitizedMessage;

    // Add user message to append-only log
    this.messages.push({
      role: 'user',
      content: fullUserMessage,
      timestamp: Date.now(),
    });

    const verbs = this.skin.spinner.thinking_verbs;
    const thinkingVerb = verbs[Math.floor(Math.random() * verbs.length)] ?? 'thinking';
    const allToolCalls: ChatResponse['toolCalls'] = [];
    let lastCacheHit: CacheHitInfo | undefined;

    // 3. TOOL-CALLING LOOP with iteration budget
    while (this.budget.consume()) {
      // Check if we need compression before sending
      await this.maybeCompress();

      // 4. CIRCUIT BREAKER — check before API call
      if (!this.circuitBreaker.allow()) {
        const status = this.circuitBreaker.status();
        throw new Error(`Circuit breaker OPEN for ${status.adapterId} (${status.failures} failures). Cooling down.`);
      }

      const wireMessages = this.buildWireMessages();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.apiKey) {
        headers['api-key'] = this.apiKey;
      }

      const body: Record<string, unknown> = {
        model: this.model,
        messages: wireMessages,
        max_completion_tokens: MAX_TOKENS,
        temperature: 0.7,
        tools: this.toolSchemas,
        tool_choice: 'auto',
      };

      try {
        // 5. RETRY with circuit breaker integration
        const response = await withRetry(
          async () => {
            const res = await fetch(`${this.baseUrl}/chat/completions`, {
              method: 'POST',
              headers,
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(120_000),
            });

            if (!res.ok) {
              const errorText = await res.text().catch(() => 'unknown error');
              const classified = classifyError(new Error(`HTTP ${res.status}`), res.status, errorText);
              const err = new Error(`MiMo API ${res.status}: ${errorText.slice(0, 300)}`);
              // Attach classification for the retry logic
              (err as any).classified = classified;
              throw err;
            }

            return res;
          },
          { maxAttempts: 3, baseMs: 2000, maxMs: 15_000, jitterRatio: 0.5 },
        );

        // Circuit breaker success
        this.circuitBreaker.success();

        const data = await response.json() as {
          choices?: Array<{
            message?: {
              content?: string;
              tool_calls?: Array<{
                id: string;
                type: 'function';
                function: { name: string; arguments: string };
              }>;
            };
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: {
              cached_tokens?: number;
            };
          };
        };

        // 6. TOKEN MONITORING — record usage
        const cachedTokens = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
        const promptTokens = data.usage?.prompt_tokens ?? 0;
        const completionTokens = data.usage?.completion_tokens ?? 0;
        this.tokenMonitor.recordUsage({
          input: promptTokens,
          output: completionTokens,
          cached: cachedTokens,
        });

        // Cache tracking
        if (cachedTokens > 0) {
          const pct = promptTokens > 0 ? (cachedTokens / promptTokens * 100).toFixed(1) : '?';
          console.log(`[cache] Hit: ${cachedTokens} tokens (${pct}% of prompt)`);
          this.totalCacheHits += cachedTokens;
        }
        this.totalPromptTokens += promptTokens;
        lastCacheHit = {
          cachedTokens,
          totalPromptTokens: promptTokens,
          hitPercent: promptTokens > 0 ? (cachedTokens / promptTokens * 100).toFixed(1) : '0',
        };

        const choice = data.choices?.[0];
        if (!choice?.message) {
          throw new Error('No response from MiMo');
        }

        const assistantMessage = choice.message;

        // If there are tool calls, execute them
        if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
          // Append assistant message to log
          this.messages.push({
            role: 'assistant',
            content: assistantMessage.content ?? '',
            timestamp: Date.now(),
          });

          // Execute each tool call
          for (const toolCall of assistantMessage.tool_calls) {
            const toolName = toolCall.function.name;
            let toolArgs: Record<string, unknown> = {};
            try {
              toolArgs = JSON.parse(toolCall.function.arguments);
            } catch {
              // If JSON parse fails, try repair
              try {
                const { repairJson } = await import('../../../src/core/agent-tools/input-sanitization.js');
                const repaired = repairJson(toolCall.function.arguments);
                if (repaired.fixed) {
                  toolArgs = JSON.parse(repaired.repaired);
                }
              } catch {
                // Give up, use empty args
              }
            }

            // Execute the tool
            const toolDef = this.toolRegistry.get(toolName);
            let result: ToolResult;
            if (toolDef) {
              try {
                result = await toolDef.handler(toolArgs, {
                  workspaceRoot: this.workspaceRoot,
                  labStoreRoot: requiredDataRoot(...DATA_ROOT_VARIABLES.store),
                  store: {} as any,
                });
              } catch (err) {
                result = {
                  ok: false,
                  output: '',
                  error: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
                };
              }
            } else {
              result = {
                ok: false,
                output: '',
                error: `Unknown tool: ${toolName}`,
              };
            }

            // 7. SANITIZE tool output before feeding back to model
            const sanitizedOutput = result.ok
              ? sanitizeToolOutput(result.output)
              : `Error: ${sanitizeToolOutput(result.error ?? result.output)}`;

            // Append tool result to log
            this.messages.push({
              role: 'tool',
              content: sanitizedOutput,
              timestamp: Date.now(),
              tool_call_id: toolCall.id,
              name: toolName,
            });

            allToolCalls?.push({
              name: toolName,
              args: toolArgs,
              result,
            });

            // Stream tool execution status
            if (onStream) {
              onStream(`\n🔧 ${toolName}: ${result.ok ? '✅' : '❌'} ${result.output?.slice(0, 100) ?? result.error?.slice(0, 100) ?? ''}\n`);
            }
          }

          // Continue the loop
          continue;
        }

        // No tool calls — this is the final response
        const content = assistantMessage.content ?? '';
        this.messages.push({
          role: 'assistant',
          content,
          timestamp: Date.now(),
        });

        if (onStream) {
          onStream(content);
        }

        return {
          content,
          thinkingVerb,
          toolCalls: allToolCalls,
          cacheHit: lastCacheHit,
          tokenUsage: this.tokenMonitor.summary(),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const classified = classifyError(err);

        // Circuit breaker failure
        this.circuitBreaker.failure();

        // If not retryable, throw immediately
        if (!classified.retryable) {
          throw new Error(`Chat failed [${classified.category}]: ${message}`);
        }

        // If context overflow, try compression
        if (classified.shouldCompress) {
          console.log('[compressor] Context overflow detected, forcing compression...');
          this.messages = this.messages.slice(0, 2).concat(this.messages.slice(-3));
          continue;
        }

        throw new Error(`Chat failed [${classified.category}]: ${message}`);
      }
    }

    // Budget exhausted
    const lastAssistant = [...this.messages].reverse().find((m) => m.role === 'assistant');
    return {
      content: lastAssistant?.content ?? '(iteration budget exhausted)',
      thinkingVerb,
      toolCalls: allToolCalls,
      cacheHit: lastCacheHit,
      tokenUsage: this.tokenMonitor.summary(),
    };
  }

  /**
   * Get a quick response without streaming.
   */
  async ask(question: string): Promise<string> {
    const response = await this.send(question);
    return response.content;
  }

  /**
   * Reset conversation — preserves frozen system prompt.
   */
  reset(): void {
    const frozenSystemPrompt = this.buildFrozenSystemPrompt();
    this.messages = [{
      role: 'system',
      content: frozenSystemPrompt,
      timestamp: Date.now(),
    }];
    this.compressor.reset();
    this.budget = new IterationBudget(MAX_TOOL_ITERATIONS);
    this.tokenMonitor.reset();
  }

  /**
   * Build frozen system prompt — NEVER changes mid-session.
   * Includes lab context: architecture, conventions, agent roster.
   */
  private buildFrozenSystemPrompt(): string {
    const personalityPrompt = buildPersonalityPrompt(this.personality);
    const toolList = this.getToolNames().join(', ');
    const memoryDir = join(this.workspaceRoot, 'memories');
    const memorySnapshot = buildMemorySnapshot(memoryDir);

    return [
      personalityPrompt,
      '',
      `Available tools: ${toolList}`,
      '',
      'Rules:',
      '- For simple questions, answer directly WITHOUT using tools',
      '- For file operations, use the appropriate tool (read_file, write_file, search_files, patch)',
      '- For web research, use web_search then web_extract',
      '- For browser interaction, use browser_* tools',
      '- When done, provide a clear summary of what you did',
      '- Keep changes minimal and focused',
      '- Use the memory tool to persist important facts across sessions',
      '- Use lab_context_read to check shared project state before acting',
      '- Use lab_context_write to record important findings or decisions',
      '',
      'Lab Context:',
      '- Architecture: 3-layer (Agents → Bridges → Ittunaha). No single point of failure.',
      '- Bridges are executors (stateless). Ittunaha is coordinator (stateful). Agents are autonomous.',
      '- Each agent owns its own core. No shared runtime between products.',
      '- Conventions: verify-dont-assume (confirm on real stack), rebuild-discipline (rebuild after commit)',
      '- lab-memory: shared project state store (git-versioned, supersession chains)',
      '- lab-store: skills and conventions (reusable procedures)',
      `- Services: ikbi:18796, luak:18795, nusika:18793, howa:18799, toba:18815, ittunaha:18821`,
      `- Agents: Pehlichi:18830 (coordinator), Ptah:18810 (builder), Luna:18792 (creative)`,
      memorySnapshot ? `\n${memorySnapshot}` : '',
    ].filter(Boolean).join('\n');
  }

  /**
   * Build dynamic context prefix — changes per-turn but rides in user message.
   */
  private buildDynamicPrefix(): string {
    const lines: string[] = [];
    lines.push(`[Task context] Working directory: ${this.workspaceRoot}`);
    lines.push(`Agent: ${this.personality.name}`);
    return lines.join('\n');
  }

  /**
   * Maybe compress context if approaching limits.
   */
  private async maybeCompress(): Promise<void> {
    const shouldCompress = this.compressor.shouldCompress(this.messages, CONTEXT_WINDOW);
    if (!shouldCompress) return;

    console.log(`[compressor] Context approaching limit, compressing...`);

    const result: CompressResult = await this.compressor.compress(this.messages, {
      contextWindow: CONTEXT_WINDOW,
    });

    if (result.compressed) {
      this.messages = result.messages as ChatMessage[];
      console.log(`[compressor] Compressed: ${result.originalCount} → ${result.compressedCount} messages (${result.strategyUsed})`);
    }
  }

  /**
   * Build wire messages for the API.
   * Messages are append-only — never reordered, never mutated.
   */
  private buildWireMessages(): Array<{ role: string; content: string; tool_call_id?: string; name?: string }> {
    return this.messages.map((m) => {
      const wire: any = { role: m.role, content: m.content };
      if (m.tool_call_id) wire.tool_call_id = m.tool_call_id;
      if (m.name) wire.name = m.name;
      return wire;
    });
  }
}

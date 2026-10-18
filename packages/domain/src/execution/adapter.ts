import type { z } from "zod";
import type { Environment, RiskClass } from "../schemas/enums.js";

/**
 * Context provided to an adapter during tool execution.
 */
export interface ExecutionContext {
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly startedAt: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Context provided to an adapter during reconciliation after an ambiguous outcome.
 */
export interface ReconciliationContext {
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly startedAt: string;
  readonly providerReference?: string | null;
  readonly signal?: AbortSignal;
}

/**
 * Result of querying an external provider to determine whether an ambiguous
 * side-effecting action actually took effect.
 */
export interface ReconciliationResult {
  /**
   * - `succeeded`: The provider confirms the action completed.
   * - `failed`: The provider confirms the action definitely failed or was rejected.
   * - `inconclusive`: The provider cannot determine the outcome (or timed out again).
   */
  readonly status: "succeeded" | "failed" | "inconclusive";
  readonly providerReference?: string | null;
  readonly output?: unknown;
  readonly evidenceSummary?: string;
  readonly error?: string;
}

/**
 * Action adapter contract (specification 6.3).
 * Adapters wrap tool execution behind typed input/output validation,
 * environment labelling, and optional reconciliation support.
 */
export interface ActionAdapter<TInput = unknown, TResult = unknown> {
  readonly toolName: string;
  readonly environment: Environment;
  readonly riskClass: RiskClass;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TResult>;
  execute(input: TInput, context: ExecutionContext): Promise<TResult>;
  reconcile?(context: ReconciliationContext): Promise<ReconciliationResult>;
}

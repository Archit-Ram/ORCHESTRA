/**
 * Intent Model Interface
 *
 * Provides an abstract interface for LLM-driven intent interpretation.
 * Production implementations (such as the Amazon Bedrock adapter) call
 * cloud model APIs, while unit tests use deterministic fake implementations.
 */

export interface IntentModelRequest {
  /** The natural language text provided by the user. */
  readonly text: string;
  /** Contextual information for time, user, and timezone resolution. */
  readonly context?: {
    readonly userId?: string;
    readonly currentTimestamp?: string;
    readonly userTimezone?: string;
  };
  /** Tracing correlation identifier. */
  readonly correlationId?: string;
  /** Optional caller request ID. */
  readonly requestId?: string;
}

export interface IntentModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface IntentModelResponse {
  /** Raw text output produced by the model (expected to contain structured JSON). */
  readonly rawText: string;
  /** Pinned model ID used for invocation. */
  readonly modelId: string;
  /** Request identifier returned by provider or generated for tracing. */
  readonly requestId: string;
  /** Total elapsed duration of the model invocation in milliseconds. */
  readonly latencyMs: number;
  /** Token usage statistics when provided by the service. */
  readonly usage?: IntentModelUsage;
}

export interface IntentModel {
  /**
   * Invokes the underlying model with the user's text and structured guidance.
   * Throws a typed DomainError on failure. Never silently returns fabricated data.
   */
  generateIntent(request: IntentModelRequest): Promise<IntentModelResponse>;
}

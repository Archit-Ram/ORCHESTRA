import process from "node:process";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { DomainError } from "../errors/domain-error.js";
import type { ErrorCode } from "../errors/error-codes.js";
import type {
  IntentModel,
  IntentModelRequest,
  IntentModelResponse,
  IntentModelUsage,
} from "./intent-model.js";
import { INTENT_JSON_SCHEMA_PROMPT } from "./intent-schema.js";

interface ErrorLike {
  name?: string;
  $metadata?: { httpStatusCode?: number; requestId?: string };
  $retryable?: { throttling?: boolean };
}

export interface BedrockConfig {
  readonly region: string;
  readonly modelId: string;
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
}

export interface StructuredLogEntry {
  readonly timestamp: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly serviceName: string;
  readonly environment: "simulator" | "live";
  readonly eventName: string;
  readonly requestId: string;
  readonly correlationId: string;
  readonly modelId: string;
  readonly latencyMs?: number;
  readonly usage?: IntentModelUsage;
  readonly result?: "success" | "failure";
  readonly errorCode?: ErrorCode;
  readonly errorType?: string;
  readonly message?: string;
}

export interface BedrockAdapterOptions {
  readonly region?: string;
  readonly modelId?: string;
  readonly requestTimeoutMs?: number;
  readonly maxRetries?: number;
  /** Injected BedrockRuntimeClient (for testing and credential overrides). */
  readonly client?: BedrockRuntimeClient;
  /** Optional custom system prompt instructions. */
  readonly systemPrompt?: string;
  /** Injectable sleep function for deterministic fast tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable random source for deterministic backoff jitter. */
  readonly randomSource?: () => number;
  /** Log sink callback; defaults to structured console output. */
  readonly logSink?: (entry: StructuredLogEntry) => void;
}

const DEFAULT_SYSTEM_PROMPT = `You are ORCHESTRA's Intent Normalization Engine.
Your task is to convert natural language requests into a structured IntentProposal conforming strictly to the provided JSON schema.
Requirements:
1. Identify all commitments the user is asking the agent to make or fulfill.
2. Identify all planned actions needed to fulfill those commitments, their tool names (in lowerCamelCase), and input parameters.
3. Establish proper dependencies between actions and commitments.
4. If the action involves external communication, purchases, deletions, or account modifications, flag requiresApproval as true.
5. Identify any safety, authorization, recipient, or deadline ambiguities. If any ambiguity impacts safety, recipient, authorization, or deadline feasibility, set blocking to true and impact accordingly.
6. Generate unique IDs for all commitments, actions, invariants, and ambiguities.
7. Return ONLY a valid JSON object matching the schema below. No commentary, no preamble.

Schema:
${INTENT_JSON_SCHEMA_PROMPT}`;

/** Classifies an error into transient vs permanent, returning the mapped stable error code. */
export function classifyBedrockError(err: unknown): {
  isTransient: boolean;
  code: ErrorCode;
  errorType: string;
} {
  if (err instanceof DomainError) {
    return {
      isTransient: err.retryability === "retryable",
      code: err.code,
      errorType: err.name,
    };
  }

  const errorObj = err as ErrorLike | null;
  const name = typeof errorObj?.name === "string" ? errorObj.name : "UnknownError";
  const metadata = errorObj?.$metadata;
  const httpStatusCode = typeof metadata?.httpStatusCode === "number" ? metadata.httpStatusCode : 0;
  const retryable = errorObj?.$retryable;

  // 1. Throttling / Rate limits
  if (
    name === "ThrottlingException" ||
    name === "TooManyRequestsException" ||
    name === "RequestLimitExceeded" ||
    httpStatusCode === 429 ||
    Boolean(retryable?.throttling)
  ) {
    return { isTransient: true, code: "PROVIDER_RATE_LIMITED", errorType: name };
  }

  // 2. Timeouts
  if (
    name === "ModelTimeoutException" ||
    name === "TimeoutError" ||
    name === "AbortError" ||
    name === "RequestTimeout" ||
    httpStatusCode === 408 ||
    httpStatusCode === 504
  ) {
    return { isTransient: true, code: "PROVIDER_TIMEOUT", errorType: name };
  }

  // 3. Transient service errors
  if (
    name === "InternalServerException" ||
    name === "ServiceUnavailableException" ||
    name === "ServiceUnavailable" ||
    httpStatusCode === 500 ||
    httpStatusCode === 502 ||
    httpStatusCode === 503 ||
    Boolean(retryable)
  ) {
    return { isTransient: true, code: "BEDROCK_UNAVAILABLE", errorType: name };
  }

  // 4. Permanent errors
  if (name === "ValidationException" || httpStatusCode === 400) {
    return { isTransient: false, code: "INVALID_INPUT", errorType: name };
  }
  if (name === "AccessDeniedException" || httpStatusCode === 403) {
    return { isTransient: false, code: "POLICY_DENIED", errorType: name };
  }

  return { isTransient: false, code: "BEDROCK_UNAVAILABLE", errorType: name };
}

/**
 * Real Amazon Bedrock client adapter implementing IntentModel (Section 5.1 & Section 6.4).
 * Uses Converse API, bounded retries with jitter, safe logging, and standard AWS credential chain.
 */
export class BedrockIntentAdapter implements IntentModel {
  readonly config: BedrockConfig;
  private readonly client: BedrockRuntimeClient;
  private readonly systemPrompt: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly randomSource: () => number;
  private readonly logSink?: (entry: StructuredLogEntry) => void;

  constructor(options: BedrockAdapterOptions = {}) {
    const region = options.region ?? process.env["AWS_REGION"] ?? "us-east-1";
    const modelId =
      options.modelId ??
      process.env["BEDROCK_MODEL_ID"] ??
      "anthropic.claude-3-haiku-20240307-v1:0";
    const timeoutEnv = process.env["BEDROCK_REQUEST_TIMEOUT_MS"];
    const requestTimeoutMs =
      options.requestTimeoutMs ?? (timeoutEnv ? Number.parseInt(timeoutEnv, 10) : 30_000);
    const retriesEnv = process.env["BEDROCK_MAX_RETRIES"];
    const maxRetries = options.maxRetries ?? (retriesEnv ? Number.parseInt(retriesEnv, 10) : 3);

    this.config = {
      region,
      modelId,
      requestTimeoutMs: Number.isFinite(requestTimeoutMs) ? requestTimeoutMs : 30_000,
      maxRetries: Number.isFinite(maxRetries) ? maxRetries : 3,
    };

    // AWS SDK credential chain: never hardcode credentials.
    this.client = options.client ?? new BedrockRuntimeClient({ region: this.config.region });
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.sleep =
      options.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.randomSource = options.randomSource ?? Math.random;
    this.logSink = options.logSink;
  }

  private emitLog(entry: StructuredLogEntry): void {
    if (this.logSink) {
      this.logSink(entry);
    }
  }

  /**
   * Invokes Amazon Bedrock Converse API with bounded retries for transient errors.
   * Throws a mapped DomainError on final failure.
   */
  async generateIntent(request: IntentModelRequest): Promise<IntentModelResponse> {
    const requestId =
      request.requestId ?? `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const correlationId = request.correlationId ?? requestId;
    const startTime = Date.now();

    // Log intentParsingStarted (never logs prompt body)
    this.emitLog({
      timestamp: new Date().toISOString(),
      level: "info",
      serviceName: "orchestra-intent",
      environment: process.env["ORCHESTRA_ENVIRONMENT"] === "live" ? "live" : "simulator",
      eventName: "intentParsingStarted",
      requestId,
      correlationId,
      modelId: this.config.modelId,
    });

    let attempt = 0;
    let lastError: unknown = null;

    while (attempt <= this.config.maxRetries) {
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        abortController.abort(new Error("Request timeout"));
      }, this.config.requestTimeoutMs);

      try {
        const input: ConverseCommandInput = {
          modelId: this.config.modelId,
          system: [{ text: this.systemPrompt }],
          messages: [
            {
              role: "user",
              content: [{ text: request.text }],
            },
          ],
          inferenceConfig: {
            maxTokens: 4096,
            temperature: 0.0,
          },
        };

        const command = new ConverseCommand(input);
        const output: ConverseCommandOutput = await this.client.send(command, {
          abortSignal: abortController.signal,
        });

        clearTimeout(timeoutId);

        const latencyMs = Date.now() - startTime;
        const textContent = output.output?.message?.content?.[0]?.text ?? "";
        const usage: IntentModelUsage = {
          inputTokens: output.usage?.inputTokens,
          outputTokens: output.usage?.outputTokens,
          totalTokens: output.usage?.totalTokens,
        };

        const resolvedRequestId = output.$metadata?.requestId ?? requestId;

        // Log intentParsingCompleted
        this.emitLog({
          timestamp: new Date().toISOString(),
          level: "info",
          serviceName: "orchestra-intent",
          environment: process.env["ORCHESTRA_ENVIRONMENT"] === "live" ? "live" : "simulator",
          eventName: "intentParsingCompleted",
          requestId: resolvedRequestId,
          correlationId,
          modelId: this.config.modelId,
          latencyMs,
          usage,
          result: "success",
        });

        return {
          rawText: textContent,
          modelId: this.config.modelId,
          requestId: resolvedRequestId,
          latencyMs,
          usage,
        };
      } catch (err) {
        clearTimeout(timeoutId);
        lastError = err;
        attempt += 1;

        const classification = classifyBedrockError(err);
        const latencyMs = Date.now() - startTime;

        this.emitLog({
          timestamp: new Date().toISOString(),
          level: "warn",
          serviceName: "orchestra-intent",
          environment: process.env["ORCHESTRA_ENVIRONMENT"] === "live" ? "live" : "simulator",
          eventName: "bedrockRequestFailed",
          requestId,
          correlationId,
          modelId: this.config.modelId,
          latencyMs,
          result: "failure",
          errorCode: classification.code,
          errorType: classification.errorType,
          message: "Bedrock request failed.",
        });

        // Non-transient errors must NOT be retried
        if (!classification.isTransient) {
          throw new DomainError({
            code: classification.code,
            userMessage: `Bedrock request failed: ${classification.errorType}`,
            metadata: {
              modelId: this.config.modelId,
              requestId,
              errorType: classification.errorType,
            },
            cause: err,
          });
        }

        // If retries exhausted, throw mapped typed error
        if (attempt > this.config.maxRetries) {
          throw new DomainError({
            code: classification.code,
            userMessage: `Bedrock request exhausted retries (${this.config.maxRetries}): ${classification.errorType}`,
            metadata: {
              modelId: this.config.modelId,
              requestId,
              attempts: attempt,
              errorType: classification.errorType,
            },
            cause: err,
          });
        }

        // Exponential backoff with jitter: delay = min(maxDelay, base * 2^attempt) + jitter
        const baseDelayMs = 100;
        const maxDelayMs = 5000;
        const exponentialMs = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
        const jitterMs = Math.floor(this.randomSource() * 100);
        await this.sleep(exponentialMs + jitterMs);
      }
    }

    // Defensive fallback (should never be reached)
    const fallbackClassification = classifyBedrockError(lastError);
    throw new DomainError({
      code: fallbackClassification.code,
      userMessage: "Bedrock request failed.",
      metadata: { modelId: this.config.modelId, requestId },
      cause: lastError,
    });
  }
}

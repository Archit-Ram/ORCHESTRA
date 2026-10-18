import { DomainError } from "../errors/domain-error.js";
import type {
  IntentModel,
  IntentModelRequest,
  IntentModelResponse,
  IntentModelUsage,
} from "./intent-model.js";

export type FakeIntentBehavior =
  | { readonly kind: "success"; readonly rawText: string; readonly usage?: IntentModelUsage }
  | { readonly kind: "malformedJson" }
  | { readonly kind: "timeout" }
  | { readonly kind: "rateLimited" }
  | { readonly kind: "serviceUnavailable" }
  | { readonly kind: "throw"; readonly error: Error };

export interface FakeIntentModelOptions {
  readonly modelId?: string;
  readonly defaultLatencyMs?: number;
}

/**
 * Deterministic test double implementing IntentModel.
 * Strictly labeled for unit testing, simulation, and benchmark fixtures.
 */
export class FakeIntentModel implements IntentModel {
  readonly environment = "simulator" as const;
  readonly modelId: string;
  private readonly defaultLatencyMs: number;
  private readonly callHistory: IntentModelRequest[] = [];
  private behaviors: FakeIntentBehavior[] = [];
  private defaultBehavior: FakeIntentBehavior = {
    kind: "malformedJson",
  };

  constructor(options: FakeIntentModelOptions = {}) {
    this.modelId = options.modelId ?? "fake-intent-model-v1";
    this.defaultLatencyMs = options.defaultLatencyMs ?? 15;
  }

  /** Sets a persistent default behavior. */
  setDefaultBehavior(behavior: FakeIntentBehavior): this {
    this.defaultBehavior = behavior;
    return this;
  }

  /** Sets canned success JSON response. */
  setSuccessResponse(rawJsonOrText: string | Record<string, unknown>): this {
    const rawText =
      typeof rawJsonOrText === "string" ? rawJsonOrText : JSON.stringify(rawJsonOrText, null, 2);
    this.defaultBehavior = { kind: "success", rawText };
    return this;
  }

  /** Queues a one-time behavior consumed on the next call. */
  enqueueBehavior(behavior: FakeIntentBehavior): this {
    this.behaviors.push(behavior);
    return this;
  }

  get history(): readonly IntentModelRequest[] {
    return [...this.callHistory];
  }

  get callCount(): number {
    return this.callHistory.length;
  }

  reset(): void {
    this.callHistory.length = 0;
    this.behaviors.length = 0;
  }

  async generateIntent(request: IntentModelRequest): Promise<IntentModelResponse> {
    this.callHistory.push(request);
    const behavior = this.behaviors.shift() ?? this.defaultBehavior;

    switch (behavior.kind) {
      case "success":
        return {
          rawText: behavior.rawText,
          modelId: this.modelId,
          requestId: request.requestId ?? `fake_req_${this.callHistory.length}`,
          latencyMs: this.defaultLatencyMs,
          usage: behavior.usage ?? { inputTokens: 50, outputTokens: 120, totalTokens: 170 },
        };

      case "malformedJson":
        return {
          rawText: "This is definitely not valid JSON {{{ [[[",
          modelId: this.modelId,
          requestId: request.requestId ?? `fake_req_${this.callHistory.length}`,
          latencyMs: this.defaultLatencyMs,
          usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
        };

      case "timeout":
        throw new DomainError({
          code: "PROVIDER_TIMEOUT",
          userMessage: "Fake intent model timed out.",
          metadata: { modelId: this.modelId },
        });

      case "rateLimited":
        throw new DomainError({
          code: "PROVIDER_RATE_LIMITED",
          userMessage: "Fake intent model rate limit exceeded.",
          metadata: { modelId: this.modelId },
        });

      case "serviceUnavailable":
        throw new DomainError({
          code: "BEDROCK_UNAVAILABLE",
          userMessage: "Fake intent model service is unavailable.",
          metadata: { modelId: this.modelId },
        });

      case "throw":
        throw behavior.error;
    }
  }
}

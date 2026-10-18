import process from "node:process";
import { DomainError } from "../errors/domain-error.js";
import type { ToolCatalog } from "../policy/tool-catalog.js";
import type { StructuredLogEntry } from "./bedrock-adapter.js";
import type { IntentModel, IntentModelRequest } from "./intent-model.js";
import { normalizeIntentProposal, type IntentNormalizerOptions } from "./intent-normalizer.js";
import type { IntentProposal } from "./intent-schema.js";

export interface IntentServiceOptions extends IntentNormalizerOptions {
  readonly logSink?: (entry: StructuredLogEntry) => void;
}

/**
 * High-level service combining intent model invocation and deterministic
 * Algorithm A intent normalization.
 */
export class IntentService {
  constructor(
    private readonly model: IntentModel,
    private readonly catalog?: ToolCatalog,
    private readonly options: IntentServiceOptions = {},
  ) {}

  /**
   * Interprets natural language user intent into a validated, proposal-ready IntentProposal.
   * Throws a DomainError on failure; never returns fabricated data.
   */
  async interpretIntent(request: IntentModelRequest): Promise<IntentProposal> {
    const requestId = request.requestId ?? `req_${Date.now()}`;
    const correlationId = request.correlationId ?? requestId;

    // 1. Generate structured output from underlying model
    const response = await this.model.generateIntent(request);

    // 2. Normalize and validate with Algorithm A (treat model output as untrusted)
    try {
      const proposal = normalizeIntentProposal(response.rawText, {
        toolCatalog: this.catalog,
        now: request.context?.currentTimestamp,
        rejectOnBlockingAmbiguity: this.options.rejectOnBlockingAmbiguity,
        proposalId: this.options.proposalId,
      });

      return proposal;
    } catch (err) {
      // Emit structured log for intentValidationFailed
      if (this.options.logSink) {
        const errorType = err instanceof DomainError ? err.code : "ValidationError";
        this.options.logSink({
          timestamp: new Date().toISOString(),
          level: "warn",
          serviceName: "orchestra-intent",
          environment: process.env["ORCHESTRA_ENVIRONMENT"] === "live" ? "live" : "simulator",
          eventName: "intentValidationFailed",
          requestId,
          correlationId,
          modelId: response.modelId,
          result: "failure",
          errorCode: err instanceof DomainError ? err.code : "SCHEMA_VALIDATION_FAILED",
          errorType,
          message: err instanceof Error ? err.message : "Intent normalization failed",
        });
      }

      throw err;
    }
  }
}

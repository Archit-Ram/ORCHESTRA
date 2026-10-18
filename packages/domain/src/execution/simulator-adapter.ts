import type { z } from "zod";
import { DomainError } from "../errors/domain-error.js";
import type { RiskClass } from "../schemas/enums.js";
import type {
  ActionAdapter,
  ExecutionContext,
  ReconciliationContext,
  ReconciliationResult,
} from "./adapter.js";

export type FaultInjectionMode =
  | { readonly type: "success" }
  | { readonly type: "reject"; readonly error: DomainError | string }
  | { readonly type: "timeout"; readonly delayMs?: number }
  | { readonly type: "throw"; readonly error: Error };

export interface SimulatorReconciliationConfig {
  readonly status: "succeeded" | "failed" | "inconclusive";
  readonly providerReference?: string | null;
  readonly error?: string;
  readonly delayMs?: number;
}

export interface SimulatorAdapterOptions<TInput, TResult> {
  readonly toolName: string;
  readonly riskClass: RiskClass;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TResult>;
  readonly defaultOutput: (input: TInput, context: ExecutionContext) => TResult;
  readonly defaultProviderReference?: (input: TInput, context: ExecutionContext) => string;
  readonly faultMode?: FaultInjectionMode;
  readonly reconciliationConfig?: SimulatorReconciliationConfig;
  readonly latencyMs?: number;
}

export interface ExecutionCallRecord<TInput> {
  readonly input: TInput;
  readonly context: ExecutionContext;
  readonly timestamp: string;
}

export interface ReconcileCallRecord {
  readonly context: ReconciliationContext;
  readonly timestamp: string;
}

/**
 * Deterministic simulator adapter (specification Sections 0.1, 5.7, 6.3).
 * Visibly labelled with `environment: "simulator"` at all times.
 * Supports programmable fault injection (timeout, rejection, latency,
 * reconciliation) for repeatable end-to-end and resilience testing.
 */
export class SimulatorAdapter<TInput = unknown, TResult = unknown> implements ActionAdapter<
  TInput,
  TResult
> {
  readonly toolName: string;
  readonly environment = "simulator" as const;
  readonly riskClass: RiskClass;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TResult>;

  private readonly defaultOutput: (input: TInput, context: ExecutionContext) => TResult;
  private readonly defaultProviderReference?: (input: TInput, context: ExecutionContext) => string;
  private faultMode: FaultInjectionMode;
  private reconciliationConfig?: SimulatorReconciliationConfig;
  private latencyMs: number;

  readonly executionHistory: ExecutionCallRecord<TInput>[] = [];
  readonly reconciliationHistory: ReconcileCallRecord[] = [];

  constructor(options: SimulatorAdapterOptions<TInput, TResult>) {
    this.toolName = options.toolName;
    this.riskClass = options.riskClass;
    this.inputSchema = options.inputSchema;
    this.outputSchema = options.outputSchema;
    this.defaultOutput = options.defaultOutput;
    this.defaultProviderReference = options.defaultProviderReference;
    this.faultMode = options.faultMode ?? { type: "success" };
    this.reconciliationConfig = options.reconciliationConfig;
    this.latencyMs = options.latencyMs ?? 0;
  }

  setFaultMode(mode: FaultInjectionMode): void {
    this.faultMode = mode;
  }

  setReconciliationConfig(config: SimulatorReconciliationConfig | undefined): void {
    this.reconciliationConfig = config;
  }

  setLatencyMs(latencyMs: number): void {
    this.latencyMs = latencyMs;
  }

  async execute(input: TInput, context: ExecutionContext): Promise<TResult> {
    this.executionHistory.push({
      input,
      context,
      timestamp: new Date().toISOString(),
    });

    if (this.latencyMs > 0) {
      await this.sleep(this.latencyMs, context.signal);
    }

    switch (this.faultMode.type) {
      case "success": {
        return this.defaultOutput(input, context);
      }
      case "reject": {
        if (this.faultMode.error instanceof DomainError) {
          throw this.faultMode.error;
        }
        throw new DomainError({
          code: "PROVIDER_REJECTED",
          userMessage:
            typeof this.faultMode.error === "string" ? this.faultMode.error : "Simulated rejection",
          metadata: { toolName: this.toolName, actionId: context.actionId },
        });
      }
      case "timeout": {
        const delay = this.faultMode.delayMs ?? 10_000;
        await this.sleep(delay, context.signal);
        throw new DomainError({
          code: "PROVIDER_TIMEOUT",
          userMessage: "Simulated provider timed out during tool execution.",
          metadata: { toolName: this.toolName, actionId: context.actionId },
        });
      }
      case "throw": {
        throw this.faultMode.error;
      }
    }
  }

  async reconcile(context: ReconciliationContext): Promise<ReconciliationResult> {
    this.reconciliationHistory.push({
      context,
      timestamp: new Date().toISOString(),
    });

    if (!this.reconciliationConfig) {
      return {
        status: "inconclusive",
        error: "Reconciliation not supported or configured on simulator",
      };
    }

    if (this.reconciliationConfig.delayMs && this.reconciliationConfig.delayMs > 0) {
      await this.sleep(this.reconciliationConfig.delayMs, context.signal);
    }

    return {
      status: this.reconciliationConfig.status,
      providerReference: this.reconciliationConfig.providerReference,
      error: this.reconciliationConfig.error,
    };
  }

  getProviderReference(input: TInput, context: ExecutionContext): string {
    if (this.defaultProviderReference) {
      return this.defaultProviderReference(input, context);
    }
    return `sim_ref_${this.toolName}_${context.idempotencyKey.slice(0, 8)}`;
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve();
      }, ms);

      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(
              new DomainError({
                code: "PROVIDER_TIMEOUT",
                userMessage: "Operation aborted due to timeout.",
                metadata: { toolName: this.toolName },
              }),
            );
          },
          { once: true },
        );
      }
    });
  }
}

import { DomainError } from "../errors/domain-error.js";
import { lowerCamelNameSchema } from "../schemas/primitives.js";
import { parseOrThrow } from "../schemas/validation.js";
import type { ActionAdapter } from "./adapter.js";

/**
 * Registry of action adapters.
 * Validates tool names, prevents duplicate registrations, and strictly
 * enforces input/output schemas at runtime boundaries.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, ActionAdapter<unknown, unknown>>();

  /**
   * Registers an adapter.
   * Throws `INVALID_INPUT` if the tool name is not lowerCamelCase or is already registered.
   */
  register(adapter: ActionAdapter<unknown, unknown>): this {
    if (!lowerCamelNameSchema.safeParse(adapter.toolName).success) {
      throw new DomainError({
        code: "INVALID_INPUT",
        userMessage: "Tool name must be lowerCamelCase.",
        metadata: { toolName: adapter.toolName },
      });
    }

    if (this.adapters.has(adapter.toolName)) {
      throw new DomainError({
        code: "INVALID_INPUT",
        userMessage: "An adapter for this tool is already registered.",
        metadata: { toolName: adapter.toolName },
      });
    }

    this.adapters.set(adapter.toolName, adapter);
    return this;
  }

  get(toolName: string): ActionAdapter<unknown, unknown> | undefined {
    return this.adapters.get(toolName);
  }

  require(toolName: string): ActionAdapter<unknown, unknown> {
    const adapter = this.get(toolName);
    if (!adapter) {
      throw new DomainError({
        code: "INVALID_INPUT",
        userMessage: `No adapter registered for tool: ${toolName}`,
        metadata: { toolName },
      });
    }
    return adapter;
  }

  has(toolName: string): boolean {
    return this.adapters.has(toolName);
  }

  names(): readonly string[] {
    return [...this.adapters.keys()].sort();
  }

  /**
   * Validates raw action input against the adapter's declared input schema.
   */
  validateInput<T = unknown>(toolName: string, rawInput: unknown): T {
    const adapter = this.require(toolName);
    return parseOrThrow(adapter.inputSchema, rawInput, `adapter[${toolName}].input`) as T;
  }

  /**
   * Validates raw adapter output against the adapter's declared output schema.
   */
  validateOutput<T = unknown>(toolName: string, rawOutput: unknown): T {
    const adapter = this.require(toolName);
    return parseOrThrow(adapter.outputSchema, rawOutput, `adapter[${toolName}].output`) as T;
  }
}

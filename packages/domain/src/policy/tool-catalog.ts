import type { z } from "zod";
import { DomainError } from "../errors/domain-error.js";
import type { Environment, RiskClass } from "../schemas/enums.js";
import { lowerCamelNameSchema } from "../schemas/primitives.js";

export const TOOL_CATEGORIES = [
  "read",
  "write",
  "externalCommunication",
  "purchase",
  "deletion",
  "accountChange",
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/** Categories that always require explicit approval (specification 5.6). */
export const HIGH_IMPACT_CATEGORIES: readonly ToolCategory[] = [
  "externalCommunication",
  "purchase",
  "deletion",
  "accountChange",
];

const SCOPE_PATTERN = /^[a-z][a-z0-9]*(?:[:._-][a-z0-9]+)*$/;

/** What a tool declares about itself; the verifier trusts this, never the model. */
export interface ToolDefinition {
  readonly toolName: string;
  /** Which environment's adapter backs this tool. Mixing them is a violation. */
  readonly environment: Environment;
  readonly category: ToolCategory;
  readonly riskClass: RiskClass;
  readonly isReversible: boolean;
  /** Scopes a principal must hold to invoke the tool. */
  readonly requiredScopes: readonly string[];
  /** Runtime schema every action input must satisfy. */
  readonly inputSchema: z.ZodTypeAny;
}

export interface ToolCatalog {
  get(toolName: string): ToolDefinition | undefined;
  names(): readonly string[];
}

/** Who is asking. Scopes come from authentication, never from model output. */
export interface Principal {
  readonly userId: string;
  readonly scopes: readonly string[];
}

/**
 * Builds a catalog, rejecting duplicate tool names, non-lowerCamelCase names,
 * and malformed scope names.
 */
export function createToolCatalog(definitions: readonly ToolDefinition[]): ToolCatalog {
  const byName = new Map<string, ToolDefinition>();
  for (const definition of definitions) {
    const reason = !lowerCamelNameSchema.safeParse(definition.toolName).success
      ? "tool name must be lowerCamelCase"
      : byName.has(definition.toolName)
        ? "duplicate tool name"
        : definition.requiredScopes.some((scope) => !SCOPE_PATTERN.test(scope))
          ? "malformed scope name"
          : null;
    if (reason !== null) {
      throw new DomainError({
        code: "INVALID_INPUT",
        userMessage: "The tool catalog contains an invalid definition.",
        metadata: { toolName: definition.toolName, reason },
      });
    }
    byName.set(definition.toolName, definition);
  }
  const sortedNames = [...byName.keys()].sort();
  return {
    get: (toolName) => byName.get(toolName),
    names: () => sortedNames,
  };
}

/**
 * Whether policy demands approval for a tool, independent of what an action
 * claims. High-impact categories and high-risk tools always need it. Read-only
 * tools and low-risk reversible tools may run automatically; everything else
 * needs approval.
 */
export function toolRequiresApproval(tool: ToolDefinition): boolean {
  if (HIGH_IMPACT_CATEGORIES.includes(tool.category)) return true;
  if (tool.riskClass === "high") return true;
  if (tool.category === "read") return false;
  if (tool.riskClass === "low" && tool.isReversible) return false;
  return true;
}

/** Scopes the tool requires that the principal lacks, sorted. */
export function missingScopes(principal: Principal, tool: ToolDefinition): string[] {
  const held = new Set(principal.scopes);
  return tool.requiredScopes.filter((scope) => !held.has(scope)).sort();
}

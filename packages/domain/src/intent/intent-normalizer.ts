import { DomainError } from "../errors/domain-error.js";
import {
  buildCommitmentGraph,
  graphFailureToDomainError,
  type GraphNode,
} from "../graph/commitment-graph.js";
import type { ToolCatalog } from "../policy/tool-catalog.js";
import { plannedActionSchema, type PlannedAction } from "../schemas/action.js";
import { commitmentSchema, type Commitment } from "../schemas/commitment.js";
import { invariantSchema, type Invariant } from "../schemas/invariant.js";
import { normalizeToUtcIso } from "../schemas/primitives.js";
import { validateWithSchema } from "../schemas/validation.js";
import {
  SAFETY_CRITICAL_AMBIGUITY_IMPACTS,
  rawIntentResponseSchema,
  type Ambiguity,
  type IntentProposal,
} from "./intent-schema.js";

export interface IntentNormalizerOptions {
  /** Optional catalog of supported tools to validate action inputs against. */
  readonly toolCatalog?: ToolCatalog;
  /** Current time for ISO timestamp generation; defaults to new Date().toISOString(). */
  readonly now?: string;
  /** If true, throws AMBIGUOUS_REQUEST when blocking/safety ambiguities exist. */
  readonly rejectOnBlockingAmbiguity?: boolean;
  /** Fixed proposal ID override (for deterministic testing). */
  readonly proposalId?: string;
}

/** Extracts the first JSON object from a model response string. */
export function extractJsonFromModelOutput(rawText: string): unknown {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    throw new DomainError({
      code: "SCHEMA_VALIDATION_FAILED",
      userMessage: "Model response is empty.",
      metadata: { reason: "EMPTY_MODEL_OUTPUT" },
    });
  }

  // If already clean JSON object
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      throw new DomainError({
        code: "SCHEMA_VALIDATION_FAILED",
        userMessage: "Failed to parse model output as JSON.",
        metadata: { reason: "MALFORMED_JSON", error: String(err) },
      });
    }
  }

  // Look for markdown ```json ... ``` or first balanced { ... }
  const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/;
  const match = jsonBlockRegex.exec(trimmed);
  if (match?.[1]) {
    try {
      return JSON.parse(match[1]);
    } catch (err) {
      throw new DomainError({
        code: "SCHEMA_VALIDATION_FAILED",
        userMessage: "Failed to parse JSON inside markdown code fence.",
        metadata: { reason: "MALFORMED_JSON", error: String(err) },
      });
    }
  }

  // Fallback: search for outermost { ... }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch (err) {
      throw new DomainError({
        code: "SCHEMA_VALIDATION_FAILED",
        userMessage: "Failed to parse extracted JSON candidate from model output.",
        metadata: { reason: "MALFORMED_JSON", error: String(err) },
      });
    }
  }

  throw new DomainError({
    code: "SCHEMA_VALIDATION_FAILED",
    userMessage: "No JSON object found in model output.",
    metadata: { reason: "NO_JSON_FOUND" },
  });
}

/**
 * Normalizes and validates raw LLM output into an IntentProposal (Algorithm A: Section 5.1).
 * Never trusts model output. Validates schemas, references, cycles, tools, and ambiguities.
 */
export function normalizeIntentProposal(
  rawText: string,
  options: IntentNormalizerOptions = {},
): IntentProposal {
  const now = options.now ?? new Date().toISOString();
  const normalizedNow = normalizeToUtcIso(now) ?? now;

  // 1. Parse JSON
  const rawParsed = extractJsonFromModelOutput(rawText);

  // 2. Validate against raw intent response schema
  const parseResult = validateWithSchema(rawIntentResponseSchema, rawParsed);
  if (!parseResult.ok) {
    throw new DomainError({
      code: "SCHEMA_VALIDATION_FAILED",
      userMessage: "Model response does not conform to intent schema.",
      metadata: { issues: parseResult.issues },
    });
  }
  const rawIntent = parseResult.value;

  // 3. Reject duplicate IDs within collections
  const commitmentIdSet = new Set<string>();
  for (const c of rawIntent.commitments) {
    if (commitmentIdSet.has(c.commitmentId)) {
      throw new DomainError({
        code: "INVALID_INPUT",
        userMessage: `Duplicate commitment ID detected: ${c.commitmentId}`,
        metadata: { reason: "DUPLICATE_ID", id: c.commitmentId, collection: "commitments" },
      });
    }
    commitmentIdSet.add(c.commitmentId);
  }

  const actionIdSet = new Set<string>();
  for (const a of rawIntent.actions) {
    if (actionIdSet.has(a.actionId)) {
      throw new DomainError({
        code: "INVALID_INPUT",
        userMessage: `Duplicate action ID detected: ${a.actionId}`,
        metadata: { reason: "DUPLICATE_ID", id: a.actionId, collection: "actions" },
      });
    }
    actionIdSet.add(a.actionId);
  }

  const rawInvariants = rawIntent.invariants ?? [];
  const invariantIdSet = new Set<string>();
  for (const inv of rawInvariants) {
    if (invariantIdSet.has(inv.invariantId)) {
      throw new DomainError({
        code: "INVALID_INPUT",
        userMessage: `Duplicate invariant ID detected: ${inv.invariantId}`,
        metadata: { reason: "DUPLICATE_ID", id: inv.invariantId, collection: "invariants" },
      });
    }
    invariantIdSet.add(inv.invariantId);
  }

  // 4. Referential integrity checks
  for (const a of rawIntent.actions) {
    // Action -> Commitments
    for (const cId of a.commitmentIds) {
      if (!commitmentIdSet.has(cId)) {
        throw new DomainError({
          code: "DEPENDENCY_NOT_FOUND",
          userMessage: `Action '${a.actionId}' references unknown commitment '${cId}'.`,
          metadata: { actionId: a.actionId, referencedId: cId, type: "commitment" },
        });
      }
    }
    // Action -> Dependency Actions
    const depActionIds = a.dependencyActionIds ?? [];
    for (const depActionId of depActionIds) {
      if (!actionIdSet.has(depActionId)) {
        throw new DomainError({
          code: "DEPENDENCY_NOT_FOUND",
          userMessage: `Action '${a.actionId}' depends on unknown action '${depActionId}'.`,
          metadata: { actionId: a.actionId, referencedId: depActionId, type: "action" },
        });
      }
    }
  }

  for (const c of rawIntent.commitments) {
    // Commitment -> Dependency Commitments
    const depCommitmentIds = c.dependencyIds ?? [];
    for (const depCId of depCommitmentIds) {
      if (!commitmentIdSet.has(depCId)) {
        throw new DomainError({
          code: "DEPENDENCY_NOT_FOUND",
          userMessage: `Commitment '${c.commitmentId}' depends on unknown commitment '${depCId}'.`,
          metadata: { commitmentId: c.commitmentId, referencedId: depCId, type: "commitment" },
        });
      }
    }
    // Commitment -> Invariants
    const invIds = c.invariantIds ?? [];
    for (const invId of invIds) {
      if (!invariantIdSet.has(invId)) {
        throw new DomainError({
          code: "DEPENDENCY_NOT_FOUND",
          userMessage: `Commitment '${c.commitmentId}' references unknown invariant '${invId}'.`,
          metadata: { commitmentId: c.commitmentId, referencedId: invId, type: "invariant" },
        });
      }
    }
  }

  // 5. Cycle Detection using Algorithm B (Kahn's algorithm)
  const actionNodes: GraphNode[] = rawIntent.actions.map((a) => ({
    id: a.actionId,
    dependsOn: a.dependencyActionIds ?? [],
  }));
  const actionGraphResult = buildCommitmentGraph(actionNodes);
  if (!actionGraphResult.ok) {
    throw graphFailureToDomainError(actionGraphResult);
  }

  const commitmentNodes: GraphNode[] = rawIntent.commitments.map((c) => ({
    id: c.commitmentId,
    dependsOn: c.dependencyIds ?? [],
  }));
  const commitmentGraphResult = buildCommitmentGraph(commitmentNodes);
  if (!commitmentGraphResult.ok) {
    throw graphFailureToDomainError(commitmentGraphResult);
  }

  // 6. Tool Catalog and Action Safety Validation
  if (options.toolCatalog) {
    for (const a of rawIntent.actions) {
      const toolDef = options.toolCatalog.get(a.toolName);
      if (!toolDef) {
        throw new DomainError({
          code: "SCHEMA_VALIDATION_FAILED",
          userMessage: `Action references unsupported tool: ${a.toolName}`,
          metadata: { reason: "UNSUPPORTED_TOOL", toolName: a.toolName, actionId: a.actionId },
        });
      }

      // Validate input against tool's declared schema
      const toolInputValidation = toolDef.inputSchema.safeParse(a.input);
      if (!toolInputValidation.success) {
        throw new DomainError({
          code: "SCHEMA_VALIDATION_FAILED",
          userMessage: `Action input violates tool '${a.toolName}' schema.`,
          metadata: {
            reason: "INVALID_TOOL_INPUT",
            toolName: a.toolName,
            actionId: a.actionId,
            errors: toolInputValidation.error.errors,
          },
        });
      }
    }
  }

  // 7. Normalize timestamps and build canonical Invariants
  const canonicalInvariants: Invariant[] = rawInvariants.map((rawInv) => {
    const rawParams = { ...rawInv.parameters };
    if (rawInv.ruleType === "protectedTimeWindow") {
      const startAtVal = rawParams["startAt"];
      if (typeof startAtVal === "string") {
        const norm = normalizeToUtcIso(startAtVal);
        if (!norm) {
          throw new DomainError({
            code: "INVALID_INPUT",
            userMessage: `Invalid timestamp in invariant '${rawInv.invariantId}' startAt: ${startAtVal}`,
          });
        }
        rawParams["startAt"] = norm;
      }
      const endAtVal = rawParams["endAt"];
      if (typeof endAtVal === "string") {
        const norm = normalizeToUtcIso(endAtVal);
        if (!norm) {
          throw new DomainError({
            code: "INVALID_INPUT",
            userMessage: `Invalid timestamp in invariant '${rawInv.invariantId}' endAt: ${endAtVal}`,
          });
        }
        rawParams["endAt"] = norm;
      }
    } else if (rawInv.ruleType === "deadline") {
      const deadlineAtVal = rawParams["deadlineAt"];
      if (typeof deadlineAtVal === "string") {
        const norm = normalizeToUtcIso(deadlineAtVal);
        if (!norm) {
          throw new DomainError({
            code: "INVALID_INPUT",
            userMessage: `Invalid deadline in invariant '${rawInv.invariantId}': ${deadlineAtVal}`,
          });
        }
        rawParams["deadlineAt"] = norm;
      }
    } else if (rawInv.ruleType === "approvalRequired") {
      const targetActionId = rawParams["actionId"];
      if (typeof targetActionId !== "string" || !actionIdSet.has(targetActionId)) {
        throw new DomainError({
          code: "DEPENDENCY_NOT_FOUND",
          userMessage: `approvalRequired invariant '${rawInv.invariantId}' targets unknown action '${String(targetActionId)}'.`,
        });
      }
    }

    const candidate = {
      invariantId: rawInv.invariantId,
      description: rawInv.description,
      severity: rawInv.severity,
      ruleType: rawInv.ruleType,
      parameters: rawParams,
      createdAt: normalizedNow,
    };

    const invParse = validateWithSchema(invariantSchema, candidate);
    if (!invParse.ok) {
      throw new DomainError({
        code: "SCHEMA_VALIDATION_FAILED",
        userMessage: `Invariant '${rawInv.invariantId}' failed schema validation.`,
        metadata: { issues: invParse.issues },
      });
    }
    return invParse.value;
  });

  // 8. Build canonical Commitments
  const canonicalCommitments: Commitment[] = rawIntent.commitments.map((rawC) => {
    const normDeadline =
      rawC.deadlineAt !== null && rawC.deadlineAt !== undefined
        ? normalizeToUtcIso(rawC.deadlineAt)
        : null;

    if (rawC.deadlineAt !== null && rawC.deadlineAt !== undefined && normDeadline === null) {
      throw new DomainError({
        code: "INVALID_INPUT",
        userMessage: `Invalid deadline timestamp for commitment '${rawC.commitmentId}': ${rawC.deadlineAt}`,
      });
    }

    const candidate = {
      commitmentId: rawC.commitmentId,
      title: rawC.title,
      desiredOutcome: rawC.desiredOutcome,
      successCriteria: [
        {
          criterionId: `${rawC.commitmentId}_outcome`,
          description: `Verify desired outcome: ${rawC.title}`,
          isMandatory: true,
          verificationMode: "machineCheckable" as const,
          requiredEvidenceTypes: ["stateTransition" as const],
        },
      ],
      deadlineAt: normDeadline,
      priority: rawC.priority,
      dependencyIds: rawC.dependencyIds ?? [],
      invariantIds: rawC.invariantIds ?? [],
      evidenceRequirementIds: [],
      status: "open" as const,
      createdAt: normalizedNow,
      updatedAt: normalizedNow,
      version: 1,
    };

    const cParse = validateWithSchema(commitmentSchema, candidate);
    if (!cParse.ok) {
      throw new DomainError({
        code: "SCHEMA_VALIDATION_FAILED",
        userMessage: `Commitment '${rawC.commitmentId}' failed canonical schema validation.`,
        metadata: { issues: cParse.issues },
      });
    }
    return cParse.value;
  });

  // 9. Build canonical Actions
  const canonicalActions: PlannedAction[] = rawIntent.actions.map((rawA) => {
    const normEarliest =
      rawA.earliestStartAt !== null && rawA.earliestStartAt !== undefined
        ? normalizeToUtcIso(rawA.earliestStartAt)
        : null;
    const normDeadline =
      rawA.deadlineAt !== null && rawA.deadlineAt !== undefined
        ? normalizeToUtcIso(rawA.deadlineAt)
        : null;

    if (rawA.earliestStartAt && normEarliest === null) {
      throw new DomainError({
        code: "INVALID_INPUT",
        userMessage: `Invalid earliestStartAt for action '${rawA.actionId}': ${rawA.earliestStartAt}`,
      });
    }
    if (rawA.deadlineAt && normDeadline === null) {
      throw new DomainError({
        code: "INVALID_INPUT",
        userMessage: `Invalid deadlineAt for action '${rawA.actionId}': ${rawA.deadlineAt}`,
      });
    }

    // Check if an approvalRequired invariant targets this action
    const hasApprovalInvariant = canonicalInvariants.some(
      (inv) => inv.ruleType === "approvalRequired" && inv.parameters["actionId"] === rawA.actionId,
    );
    const requiresApproval = rawA.requiresApproval || hasApprovalInvariant;

    const candidate = {
      actionId: rawA.actionId,
      commitmentIds: rawA.commitmentIds,
      toolName: rawA.toolName,
      input: rawA.input,
      preconditionIds: [],
      dependencyActionIds: rawA.dependencyActionIds ?? [],
      estimatedDurationMinutes: rawA.estimatedDurationMinutes,
      earliestStartAt: normEarliest,
      deadlineAt: normDeadline,
      riskClass: rawA.riskClass,
      requiresApproval,
      approvalStatus: requiresApproval ? ("pending" as const) : ("notRequired" as const),
      status: "proposed" as const,
      idempotencyKey: rawA.idempotencyKey,
      createdAt: normalizedNow,
      updatedAt: normalizedNow,
      version: 1,
    };

    const aParse = validateWithSchema(plannedActionSchema, candidate);
    if (!aParse.ok) {
      throw new DomainError({
        code: "SCHEMA_VALIDATION_FAILED",
        userMessage: `Action '${rawA.actionId}' failed canonical schema validation.`,
        metadata: { issues: aParse.issues },
      });
    }
    return aParse.value;
  });

  // 10. Ambiguity processing: evaluate safety/authorization/recipient/deadline feasibility
  const ambiguities: Ambiguity[] = rawIntent.ambiguities ?? [];
  const hasCriticalAmbiguity = ambiguities.some(
    (amb) =>
      amb.blocking || (SAFETY_CRITICAL_AMBIGUITY_IMPACTS as readonly string[]).includes(amb.impact),
  );

  if (hasCriticalAmbiguity && options.rejectOnBlockingAmbiguity) {
    throw new DomainError({
      code: "AMBIGUOUS_REQUEST",
      userMessage: "The request has critical ambiguities requiring user clarification.",
      metadata: {
        ambiguities,
      },
    });
  }

  const proposalId = options.proposalId ?? `proposal_${Date.now()}`;

  return {
    proposalId,
    rawText,
    summary: rawIntent.summary,
    commitments: canonicalCommitments,
    actions: canonicalActions,
    invariants: canonicalInvariants,
    ambiguities,
    requiresClarification: hasCriticalAmbiguity,
    createdAt: normalizedNow,
  };
}

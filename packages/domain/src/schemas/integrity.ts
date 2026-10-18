import type { Commitment } from "./commitment.js";
import type { PlannedAction } from "./action.js";
import type { Invariant } from "./invariant.js";
import type { ValidationIssue } from "./validation.js";

export interface IntegrityInput {
  readonly commitments?: readonly Commitment[];
  readonly actions?: readonly PlannedAction[];
  readonly invariants?: readonly Invariant[];
}

function findDuplicates<T>(
  items: readonly T[],
  getId: (item: T) => string,
  collection: string,
  field: string,
  issues: ValidationIssue[],
): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const id = getId(item);
    if (seen.has(id)) {
      issues.push({
        path: `${collection}[${index}].${field}`,
        code: "DUPLICATE_ID",
        message: "Identifier is used more than once.",
      });
    }
    seen.add(id);
  });
}

/**
 * Cross-record referential integrity for a set of already schema-valid
 * records. A collection that is omitted is not checked, and references into it
 * are not reported (it is "not provided", not "empty"). Cycle detection is the
 * graph module's job, not this function's.
 */
export function checkReferentialIntegrity(input: IntegrityInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { commitments, actions, invariants } = input;

  if (commitments !== undefined) {
    findDuplicates(commitments, (c) => c.commitmentId, "commitments", "commitmentId", issues);
  }
  if (actions !== undefined) {
    findDuplicates(actions, (a) => a.actionId, "actions", "actionId", issues);
  }
  if (invariants !== undefined) {
    findDuplicates(invariants, (i) => i.invariantId, "invariants", "invariantId", issues);
  }

  const commitmentIds = commitments ? new Set(commitments.map((c) => c.commitmentId)) : null;
  const invariantIds = invariants ? new Set(invariants.map((i) => i.invariantId)) : null;
  const actionIds = actions ? new Set(actions.map((a) => a.actionId)) : null;

  const reportUnresolved = (path: string): void => {
    issues.push({
      path,
      code: "UNRESOLVED_REFERENCE",
      message: "Reference does not match any known record.",
    });
  };

  commitments?.forEach((commitment, index) => {
    if (commitmentIds !== null) {
      commitment.dependencyIds.forEach((id, position) => {
        if (!commitmentIds.has(id)) {
          reportUnresolved(`commitments[${index}].dependencyIds[${position}]`);
        }
      });
    }
    if (invariantIds !== null) {
      commitment.invariantIds.forEach((id, position) => {
        if (!invariantIds.has(id)) {
          reportUnresolved(`commitments[${index}].invariantIds[${position}]`);
        }
      });
    }
  });

  actions?.forEach((action, index) => {
    if (actionIds !== null) {
      action.dependencyActionIds.forEach((id, position) => {
        if (!actionIds.has(id)) {
          reportUnresolved(`actions[${index}].dependencyActionIds[${position}]`);
        }
      });
    }
    if (commitmentIds !== null) {
      action.commitmentIds.forEach((id, position) => {
        if (!commitmentIds.has(id)) {
          reportUnresolved(`actions[${index}].commitmentIds[${position}]`);
        }
      });
    }
  });

  return issues;
}

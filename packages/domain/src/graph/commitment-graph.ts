import { DomainError } from "../errors/domain-error.js";
import type { PlannedAction } from "../schemas/action.js";
import type { Commitment } from "../schemas/commitment.js";

/**
 * A vertex with the IDs it depends on. A dependency `u` of `v` is the edge
 * `u -> v`: `v` cannot begin until `u` satisfies its dependency condition.
 */
export interface GraphNode {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

/** Stage order is also the order in which issues are reported. */
export const GRAPH_ISSUE_CODES = [
  "DUPLICATE_NODE_ID",
  "MISSING_DEPENDENCY",
  "SELF_LOOP",
  "CYCLE_DETECTED",
] as const;
export type GraphIssueCode = (typeof GRAPH_ISSUE_CODES)[number];

export interface GraphIssue {
  readonly code: GraphIssueCode;
  /** The offending node (for a cycle: the smallest ID on the reported cycle). */
  readonly nodeId: string;
  /** The missing or self-referencing dependency, otherwise `null`. */
  readonly dependencyId: string | null;
  readonly message: string;
}

export interface CommitmentGraph {
  /** Deterministic topological order: every dependency precedes its dependents. */
  readonly order: readonly string[];
  /** Direct dependencies of each node, sorted by ID. */
  readonly dependenciesOf: ReadonlyMap<string, readonly string[]>;
  /** Direct dependents of each node, sorted by ID. */
  readonly dependentsOf: ReadonlyMap<string, readonly string[]>;
  readonly edgeCount: number;
}

export interface GraphFailure {
  readonly ok: false;
  readonly issues: readonly GraphIssue[];
  /**
   * One concrete cycle, rotated to start at its smallest ID. Each ID depends
   * on the next, and the last depends on the first. Empty unless a cycle exists.
   */
  readonly cycle: readonly string[];
  /** Every node that could not be ordered (on a cycle or downstream of one). */
  readonly blockedNodeIds: readonly string[];
}

export type GraphValidationResult =
  { readonly ok: true; readonly graph: CommitmentGraph } | GraphFailure;

/** Locale-independent code-unit comparison, so ordering never varies by host. */
function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function compareIssues(left: GraphIssue, right: GraphIssue): number {
  const byStage = GRAPH_ISSUE_CODES.indexOf(left.code) - GRAPH_ISSUE_CODES.indexOf(right.code);
  if (byStage !== 0) return byStage;
  return (
    compareIds(left.nodeId, right.nodeId) ||
    compareIds(left.dependencyId ?? "", right.dependencyId ?? "")
  );
}

function failure(
  issues: Map<string, GraphIssue>,
  cycle: readonly string[],
  blockedNodeIds: readonly string[],
): GraphFailure {
  return {
    ok: false,
    issues: [...issues.values()].sort(compareIssues),
    cycle,
    blockedNodeIds,
  };
}

/** Finds one cycle among nodes Kahn's algorithm could not place. */
function extractCycle(
  remaining: readonly string[],
  placed: ReadonlySet<string>,
  dependenciesOf: ReadonlyMap<string, readonly string[]>,
): string[] {
  const firstSeenAt = new Map<string, number>();
  const path: string[] = [];
  let current: string | undefined = remaining[0];
  while (current !== undefined) {
    const seenAt = firstSeenAt.get(current);
    if (seenAt !== undefined) {
      const cycle = path.slice(seenAt);
      const start = cycle.reduce(
        (best, id, index) => (compareIds(id, cycle[best] ?? id) < 0 ? index : best),
        0,
      );
      return [...cycle.slice(start), ...cycle.slice(0, start)];
    }
    firstSeenAt.set(current, path.length);
    path.push(current);
    // A node left with in-degree > 0 always has an unplaced dependency.
    current = dependenciesOf.get(current)?.find((id) => !placed.has(id));
  }
  throw new DomainError({
    code: "INTERNAL_ERROR",
    metadata: { reason: "cycle extraction found no unplaced dependency" },
  });
}

/**
 * Validates a dependency graph and returns a deterministic topological order
 * (Algorithm B, Kahn's algorithm).
 *
 * 1. Index nodes; reject duplicate IDs.
 * 2. Reject dependencies that name no node, and self-dependencies.
 *    All such structural issues are reported together; Kahn is not run on a
 *    structurally invalid graph.
 * 3. Kahn: compute in-degrees, queue zero-in-degree nodes (sorted by ID),
 *    repeatedly dequeue, append to the order, and decrement dependents
 *    (visited in ID order), queueing any that reach zero.
 * 4. If fewer than |V| nodes were ordered, a cycle exists; one concrete cycle
 *    and the full blocked set are reported.
 *
 * The result does not depend on input order. The order is deterministic but
 * is not the lexicographically smallest topological order. Repeated entries in
 * one node's `dependsOn` are treated as a single edge.
 *
 * Complexity: O(V + E) for the algorithm plus O(V log V) for ID sorting.
 */
export function buildCommitmentGraph(nodes: readonly GraphNode[]): GraphValidationResult {
  const issues = new Map<string, GraphIssue>();
  const addIssue = (issue: GraphIssue): void => {
    issues.set(`${issue.code}|${issue.nodeId}|${issue.dependencyId ?? ""}`, issue);
  };

  const knownIds = new Set<string>();
  for (const node of nodes) {
    if (knownIds.has(node.id)) {
      addIssue({
        code: "DUPLICATE_NODE_ID",
        nodeId: node.id,
        dependencyId: null,
        message: "More than one node has this ID.",
      });
    }
    knownIds.add(node.id);
  }

  const dependenciesOf = new Map<string, string[]>();
  for (const node of nodes) {
    const dependencies: string[] = [];
    for (const dependencyId of new Set(node.dependsOn)) {
      if (dependencyId === node.id) {
        addIssue({
          code: "SELF_LOOP",
          nodeId: node.id,
          dependencyId,
          message: "A node cannot depend on itself.",
        });
      } else if (!knownIds.has(dependencyId)) {
        addIssue({
          code: "MISSING_DEPENDENCY",
          nodeId: node.id,
          dependencyId,
          message: "The dependency does not match any node.",
        });
      } else {
        dependencies.push(dependencyId);
      }
    }
    if (!dependenciesOf.has(node.id)) {
      dependenciesOf.set(node.id, dependencies.sort(compareIds));
    }
  }

  if (issues.size > 0) return failure(issues, [], []);

  const sortedIds = [...knownIds].sort(compareIds);
  const inDegree = new Map<string, number>();
  const dependentsOf = new Map<string, string[]>();
  let edgeCount = 0;
  for (const id of sortedIds) dependentsOf.set(id, []);
  // Visiting nodes in ID order keeps every dependents list sorted for free.
  for (const id of sortedIds) {
    const dependencies = dependenciesOf.get(id) ?? [];
    inDegree.set(id, dependencies.length);
    edgeCount += dependencies.length;
    for (const dependencyId of dependencies) {
      dependentsOf.get(dependencyId)?.push(id);
    }
  }

  const queue = sortedIds.filter((id) => inDegree.get(id) === 0);
  const order: string[] = [];
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head] as string;
    order.push(id);
    for (const dependentId of dependentsOf.get(id) ?? []) {
      const remainingDegree = (inDegree.get(dependentId) ?? 0) - 1;
      inDegree.set(dependentId, remainingDegree);
      if (remainingDegree === 0) queue.push(dependentId);
    }
  }

  if (order.length < sortedIds.length) {
    const placed = new Set(order);
    const blockedNodeIds = sortedIds.filter((id) => !placed.has(id));
    const cycle = extractCycle(blockedNodeIds, placed, dependenciesOf);
    addIssue({
      code: "CYCLE_DETECTED",
      nodeId: cycle[0] ?? "",
      dependencyId: null,
      message: "The dependencies form a cycle, so no valid order exists.",
    });
    return failure(issues, cycle, blockedNodeIds);
  }

  return { ok: true, graph: { order, dependenciesOf, dependentsOf, edgeCount } };
}

/** Maps a graph failure to the typed domain error for its first issue. */
export function graphFailureToDomainError(result: GraphFailure): DomainError {
  const first = result.issues[0];
  const code =
    first?.code === "DUPLICATE_NODE_ID"
      ? "INVALID_INPUT"
      : first?.code === "MISSING_DEPENDENCY"
        ? "DEPENDENCY_NOT_FOUND"
        : "GRAPH_CYCLE_DETECTED";
  return new DomainError({
    code,
    metadata: {
      issueCount: result.issues.length,
      issues: result.issues.slice(0, 20),
      cycle: result.cycle,
      blockedNodeIds: result.blockedNodeIds,
    },
  });
}

/** Returns the valid graph or throws the typed error for its first issue. */
export function assertValidGraph(nodes: readonly GraphNode[]): CommitmentGraph {
  const result = buildCommitmentGraph(nodes);
  if (result.ok) return result.graph;
  throw graphFailureToDomainError(result);
}

/** Commitment dependencies as graph nodes. */
export function commitmentsToGraphNodes(
  commitments: ReadonlyArray<Pick<Commitment, "commitmentId" | "dependencyIds">>,
): GraphNode[] {
  return commitments.map((commitment) => ({
    id: commitment.commitmentId,
    dependsOn: commitment.dependencyIds,
  }));
}

/** Action dependencies as graph nodes. Keep action and commitment graphs separate. */
export function actionsToGraphNodes(
  actions: ReadonlyArray<Pick<PlannedAction, "actionId" | "dependencyActionIds">>,
): GraphNode[] {
  return actions.map((action) => ({
    id: action.actionId,
    dependsOn: action.dependencyActionIds,
  }));
}

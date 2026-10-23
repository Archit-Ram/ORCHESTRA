import { DomainError } from "../errors/domain-error.js";
import {
  actionsToGraphNodes,
  buildCommitmentGraph,
  graphFailureToDomainError,
} from "../graph/commitment-graph.js";
import type { PlannedAction } from "../schemas/action.js";
import { compareIds } from "./action-groups.js";

/**
 * The affected region of a change: the seed actions plus every action that
 * depends on a seed, directly or through other actions (forward reachability
 * along dependency edges, breadth first). The graph is built from every action
 * in the plan, finished ones included, so no dependency is skipped. An invalid
 * graph throws its typed error instead of returning a partial answer.
 *
 * Complexity: O(V + E).
 */
export function findAffectedActionIds(
  actions: ReadonlyArray<Pick<PlannedAction, "actionId" | "dependencyActionIds">>,
  seedActionIds: readonly string[],
): string[] {
  const graphResult = buildCommitmentGraph(actionsToGraphNodes(actions));
  if (!graphResult.ok) throw graphFailureToDomainError(graphResult);
  const { graph } = graphResult;

  const affected = new Set<string>();
  const queue: string[] = [];
  for (const seed of [...seedActionIds].sort(compareIds)) {
    if (!graph.dependenciesOf.has(seed)) {
      throw new DomainError({
        code: "DEPENDENCY_NOT_FOUND",
        userMessage: "The event refers to an action that is not in the plan.",
        metadata: { actionId: seed },
      });
    }
    if (!affected.has(seed)) {
      affected.add(seed);
      queue.push(seed);
    }
  }
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index] as string;
    for (const dependent of graph.dependentsOf.get(current) ?? []) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return [...affected].sort(compareIds);
}

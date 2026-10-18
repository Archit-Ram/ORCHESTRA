import { describe, expect, it } from "vitest";
import { DomainError } from "../src/errors/index.js";
import { plannedActionSchema } from "../src/schemas/action.js";
import { commitmentSchema } from "../src/schemas/commitment.js";
import {
  actionsToGraphNodes,
  assertValidGraph,
  buildCommitmentGraph,
  commitmentsToGraphNodes,
  graphFailureToDomainError,
  type GraphNode,
} from "../src/graph/commitment-graph.js";
import { validAction, validCommitment, validFinalizeAction } from "./helpers/fixtures.js";

function node(id: string, ...dependsOn: string[]): GraphNode {
  return { id, dependsOn };
}

function orderOf(nodes: GraphNode[]): readonly string[] {
  const result = buildCommitmentGraph(nodes);
  if (!result.ok) throw new Error(`expected success: ${JSON.stringify(result.issues)}`);
  return result.graph.order;
}

function failureOf(nodes: GraphNode[]) {
  const result = buildCommitmentGraph(nodes);
  if (result.ok) throw new Error("expected failure");
  return result;
}

function codes(nodes: GraphNode[]): string[] {
  return failureOf(nodes).issues.map((issue) => `${issue.code}:${issue.nodeId}`);
}

describe("buildCommitmentGraph: valid graphs", () => {
  it("accepts an empty graph", () => {
    const result = buildCommitmentGraph([]);
    expect(result.ok).toBe(true);
    expect(orderOf([])).toEqual([]);
  });

  it("accepts a single node", () => {
    expect(orderOf([node("a")])).toEqual(["a"]);
  });

  it("orders disconnected nodes by ID", () => {
    expect(orderOf([node("c"), node("a"), node("b")])).toEqual(["a", "b", "c"]);
  });

  it("orders a chain dependency-first regardless of input order", () => {
    expect(orderOf([node("c", "b"), node("b", "a"), node("a")])).toEqual(["a", "b", "c"]);
    expect(orderOf([node("a"), node("b", "a"), node("c", "b")])).toEqual(["a", "b", "c"]);
  });

  it("orders a chain whose IDs sort against the dependency direction", () => {
    expect(orderOf([node("a", "b"), node("b", "c"), node("c")])).toEqual(["c", "b", "a"]);
  });

  it("handles diamond dependencies", () => {
    const order = orderOf([node("d", "b", "c"), node("b", "a"), node("c", "a"), node("a")]);
    expect(order).toEqual(["a", "b", "c", "d"]);
  });

  it("is deterministic but follows queue order, not lexicographic minimum", () => {
    // Roots b and e queue first; a becomes ready after b, so it follows e.
    expect(orderOf([node("a", "b"), node("b"), node("e")])).toEqual(["b", "e", "a"]);
  });

  it("gives identical output for every input permutation", () => {
    const nodes = [node("d", "b", "c"), node("b", "a"), node("c", "a"), node("a"), node("e")];
    const expected = orderOf(nodes);
    const permutations: GraphNode[][] = [
      [...nodes].reverse(),
      [
        nodes[2] as GraphNode,
        nodes[4] as GraphNode,
        nodes[0] as GraphNode,
        nodes[3] as GraphNode,
        nodes[1] as GraphNode,
      ],
      [
        nodes[4] as GraphNode,
        nodes[3] as GraphNode,
        nodes[2] as GraphNode,
        nodes[1] as GraphNode,
        nodes[0] as GraphNode,
      ],
    ];
    for (const permutation of permutations) {
      expect(orderOf(permutation)).toEqual(expected);
    }
  });

  it("is repeatable across calls", () => {
    const nodes = [node("b", "a"), node("a"), node("c", "a")];
    expect(orderOf(nodes)).toEqual(orderOf(nodes));
  });

  it("compares IDs by code unit, not by locale", () => {
    expect(orderOf([node("b"), node("B"), node("a"), node("_x"), node("1")])).toEqual([
      "1",
      "B",
      "_x",
      "a",
      "b",
    ]);
  });

  it("treats repeated dependencies as one edge", () => {
    const result = buildCommitmentGraph([node("b", "a", "a"), node("a")]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.graph.order).toEqual(["a", "b"]);
      expect(result.graph.edgeCount).toBe(1);
    }
  });

  it("exposes sorted direct dependencies and dependents", () => {
    const result = buildCommitmentGraph([
      node("d", "c", "b"),
      node("b", "a"),
      node("c", "a"),
      node("a"),
    ]);
    if (!result.ok) throw new Error("expected success");
    expect(result.graph.dependenciesOf.get("d")).toEqual(["b", "c"]);
    expect(result.graph.dependentsOf.get("a")).toEqual(["b", "c"]);
    expect(result.graph.dependentsOf.get("d")).toEqual([]);
    expect(result.graph.edgeCount).toBe(4);
  });

  it("handles a very long chain without recursion limits", () => {
    const size = 20_000;
    const nodes = Array.from({ length: size }, (_, index) =>
      node(
        `n${String(index).padStart(6, "0")}`,
        ...(index === 0 ? [] : [`n${String(index - 1).padStart(6, "0")}`]),
      ),
    );
    const order = orderOf(nodes.reverse());
    expect(order).toHaveLength(size);
    expect(order[0]).toBe("n000000");
    expect(order[size - 1]).toBe("n019999");
  });
});

describe("buildCommitmentGraph: structural errors", () => {
  it("rejects a duplicate node ID", () => {
    expect(codes([node("a"), node("a")])).toEqual(["DUPLICATE_NODE_ID:a"]);
  });

  it("reports a triplicated ID once", () => {
    expect(codes([node("a"), node("a"), node("a")])).toEqual(["DUPLICATE_NODE_ID:a"]);
  });

  it("rejects a dependency on a missing node", () => {
    const result = failureOf([node("a", "ghost")]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.code).toBe("MISSING_DEPENDENCY");
    expect(result.issues[0]?.nodeId).toBe("a");
    expect(result.issues[0]?.dependencyId).toBe("ghost");
    expect(result.cycle).toEqual([]);
  });

  it("rejects a self-loop", () => {
    const result = failureOf([node("a", "a")]);
    expect(result.issues.map((issue) => issue.code)).toEqual(["SELF_LOOP"]);
    expect(result.cycle).toEqual([]);
  });

  it("reports all structural issues together in a stable order", () => {
    const nodes = [
      node("z", "ghost"),
      node("b", "b"),
      node("a"),
      node("a"),
      node("m", "nope", "ghost"),
    ];
    expect(codes(nodes)).toEqual([
      "DUPLICATE_NODE_ID:a",
      "MISSING_DEPENDENCY:m",
      "MISSING_DEPENDENCY:m",
      "MISSING_DEPENDENCY:z",
      "SELF_LOOP:b",
    ]);
    expect(codes([...nodes].reverse())).toEqual(codes(nodes));
  });

  it("does not run cycle detection on structurally invalid graphs", () => {
    const result = failureOf([node("a", "b"), node("b", "a"), node("c", "ghost")]);
    expect(result.issues.map((issue) => issue.code)).toEqual(["MISSING_DEPENDENCY"]);
    expect(result.blockedNodeIds).toEqual([]);
  });

  it("does not mutate its input", () => {
    const nodes = [node("b", "a"), node("a")];
    const snapshot = JSON.stringify(nodes);
    buildCommitmentGraph(nodes);
    expect(JSON.stringify(nodes)).toBe(snapshot);
  });
});

describe("buildCommitmentGraph: cycles", () => {
  it("detects a two-node cycle", () => {
    const result = failureOf([node("a", "b"), node("b", "a")]);
    expect(result.issues.map((issue) => issue.code)).toEqual(["CYCLE_DETECTED"]);
    expect(result.cycle).toEqual(["a", "b"]);
    expect(result.blockedNodeIds).toEqual(["a", "b"]);
  });

  it("detects a longer cycle and reports it from its smallest ID", () => {
    const nodes = [node("d", "c"), node("c", "b"), node("b", "a"), node("a", "d")];
    const result = failureOf(nodes);
    expect(result.cycle).toEqual(["a", "d", "c", "b"]);
    expect(result.issues[0]?.nodeId).toBe("a");
  });

  it("orders healthy nodes out but still fails, blocking downstream nodes", () => {
    const nodes = [
      node("ok1"),
      node("ok2", "ok1"),
      node("x", "y"),
      node("y", "x"),
      node("after", "x"),
      node("alsoAfter", "after"),
    ];
    const result = failureOf(nodes);
    expect(result.cycle).toEqual(["x", "y"]);
    expect(result.blockedNodeIds).toEqual(["after", "alsoAfter", "x", "y"]);
  });

  it("reports a cycle that is upstream-fed by valid nodes", () => {
    const result = failureOf([node("root"), node("a", "root", "b"), node("b", "a")]);
    expect(result.cycle).toEqual(["a", "b"]);
    expect(result.blockedNodeIds).toEqual(["a", "b"]);
  });

  it("produces the same cycle report for every input order", () => {
    const nodes = [node("c", "a"), node("a", "b"), node("b", "c"), node("z")];
    const expected = failureOf(nodes);
    expect(failureOf([...nodes].reverse()).cycle).toEqual(expected.cycle);
    expect(failureOf([...nodes].reverse()).blockedNodeIds).toEqual(expected.blockedNodeIds);
  });

  it("rotates a cycle entered mid-way so it starts at its smallest ID", () => {
    // The search starts at "a", enters the cycle at "z", and must report y, z.
    const result = failureOf([node("a", "z"), node("z", "y"), node("y", "z")]);
    expect(result.cycle).toEqual(["y", "z"]);
    expect(result.blockedNodeIds).toEqual(["a", "y", "z"]);
  });

  it("matches acceptance scenario 5: action A depends on B and B on A", () => {
    const result = failureOf([node("actionA", "actionB"), node("actionB", "actionA")]);
    expect(result.cycle).toEqual(["actionA", "actionB"]);
  });
});

describe("typed errors", () => {
  it("maps a cycle to GRAPH_CYCLE_DETECTED", () => {
    const error = graphFailureToDomainError(failureOf([node("a", "b"), node("b", "a")]));
    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe("GRAPH_CYCLE_DETECTED");
    expect(error.metadata["cycle"]).toEqual(["a", "b"]);
  });

  it("maps a self-loop to GRAPH_CYCLE_DETECTED", () => {
    expect(graphFailureToDomainError(failureOf([node("a", "a")])).code).toBe(
      "GRAPH_CYCLE_DETECTED",
    );
  });

  it("maps a missing dependency to DEPENDENCY_NOT_FOUND", () => {
    expect(graphFailureToDomainError(failureOf([node("a", "ghost")])).code).toBe(
      "DEPENDENCY_NOT_FOUND",
    );
  });

  it("maps a duplicate ID to INVALID_INPUT", () => {
    expect(graphFailureToDomainError(failureOf([node("a"), node("a")])).code).toBe("INVALID_INPUT");
  });

  it("reports the first issue in stage order when several kinds exist", () => {
    const error = graphFailureToDomainError(failureOf([node("a"), node("a"), node("b", "ghost")]));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.metadata["issueCount"]).toBe(2);
  });

  it("assertValidGraph returns the graph or throws a DomainError", () => {
    expect(assertValidGraph([node("a")]).order).toEqual(["a"]);
    expect(() => assertValidGraph([node("a", "a")])).toThrow(DomainError);
  });
});

describe("adapters for schema-validated records", () => {
  it("builds nodes from actions and orders them", () => {
    const actions = [
      plannedActionSchema.parse(validAction()),
      plannedActionSchema.parse(validFinalizeAction()),
    ];
    const nodes = actionsToGraphNodes(actions);
    expect(nodes).toEqual([
      { id: "action_send_report", dependsOn: ["action_finalize_report"] },
      { id: "action_finalize_report", dependsOn: [] },
    ]);
    expect(orderOf(nodes)).toEqual(["action_finalize_report", "action_send_report"]);
  });

  it("builds nodes from commitments", () => {
    const base = commitmentSchema.parse(validCommitment());
    const dependent = commitmentSchema.parse({
      ...validCommitment(),
      commitmentId: "commitment_followup",
      dependencyIds: ["commitment_report_delivery"],
    });
    const nodes = commitmentsToGraphNodes([dependent, base]);
    expect(orderOf(nodes)).toEqual(["commitment_report_delivery", "commitment_followup"]);
  });
});

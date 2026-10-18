# Algorithm B: commitment graph construction and validation (Prompt 3)

Code: `packages/domain/src/graph/commitment-graph.ts`
Tests: `packages/domain/tests/graph.test.ts`, `packages/domain/tests/graph-generated.test.ts`

> If `docs/algorithms.md` exists, merge this page into it as its Algorithm B
> section. It is a separate file only so the patch could not conflict.

## Model

`G = (V, E)`. Each vertex has an ID and a list of IDs it depends on. A dependency
`u` of `v` is the edge `u -> v`: `v` cannot begin until `u` satisfies its
dependency condition. The module works for any vertex kind. Use
`commitmentsToGraphNodes` and `actionsToGraphNodes` to build inputs; keep
commitment graphs and action graphs separate so IDs cannot collide.

## Steps

1. Index nodes by ID; report each duplicate ID once (`DUPLICATE_NODE_ID`).
2. Report each dependency that names no node (`MISSING_DEPENDENCY`) and each
   self-dependency (`SELF_LOOP`). All structural issues are returned together,
   sorted by stage, then node ID, then dependency ID. If any exist, the cycle
   check is **not** run, because it would be meaningless on a broken graph.
3. Kahn's algorithm:
   - in-degree of a node = number of distinct dependencies;
   - queue every zero-in-degree node, sorted by ID;
   - repeatedly dequeue a node, append it to the order, and decrement each of
     its dependents (visited in ID order); a dependent reaching zero joins the
     queue.
4. If fewer than `|V|` nodes were ordered, a cycle exists (`CYCLE_DETECTED`).
   The result then carries one concrete cycle and the full blocked set.
5. Success returns the order, sorted direct dependencies and dependents of every
   node, and the edge count.

## Properties

- **Deterministic and input-order independent.** Nodes are processed by ID using
  code-unit comparison (never locale-dependent), so any permutation of the same
  graph gives the same order, issues, cycle, and blocked set.
- **Not the lexicographically smallest order.** Output follows queue order. With
  roots `b`, `e` and `a` depending on `b`, the order is `b, e, a`, not `b, a, e`.
  Documented here and pinned by a test.
- **Repeated entries** in one node's dependency list count as one edge.
- **Cycle report.** `cycle` lists IDs where each depends on the next and the last
  depends on the first, rotated to start at the smallest ID. It is one real cycle
  even when several exist. `blockedNodeIds` lists every node left unordered,
  which includes nodes merely downstream of a cycle.
- **Complexity.** `O(V + E)` for the algorithm plus `O(V log V)` to sort IDs;
  dependents lists are built in ID order, so no per-neighbour sort is needed.
  Iterative, so very deep chains do not overflow the stack (tested at 20,000).

## Errors

`graphFailureToDomainError` / `assertValidGraph` map the first issue (in stage
order) to a typed error: duplicate ID -> `INVALID_INPUT`, missing dependency ->
`DEPENDENCY_NOT_FOUND`, self-loop or cycle -> `GRAPH_CYCLE_DETECTED`. Metadata
holds node IDs only (no payloads).

## Limitations

- No node-count cap here. Upstream schemas bound plan size (500 actions,
  100 commitments); callers that skip the schemas must bound input themselves.
- The module checks structure only. Deadlines, durations, and scheduling are
  Prompt 4; dependency ordering against start times is the verifier (Prompt 5).
- Structured log events such as `commitmentGraphCycleDetected` are emitted by
  callers once logging exists (Prompt 13), not by this pure module.

## Testing

- Example tests: empty, single, disconnected, chain, diamond, duplicate ID,
  missing endpoint, self-loop, two-node and longer cycles, deterministic order,
  input-permutation independence, downstream-of-cycle nodes, error mapping,
  adapters, 20,000-node chain.
- Generated tests (no new dependency; a seeded PRNG, 300 seeds each):
  - random DAGs: every node appears once and every dependency precedes its
    dependent; shuffled input gives identical output;
  - random graphs: success/failure agrees with an independent iterative DFS
    cycle detector, and both outcomes are exercised;
  - failures: the reported cycle is a real cycle contained in the blocked set;
  - rings of random length closed over random acyclic graphs are always found.

A property-testing library was deliberately not added: the seeded generator
covers the property, keeps the dependency set unchanged, and is reproducible.

## Suggested lines for `docs/implementation-status.md`

| Requirement                                              | Status       | Evidence                       |
| -------------------------------------------------------- | ------------ | ------------------------------ |
| Algorithm B: graph validation and Kahn topological order | `tested`     | `pnpm test:unit` (graph tests) |
| Graph errors mapped to typed domain errors               | `tested`     | `pnpm test:unit`               |
| Algorithm C: scheduler                                   | `notStarted` | Prompt 4                       |

Mark `tested` only after `pnpm test:unit` passes in the real repository.

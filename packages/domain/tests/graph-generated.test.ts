import { describe, expect, it } from "vitest";
import { buildCommitmentGraph, type GraphNode } from "../src/graph/commitment-graph.js";

/** Small seeded PRNG (mulberry32) so generated cases are reproducible. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap] as T, copy[index] as T];
  }
  return copy;
}

function makeIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `node_${String(index).padStart(3, "0")}`);
}

/** Independent oracle: iterative three-colour DFS cycle detection. */
function hasCycleByDfs(nodes: readonly GraphNode[]): boolean {
  const dependencies = new Map(nodes.map((n) => [n.id, n.dependsOn] as const));
  const colour = new Map<string, 1 | 2>();
  for (const start of dependencies.keys()) {
    if (colour.has(start)) continue;
    const stack: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
    colour.set(start, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { id: string; next: number };
      const list = dependencies.get(frame.id) ?? [];
      if (frame.next >= list.length) {
        colour.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const child = list[frame.next] as string;
      frame.next += 1;
      const state = colour.get(child);
      if (state === 1) return true;
      if (state === undefined) {
        colour.set(child, 1);
        stack.push({ id: child, next: 0 });
      }
    }
  }
  return false;
}

function randomDag(seed: number): GraphNode[] {
  const random = createRandom(seed);
  const ranked = shuffle(makeIds(Math.floor(random() * 30)), random);
  const density = random() * 0.5;
  return ranked.map((id, index) => ({
    id,
    dependsOn: ranked.slice(0, index).filter(() => random() < density),
  }));
}

const SEEDS = Array.from({ length: 300 }, (_, index) => index + 1);

describe("generated acyclic graphs", () => {
  it("place every dependency before its dependent and every node exactly once", () => {
    for (const seed of SEEDS) {
      const nodes = randomDag(seed);
      const result = buildCommitmentGraph(shuffle(nodes, createRandom(seed + 10_000)));
      if (!result.ok) throw new Error(`seed ${seed}: expected success`);
      const { order } = result.graph;
      expect({ seed, size: order.length }).toEqual({ seed, size: nodes.length });
      expect({ seed, unique: new Set(order).size }).toEqual({ seed, unique: nodes.length });
      const position = new Map(order.map((id, index) => [id, index] as const));
      for (const n of nodes) {
        for (const dependencyId of n.dependsOn) {
          const before = position.get(dependencyId) as number;
          const after = position.get(n.id) as number;
          if (before >= after) throw new Error(`seed ${seed}: ${dependencyId} not before ${n.id}`);
        }
      }
    }
  });

  it("give the same order for every shuffle of the input", () => {
    for (const seed of SEEDS) {
      const nodes = randomDag(seed);
      const first = buildCommitmentGraph(shuffle(nodes, createRandom(seed)));
      const second = buildCommitmentGraph(shuffle(nodes, createRandom(seed + 77)));
      if (!first.ok || !second.ok) throw new Error(`seed ${seed}: expected success`);
      expect({ seed, order: second.graph.order }).toEqual({ seed, order: first.graph.order });
    }
  });
});

describe("generated arbitrary graphs", () => {
  it("agree with an independent DFS cycle oracle", () => {
    let cyclic = 0;
    for (const seed of SEEDS) {
      const random = createRandom(seed);
      const ids = makeIds(1 + Math.floor(random() * 12));
      const nodes = ids.map((id) => ({ id, dependsOn: ids.filter(() => random() < 0.15) }));
      const result = buildCommitmentGraph(nodes);
      const expectedCyclic = hasCycleByDfs(nodes);
      if (expectedCyclic) cyclic += 1;
      expect({ seed, ok: result.ok }).toEqual({ seed, ok: !expectedCyclic });
    }
    // The generator must actually exercise both outcomes.
    expect(cyclic).toBeGreaterThan(20);
    expect(cyclic).toBeLessThan(SEEDS.length - 20);
  });

  it("report a genuine cycle and a blocked set that contains it", () => {
    let checked = 0;
    for (const seed of SEEDS) {
      const random = createRandom(seed);
      const ids = makeIds(2 + Math.floor(random() * 12));
      const nodes = ids.map((id) => ({
        id,
        dependsOn: ids.filter((other) => other !== id && random() < 0.2),
      }));
      const result = buildCommitmentGraph(nodes);
      if (result.ok) continue;
      checked += 1;
      const { cycle, blockedNodeIds } = result;
      expect(cycle.length).toBeGreaterThan(1);
      const dependencies = new Map(nodes.map((n) => [n.id, n.dependsOn] as const));
      cycle.forEach((id, index) => {
        const next = cycle[(index + 1) % cycle.length] as string;
        if (!(dependencies.get(id) ?? []).includes(next)) {
          throw new Error(`seed ${seed}: ${id} does not depend on ${next}`);
        }
      });
      expect(new Set(cycle).size).toBe(cycle.length);
      expect([...cycle].sort()[0]).toBe(cycle[0]);
      for (const id of cycle) expect(blockedNodeIds).toContain(id);
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("detect a ring of any length closed over a random acyclic graph", () => {
    for (const seed of SEEDS) {
      const random = createRandom(seed);
      const ringLength = 2 + Math.floor(random() * 6);
      const ids = makeIds(ringLength + Math.floor(random() * 6));
      const ring = ids.slice(0, ringLength);
      const nodes: GraphNode[] = ids.map((id, index) => {
        const extra = index < ringLength ? [] : ids.slice(0, index).filter(() => random() < 0.3);
        const ringDependency = index < ringLength ? [ring[(index + 1) % ringLength] as string] : [];
        return { id, dependsOn: [...ringDependency, ...extra] };
      });
      const result = buildCommitmentGraph(shuffle(nodes, random));
      if (result.ok) throw new Error(`seed ${seed}: ring not detected`);
      expect({ seed, cycle: result.cycle }).toEqual({ seed, cycle: ring });
    }
  });
});

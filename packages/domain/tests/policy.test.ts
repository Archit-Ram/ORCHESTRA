import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DomainError } from "../src/errors/index.js";
import {
  computeActionPayloadHash,
  computeSideEffectFingerprint,
  evaluateApproval,
} from "../src/policy/approval.js";
import { canonicalJson } from "../src/policy/canonical-json.js";
import { sha256Hex } from "../src/policy/sha256.js";
import {
  createToolCatalog,
  missingScopes,
  toolRequiresApproval,
  type ToolDefinition,
} from "../src/policy/tool-catalog.js";
import { approvalRecordSchema } from "../src/schemas/approval.js";
import { validApproval } from "./helpers/fixtures.js";

describe("sha256Hex", () => {
  const vectors: ReadonlyArray<readonly [string, string]> = [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
    [
      "The quick brown fox jumps over the lazy dog",
      "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592",
    ],
    ["a".repeat(55), "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318"],
    ["a".repeat(56), "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a"],
    ["a".repeat(64), "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb"],
    ["héllo wörld", "a1003f7d04a4115711d0b48a2eaf1359ce565d2d2a6fd65098dfcffadeeef59f"],
    ["emoji 😀🎉", "ff0ee4101add718633e9dd50a65fdea9277a5436e5a3a5ebc924995e83d84334"],
    ["日本語", "77710aedc74ecfa33685e33a6c7df5cc83004da1bdcef7fb280f5c2b2e97e0a5"],
  ];
  for (const [input, expected] of vectors) {
    it(`matches the reference digest for a ${input.length}-character input`, () => {
      expect(sha256Hex(input)).toBe(expected);
    });
  }

  it("matches the NIST one-million-'a' vector", () => {
    expect(sha256Hex("a".repeat(1_000_000))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });

  it("treats lone surrogates as U+FFFD like a standard UTF-8 encoder", () => {
    expect(sha256Hex("\ud800")).toBe(sha256Hex("\ufffd"));
    expect(sha256Hex("x\udc00y")).toBe(sha256Hex("x\ufffdy"));
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every depth and drops whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 2], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,2]},"b":1}',
    );
  });

  it("is independent of key insertion order but not of array order", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("keeps types distinct", () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }));
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
    expect(canonicalJson({ a: true })).not.toBe(canonicalJson({ a: "true" }));
  });

  it("escapes strings and normalizes negative zero", () => {
    expect(canonicalJson({ a: 'q"\n\u00e9' })).toBe('{"a":"q\\"\\n\u00e9"}');
    expect(canonicalJson(-0)).toBe("0");
  });

  it("rejects values that JSON.stringify would silently alter or drop", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    class Box {
      value = 1;
    }
    const unsupported: unknown[] = [
      { a: undefined },
      Number.NaN,
      Number.POSITIVE_INFINITY,
      10n,
      () => 1,
      Symbol("s"),
      new Date(),
      new Map(),
      new Box(),
      cyclic,
      [undefined],
    ];
    for (const value of unsupported) expect(() => canonicalJson(value)).toThrow(DomainError);
  });

  it("rejects very deep nesting", () => {
    let deep: unknown = 1;
    for (let level = 0; level < 100; level += 1) deep = { next: deep };
    expect(() => canonicalJson(deep)).toThrow(DomainError);
  });

  it("accepts null-prototype objects", () => {
    const record = Object.create(null) as Record<string, unknown>;
    record["a"] = 1;
    expect(canonicalJson(record)).toBe('{"a":1}');
  });
});

describe("computeActionPayloadHash", () => {
  const base = {
    actionId: "action_1",
    toolName: "sendEmail",
    input: { recipient: "a@example.com", documentId: "doc_1" },
  };

  it("is a lowercase hex SHA-256 that ignores key order", () => {
    expect(computeActionPayloadHash(base)).toMatch(/^[a-f0-9]{64}$/);
    expect(
      computeActionPayloadHash({
        ...base,
        input: { documentId: "doc_1", recipient: "a@example.com" },
      }),
    ).toBe(computeActionPayloadHash(base));
  });

  it("changes when the action, tool, or any input value changes", () => {
    const original = computeActionPayloadHash(base);
    expect(computeActionPayloadHash({ ...base, actionId: "action_2" })).not.toBe(original);
    expect(computeActionPayloadHash({ ...base, toolName: "sendSms" })).not.toBe(original);
    expect(
      computeActionPayloadHash({ ...base, input: { ...base.input, recipient: "b@example.com" } }),
    ).not.toBe(original);
    expect(computeActionPayloadHash({ ...base, input: { ...base.input, extra: 1 } })).not.toBe(
      original,
    );
  });

  it("produces a hash that the approval record schema accepts", () => {
    const record = { ...validApproval(), payloadHash: computeActionPayloadHash(base) };
    expect(approvalRecordSchema.safeParse(record).success).toBe(true);
  });

  it("builds a side-effect fingerprint that ignores the action ID", () => {
    expect(computeSideEffectFingerprint(base)).toBe(
      computeSideEffectFingerprint({ ...base, actionId: "action_2" } as typeof base),
    );
    expect(computeSideEffectFingerprint(base)).not.toBe(
      computeSideEffectFingerprint({ ...base, input: {} }),
    );
  });
});

describe("tool catalog and tool policy", () => {
  const schema = z.object({}).strict();
  function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
    return {
      toolName: "doThing",
      environment: "simulator",
      category: "write",
      riskClass: "medium",
      isReversible: false,
      requiredScopes: ["things:write"],
      inputSchema: schema,
      ...overrides,
    };
  }

  it("stores and returns tools in sorted name order", () => {
    const catalog = createToolCatalog([tool({ toolName: "zeta" }), tool({ toolName: "alpha" })]);
    expect(catalog.names()).toEqual(["alpha", "zeta"]);
    expect(catalog.get("alpha")?.toolName).toBe("alpha");
    expect(catalog.get("missing")).toBeUndefined();
  });

  it("rejects duplicate names, bad names and malformed scopes", () => {
    expect(() => createToolCatalog([tool(), tool()])).toThrow(DomainError);
    expect(() => createToolCatalog([tool({ toolName: "Do_Thing" })])).toThrow(DomainError);
    expect(() => createToolCatalog([tool({ requiredScopes: ["Bad Scope"] })])).toThrow(DomainError);
    expect(() => createToolCatalog([tool({ requiredScopes: [] })])).not.toThrow();
  });

  it("requires approval for every high-impact category regardless of risk class", () => {
    for (const category of [
      "externalCommunication",
      "purchase",
      "deletion",
      "accountChange",
    ] as const) {
      for (const riskClass of ["low", "medium", "high"] as const) {
        expect(toolRequiresApproval(tool({ category, riskClass, isReversible: true }))).toBe(true);
      }
    }
  });

  it("requires approval for any high-risk tool, even read-only", () => {
    expect(toolRequiresApproval(tool({ category: "read", riskClass: "high" }))).toBe(true);
  });

  it("lets read-only and low-risk reversible tools run automatically", () => {
    expect(toolRequiresApproval(tool({ category: "read", riskClass: "low" }))).toBe(false);
    expect(toolRequiresApproval(tool({ category: "read", riskClass: "medium" }))).toBe(false);
    expect(
      toolRequiresApproval(tool({ category: "write", riskClass: "low", isReversible: true })),
    ).toBe(false);
  });

  it("requires approval for irreversible or medium-risk writes", () => {
    expect(
      toolRequiresApproval(tool({ category: "write", riskClass: "low", isReversible: false })),
    ).toBe(true);
    expect(
      toolRequiresApproval(tool({ category: "write", riskClass: "medium", isReversible: true })),
    ).toBe(true);
  });

  it("reports missing scopes sorted", () => {
    const t = tool({ requiredScopes: ["b:write", "a:read", "c:x"] });
    expect(missingScopes({ userId: "u", scopes: ["c:x"] }, t)).toEqual(["a:read", "b:write"]);
    expect(missingScopes({ userId: "u", scopes: ["a:read", "b:write", "c:x"] }, t)).toEqual([]);
  });
});

describe("evaluateApproval", () => {
  const action = {
    actionId: "action_1",
    toolName: "sendEmail",
    input: { recipient: "a@example.com" },
  };
  const NOW = Date.parse("2026-10-23T09:00:00.000Z");
  const hash = computeActionPayloadHash(action);
  const approval = (overrides: Record<string, unknown> = {}) =>
    approvalRecordSchema.parse({
      ...validApproval(),
      approvalId: "approval_1",
      actionId: "action_1",
      planId: "plan_1",
      planVersion: 1,
      payloadHash: hash,
      approverId: "user_1",
      decision: "approved",
      decidedAt: "2026-10-23T08:00:00.000Z",
      expiresAt: "2026-10-23T18:00:00.000Z",
      ...overrides,
    });
  const evaluate = (
    approvals: ReturnType<typeof approval>[],
    extra: { consumed?: string[]; required?: boolean; approvers?: string[] } = {},
  ) =>
    evaluateApproval({
      action,
      isApprovalRequired: extra.required ?? true,
      planId: "plan_1",
      planVersion: 1,
      approvals,
      authorizedApproverIds: new Set(extra.approvers ?? ["user_1"]),
      consumedApprovalIds: new Set(extra.consumed ?? []),
      nowMs: NOW,
    });

  it("is notRequired when policy does not require approval, even with no records", () => {
    expect(evaluate([], { required: false }).status).toBe("notRequired");
  });

  it("is missing with no records and approved with one valid record", () => {
    expect(evaluate([]).status).toBe("missing");
    expect(evaluate([]).errorCode).toBe("APPROVAL_REQUIRED");
    const ok = evaluate([approval()]);
    expect(ok.status).toBe("approved");
    expect(ok.approvalId).toBe("approval_1");
    expect(ok.errorCode).toBeNull();
  });

  it("ignores records for other actions and other plans", () => {
    expect(evaluate([approval({ actionId: "action_other" })]).status).toBe("missing");
    expect(evaluate([approval({ planId: "plan_other" })]).status).toBe("missing");
  });

  it("only counts authorized approvers, and an unauthorized rejection cannot block", () => {
    expect(evaluate([approval({ approverId: "mallory" })]).status).toBe("unauthorizedApprover");
    const mixed = evaluate([
      approval(),
      approval({
        approvalId: "approval_2",
        approverId: "mallory",
        decision: "rejected",
        decidedAt: "2026-10-23T08:30:00.000Z",
      }),
    ]);
    expect(mixed.status).toBe("approved");
  });

  it("lets the most recent decision win", () => {
    const early = approval({ approvalId: "a1", decidedAt: "2026-10-23T08:00:00.000Z" });
    const late = (decision: "approved" | "rejected") =>
      approval({ approvalId: "a2", decision, decidedAt: "2026-10-23T08:30:00.000Z" });
    expect(evaluate([early, late("rejected")]).status).toBe("rejected");
    expect(evaluate([late("rejected"), early]).status).toBe("rejected");
    expect(evaluate([approval({ decision: "rejected" }), late("approved")]).status).toBe(
      "approved",
    );
  });

  it("breaks decision-time ties by approval ID, highest wins", () => {
    const same = "2026-10-23T08:00:00.000Z";
    expect(
      evaluate([
        approval({ approvalId: "approval_a", decidedAt: same }),
        approval({ approvalId: "approval_b", decision: "rejected", decidedAt: same }),
      ]).status,
    ).toBe("rejected");
    expect(
      evaluate([
        approval({ approvalId: "approval_b", decidedAt: same }),
        approval({ approvalId: "approval_a", decision: "rejected", decidedAt: same }),
      ]).status,
    ).toBe("approved");
  });

  it("rejects a different plan version", () => {
    const result = evaluate([approval({ planVersion: 2 })]);
    expect(result.status).toBe("planVersionMismatch");
    expect(result.errorCode).toBe("APPROVAL_PAYLOAD_MISMATCH");
  });

  it("rejects a changed payload", () => {
    const result = evaluate([
      approval({
        payloadHash: computeActionPayloadHash({
          ...action,
          input: { recipient: "evil@example.com" },
        }),
      }),
    ]);
    expect(result.status).toBe("payloadMismatch");
    expect(result.errorCode).toBe("APPROVAL_PAYLOAD_MISMATCH");
  });

  it("treats expiry as exclusive: valid until the last millisecond", () => {
    expect(evaluate([approval({ expiresAt: "2026-10-23T09:00:00.001Z" })]).status).toBe("approved");
    const expired = evaluate([approval({ expiresAt: "2026-10-23T09:00:00.000Z" })]);
    expect(expired.status).toBe("expired");
    expect(expired.errorCode).toBe("APPROVAL_EXPIRED");
  });

  it("rejects approvals dated in the future", () => {
    expect(evaluate([approval({ decidedAt: "2026-10-23T09:00:00.001Z" })]).status).toBe(
      "notYetValid",
    );
    expect(evaluate([approval({ decidedAt: "2026-10-23T09:00:00.000Z" })]).status).toBe("approved");
  });

  it("rejects a replayed approval", () => {
    const result = evaluate([approval()], { consumed: ["approval_1"] });
    expect(result.status).toBe("replayed");
    expect(result.errorCode).toBe("POLICY_DENIED");
  });

  it("checks payload before expiry and replay, so tampering is reported as tampering", () => {
    const tampered = approval({
      payloadHash: "0".repeat(64),
      expiresAt: "2026-10-23T08:30:00.000Z",
    });
    expect(evaluate([tampered], { consumed: ["approval_1"] }).status).toBe("payloadMismatch");
  });
});

/** Seeded PRNG so the generated cases are reproducible. */
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

function randomValue(random: () => number, depth: number): unknown {
  const kind = Math.floor(random() * (depth > 2 ? 4 : 6));
  if (kind === 0) return Math.floor(random() * 1000);
  if (kind === 1) return `s${Math.floor(random() * 1000)}`;
  if (kind === 2) return random() < 0.5;
  if (kind === 3) return null;
  if (kind === 4)
    return Array.from({ length: 1 + Math.floor(random() * 3) }, () =>
      randomValue(random, depth + 1),
    );
  const record: Record<string, unknown> = {};
  for (let index = 0; index < 1 + Math.floor(random() * 4); index += 1)
    record[`k${Math.floor(random() * 6)}`] = randomValue(random, depth + 1);
  return record;
}

/** Returns a deep copy with exactly one change somewhere in the structure. */
function mutateOnce(value: unknown, random: () => number): unknown {
  if (Array.isArray(value) && value.length > 0 && random() < 0.8) {
    const copy = [...value];
    const index = Math.floor(random() * copy.length);
    copy[index] = mutateOnce(copy[index], random);
    return copy;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = { ...(value as Record<string, unknown>) };
    const keys = Object.keys(record);
    if (keys.length > 0 && random() < 0.8) {
      const key = keys[Math.floor(random() * keys.length)] as string;
      record[key] = mutateOnce(record[key], random);
    } else {
      record["added"] = 1;
    }
    return record;
  }
  if (typeof value === "number") return value + 1;
  if (typeof value === "string") return `${value}x`;
  if (typeof value === "boolean") return !value;
  return 0;
}

describe("generated payload tampering", () => {
  it("any single change to an approved input voids the approval, and key order never does", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = createRandom(seed);
      const input = { payload: randomValue(random, 0), recipient: "a@example.com" };
      const action = { actionId: "action_1", toolName: "sendEmail", input };
      const record = approvalRecordSchema.parse({
        ...validApproval(),
        approvalId: "approval_1",
        actionId: "action_1",
        planId: "plan_1",
        planVersion: 1,
        payloadHash: computeActionPayloadHash(action),
        approverId: "user_1",
        decidedAt: "2026-10-23T08:00:00.000Z",
        expiresAt: "2026-10-23T18:00:00.000Z",
      });
      const evaluateFor = (candidate: {
        actionId: string;
        toolName: string;
        input: Record<string, unknown>;
      }) =>
        evaluateApproval({
          action: candidate,
          isApprovalRequired: true,
          planId: "plan_1",
          planVersion: 1,
          approvals: [record],
          authorizedApproverIds: new Set(["user_1"]),
          consumedApprovalIds: new Set(),
          nowMs: Date.parse("2026-10-23T09:00:00.000Z"),
        });

      expect({ seed, status: evaluateFor(action).status }).toEqual({ seed, status: "approved" });
      const reordered = { ...action, input: Object.fromEntries(Object.entries(input).reverse()) };
      expect({ seed, status: evaluateFor(reordered).status }).toEqual({ seed, status: "approved" });
      const tampered = { ...action, input: mutateOnce(input, random) as Record<string, unknown> };
      expect({ seed, status: evaluateFor(tampered).status }).toEqual({
        seed,
        status: "payloadMismatch",
      });
    }
  });
});

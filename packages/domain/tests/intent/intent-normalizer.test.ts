import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DomainError } from "../../src/errors/domain-error.js";
import {
  extractJsonFromModelOutput,
  normalizeIntentProposal,
} from "../../src/intent/intent-normalizer.js";
import { createToolCatalog, type ToolDefinition } from "../../src/policy/tool-catalog.js";

const NOW = "2026-10-23T08:00:00.000Z";

const SAMPLE_TOOLS: ToolDefinition[] = [
  {
    toolName: "sendEmail",
    environment: "simulator",
    category: "externalCommunication",
    riskClass: "medium",
    isReversible: false,
    requiredScopes: ["email:send"],
    inputSchema: z
      .object({
        recipient: z.string().email(),
        subject: z.string().min(1),
        body: z.string().min(1),
      })
      .strict(),
  },
  {
    toolName: "createCalendarEvent",
    environment: "simulator",
    category: "write",
    riskClass: "low",
    isReversible: true,
    requiredScopes: ["calendar:write"],
    inputSchema: z
      .object({
        title: z.string().min(1),
        startAt: z.string(),
      })
      .strict(),
  },
];

const CATALOG = createToolCatalog(SAMPLE_TOOLS);

const VALID_RAW_OUTPUT = JSON.stringify({
  summary: "Schedule meeting and send confirmation email.",
  commitments: [
    {
      commitmentId: "comm_meeting",
      title: "Team Sync Meeting",
      desiredOutcome: "Ensure team sync is scheduled and attendees notified.",
      priority: "high",
      deadlineAt: "2026-10-23T15:00:00+02:00", // Non-UTC offset for normalization test
      dependencyIds: [],
      invariantIds: ["inv_approval"],
    },
  ],
  actions: [
    {
      actionId: "act_calendar",
      commitmentIds: ["comm_meeting"],
      toolName: "createCalendarEvent",
      input: {
        title: "Sprint Planning",
        startAt: "2026-10-23T14:00:00Z",
      },
      dependencyActionIds: [],
      estimatedDurationMinutes: 5,
      requiresApproval: false,
      riskClass: "low",
      idempotencyKey: "cal_idem_key_001",
    },
    {
      actionId: "act_email",
      commitmentIds: ["comm_meeting"],
      toolName: "sendEmail",
      input: {
        recipient: "team@example.com",
        subject: "Sprint Planning Confirmation",
        body: "See you at 2 PM.",
      },
      dependencyActionIds: ["act_calendar"],
      estimatedDurationMinutes: 2,
      requiresApproval: true,
      riskClass: "medium",
      idempotencyKey: "email_idem_key_002",
    },
  ],
  invariants: [
    {
      invariantId: "inv_approval",
      description: "Require approval before sending outbound email.",
      severity: "hard",
      ruleType: "approvalRequired",
      parameters: { actionId: "act_email" },
    },
  ],
  ambiguities: [
    {
      ambiguityId: "amb_timezone",
      question: "Which timezone should be used for the calendar invite?",
      impact: "deadline",
      blocking: true,
      suggestedClarification: "Confirm whether UTC or local timezone.",
    },
  ],
});

describe("Algorithm A: Intent Normalizer (normalizeIntentProposal)", () => {
  it("parses and normalizes a valid model proposal cleanly", () => {
    const proposal = normalizeIntentProposal(VALID_RAW_OUTPUT, {
      toolCatalog: CATALOG,
      now: NOW,
    });

    expect(proposal.summary).toBe("Schedule meeting and send confirmation email.");
    expect(proposal.commitments).toHaveLength(1);
    expect(proposal.actions).toHaveLength(2);
    expect(proposal.invariants).toHaveLength(1);
    expect(proposal.ambiguities).toHaveLength(1);

    // Verify timestamp normalization (converts +02:00 to canonical UTC Z)
    const comm = proposal.commitments[0];
    expect(comm?.deadlineAt).toBe("2026-10-23T13:00:00.000Z");

    // Verify action approval resolution (act_email requires approval)
    const actEmail = proposal.actions.find((a) => a.actionId === "act_email");
    expect(actEmail?.requiresApproval).toBe(true);
    expect(actEmail?.approvalStatus).toBe("pending");

    // Verify clarification needed due to deadline ambiguity
    expect(proposal.requiresClarification).toBe(true);
  });

  it("extracts JSON enclosed within markdown code fences", () => {
    const markdown = "Here is your plan:\n```json\n" + VALID_RAW_OUTPUT + "\n```\nHope this helps!";
    const proposal = normalizeIntentProposal(markdown, { toolCatalog: CATALOG, now: NOW });
    expect(proposal.commitments).toHaveLength(1);
  });

  it("rejects empty or malformed model responses", () => {
    expect(() => extractJsonFromModelOutput("")).toThrowError(DomainError);
    expect(() => extractJsonFromModelOutput("This is not JSON at all.")).toThrowError(DomainError);
    expect(() => extractJsonFromModelOutput("{ incomplete: json")).toThrowError(DomainError);
  });

  it("rejects duplicate IDs across commitments, actions, and invariants", () => {
    // Duplicate commitment ID
    const duplicateCommitment = JSON.stringify({
      summary: "test",
      commitments: [
        { commitmentId: "dup_id", title: "A", desiredOutcome: "A" },
        { commitmentId: "dup_id", title: "B", desiredOutcome: "B" },
      ],
      actions: [
        {
          actionId: "act_1",
          commitmentIds: ["dup_id"],
          toolName: "createCalendarEvent",
          input: { title: "Test", startAt: NOW },
          idempotencyKey: "idem_key_001",
        },
      ],
    });

    expect(() => normalizeIntentProposal(duplicateCommitment)).toThrowError(DomainError);
    try {
      normalizeIntentProposal(duplicateCommitment);
    } catch (err) {
      expect((err as DomainError).code).toBe("INVALID_INPUT");
    }
  });

  it("rejects unresolved references (actions pointing to unknown commitments or actions)", () => {
    const unknownCommitmentRef = JSON.stringify({
      summary: "test",
      commitments: [{ commitmentId: "comm_1", title: "A", desiredOutcome: "A" }],
      actions: [
        {
          actionId: "act_1",
          commitmentIds: ["non_existent_comm"],
          toolName: "createCalendarEvent",
          input: { title: "Test", startAt: NOW },
          idempotencyKey: "idem_key_001",
        },
      ],
    });

    expect(() => normalizeIntentProposal(unknownCommitmentRef)).toThrowError(DomainError);
    try {
      normalizeIntentProposal(unknownCommitmentRef);
    } catch (err) {
      expect((err as DomainError).code).toBe("DEPENDENCY_NOT_FOUND");
    }
  });

  it("detects and rejects dependency cycles using Kahn's algorithm (Algorithm B)", () => {
    const cyclicActions = JSON.stringify({
      summary: "cyclic actions",
      commitments: [{ commitmentId: "comm_1", title: "A", desiredOutcome: "A" }],
      actions: [
        {
          actionId: "act_1",
          commitmentIds: ["comm_1"],
          toolName: "createCalendarEvent",
          input: { title: "Test 1", startAt: NOW },
          dependencyActionIds: ["act_2"],
          idempotencyKey: "idem_key_001",
        },
        {
          actionId: "act_2",
          commitmentIds: ["comm_1"],
          toolName: "createCalendarEvent",
          input: { title: "Test 2", startAt: NOW },
          dependencyActionIds: ["act_1"],
          idempotencyKey: "idem_key_002",
        },
      ],
    });

    expect(() => normalizeIntentProposal(cyclicActions)).toThrowError(DomainError);
    try {
      normalizeIntentProposal(cyclicActions);
    } catch (err) {
      expect((err as DomainError).code).toBe("GRAPH_CYCLE_DETECTED");
    }
  });

  it("rejects unsupported tool names when toolCatalog is provided", () => {
    const unsupportedTool = JSON.stringify({
      summary: "unsupported",
      commitments: [{ commitmentId: "comm_1", title: "A", desiredOutcome: "A" }],
      actions: [
        {
          actionId: "act_1",
          commitmentIds: ["comm_1"],
          toolName: "deleteDatabase", // Not in CATALOG
          input: { all: true },
          idempotencyKey: "idem_key_001",
        },
      ],
    });

    expect(() => normalizeIntentProposal(unsupportedTool, { toolCatalog: CATALOG })).toThrowError(
      DomainError,
    );
    try {
      normalizeIntentProposal(unsupportedTool, { toolCatalog: CATALOG });
    } catch (err) {
      expect((err as DomainError).code).toBe("SCHEMA_VALIDATION_FAILED");
    }
  });

  it("validates tool input parameters against catalog schemas", () => {
    const badInput = JSON.stringify({
      summary: "bad input",
      commitments: [{ commitmentId: "comm_1", title: "A", desiredOutcome: "A" }],
      actions: [
        {
          actionId: "act_1",
          commitmentIds: ["comm_1"],
          toolName: "sendEmail",
          input: {
            recipient: "not-an-email", // invalid email
            subject: "Hi",
            body: "Test",
          },
          idempotencyKey: "idem_key_001",
        },
      ],
    });

    expect(() => normalizeIntentProposal(badInput, { toolCatalog: CATALOG })).toThrowError(
      DomainError,
    );
  });

  it("validates invariant parameters and resolves target actions", () => {
    const unknownActionInApproval = JSON.stringify({
      summary: "bad invariant target",
      commitments: [
        {
          commitmentId: "comm_1",
          title: "A",
          desiredOutcome: "A",
          invariantIds: ["inv_1"],
        },
      ],
      actions: [
        {
          actionId: "act_1",
          commitmentIds: ["comm_1"],
          toolName: "createCalendarEvent",
          input: { title: "Test", startAt: NOW },
          idempotencyKey: "idem_key_001",
        },
      ],
      invariants: [
        {
          invariantId: "inv_1",
          description: "Approval required",
          severity: "hard",
          ruleType: "approvalRequired",
          parameters: { actionId: "non_existent_action" },
        },
      ],
    });

    expect(() => normalizeIntentProposal(unknownActionInApproval)).toThrowError(DomainError);
    try {
      normalizeIntentProposal(unknownActionInApproval);
    } catch (err) {
      expect((err as DomainError).code).toBe("DEPENDENCY_NOT_FOUND");
    }
  });

  it("throws AMBIGUOUS_REQUEST when rejectOnBlockingAmbiguity is enabled", () => {
    expect(() =>
      normalizeIntentProposal(VALID_RAW_OUTPUT, {
        toolCatalog: CATALOG,
        rejectOnBlockingAmbiguity: true,
      }),
    ).toThrowError(DomainError);

    try {
      normalizeIntentProposal(VALID_RAW_OUTPUT, {
        toolCatalog: CATALOG,
        rejectOnBlockingAmbiguity: true,
      });
    } catch (err) {
      expect((err as DomainError).code).toBe("AMBIGUOUS_REQUEST");
    }
  });
});

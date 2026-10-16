import { describe, expect, it } from "vitest";
import { z } from "zod";
import { approvalRecordSchema } from "../src/schemas/approval.js";
import { externalEventSchema } from "../src/schemas/event.js";
import { evidenceRecordSchema } from "../src/schemas/evidence.js";
import { toolResultSchema } from "../src/schemas/tool-result.js";
import {
  expectAccepted,
  expectRejected,
  SHA256_A,
  validApproval,
  validEvent,
  validEvidence,
} from "./helpers/fixtures.js";

describe("evidenceRecordSchema", () => {
  it("accepts valid evidence, including null reference and hash", () => {
    expectAccepted(evidenceRecordSchema, validEvidence());
    expectAccepted(evidenceRecordSchema, { ...validEvidence(), providerReference: null, contentHash: null });
  });

  it("rejects missing fields and extra fields", () => {
    for (const field of Object.keys(validEvidence())) {
      const input: Record<string, unknown> = { ...validEvidence() };
      delete input[field];
      expectRejected(evidenceRecordSchema, input, field, "REQUIRED_FIELD_MISSING");
    }
    expectRejected(evidenceRecordSchema, { ...validEvidence(), emailBody: "full text" }, "$", "UNRECOGNIZED_FIELD");
  });

  it("rejects invalid enums, hashes and timestamps", () => {
    expectRejected(evidenceRecordSchema, { ...validEvidence(), result: "probablySuccess" }, "result", "INVALID_ENUM_VALUE");
    expectRejected(evidenceRecordSchema, { ...validEvidence(), evidenceType: "modelOpinion" }, "evidenceType", "INVALID_ENUM_VALUE");
    expectRejected(evidenceRecordSchema, { ...validEvidence(), contentHash: "abc" }, "contentHash", "INVALID_FORMAT");
    expectRejected(evidenceRecordSchema, { ...validEvidence(), observedAt: "yesterday" }, "observedAt", "INVALID_TIMESTAMP");
  });

  it("rejects an oversized summary", () => {
    expectRejected(evidenceRecordSchema, { ...validEvidence(), summary: "s".repeat(501) }, "summary", "OUT_OF_RANGE");
  });

  it("requires approval evidence to concern an action", () => {
    expectAccepted(evidenceRecordSchema, { ...validEvidence(), evidenceType: "userApproval", subjectType: "action" });
    expectRejected(
      evidenceRecordSchema,
      { ...validEvidence(), evidenceType: "userApproval", subjectType: "commitment" },
      "subjectType",
      "INCONSISTENT_STATE",
    );
  });
});

describe("approvalRecordSchema", () => {
  it("accepts a valid approval and a valid rejection", () => {
    expectAccepted(approvalRecordSchema, validApproval());
    expectAccepted(approvalRecordSchema, { ...validApproval(), decision: "rejected" });
  });

  it("rejects every missing field", () => {
    for (const field of Object.keys(validApproval())) {
      const input: Record<string, unknown> = { ...validApproval() };
      delete input[field];
      expectRejected(approvalRecordSchema, input, field, "REQUIRED_FIELD_MISSING");
    }
  });

  it("rejects malformed payload hashes", () => {
    expectRejected(approvalRecordSchema, { ...validApproval(), payloadHash: "not-a-hash" }, "payloadHash", "INVALID_FORMAT");
    expectRejected(approvalRecordSchema, { ...validApproval(), payloadHash: SHA256_A.toUpperCase() }, "payloadHash", "INVALID_FORMAT");
    expectRejected(approvalRecordSchema, { ...validApproval(), payloadHash: `${SHA256_A}00` }, "payloadHash", "INVALID_FORMAT");
  });

  it("rejects an unknown decision", () => {
    expectRejected(approvalRecordSchema, { ...validApproval(), decision: "maybe" }, "decision", "INVALID_ENUM_VALUE");
    expectRejected(approvalRecordSchema, { ...validApproval(), decision: "pending" }, "decision", "INVALID_ENUM_VALUE");
  });

  it("rejects an expiry that is not after the decision", () => {
    expectRejected(approvalRecordSchema, { ...validApproval(), expiresAt: validApproval().decidedAt }, "expiresAt", "INVALID_ORDER");
    expectRejected(approvalRecordSchema, { ...validApproval(), expiresAt: "2026-10-23T09:00:00.000Z" }, "expiresAt", "INVALID_ORDER");
  });

  it("rejects malformed timestamps and invalid plan versions", () => {
    expectRejected(approvalRecordSchema, { ...validApproval(), decidedAt: "now" }, "decidedAt", "INVALID_TIMESTAMP");
    expectRejected(approvalRecordSchema, { ...validApproval(), planVersion: 0 }, "planVersion", "OUT_OF_RANGE");
    expectRejected(approvalRecordSchema, { ...validApproval(), planVersion: 1.5 }, "planVersion", "INVALID_TYPE");
  });

  it("rejects model-asserted authorization fields", () => {
    expectRejected(approvalRecordSchema, { ...validApproval(), approvedByModel: true }, "$", "UNRECOGNIZED_FIELD");
  });
});

describe("externalEventSchema", () => {
  const windowEvent = {
    ...validEvent(),
    eventType: "protectedWindowChanged",
    payload: {
      invariantId: "invariant_meeting",
      startAt: "2026-10-23T15:00:00.000Z",
      endAt: "2026-10-23T16:00:00.000Z",
    },
  };
  const outcomeEvent = {
    ...validEvent(),
    eventType: "providerOutcomeReported",
    payload: { actionId: "action_send_report", outcome: "succeeded", providerReference: null },
  };

  it("accepts each supported event type", () => {
    expectAccepted(externalEventSchema, validEvent());
    expectAccepted(externalEventSchema, windowEvent);
    expectAccepted(externalEventSchema, outcomeEvent);
  });

  it("rejects an unknown event type", () => {
    expectRejected(externalEventSchema, { ...validEvent(), eventType: "dropDatabase" }, "eventType", "INVALID_VARIANT");
  });

  it("rejects missing base fields", () => {
    for (const field of ["eventId", "source", "occurredAt", "correlationId", "environment", "payload"]) {
      const input: Record<string, unknown> = { ...validEvent() };
      delete input[field];
      expectRejected(externalEventSchema, input, field, "REQUIRED_FIELD_MISSING");
    }
  });

  it("rejects bad environment, timestamp and payload fields", () => {
    expectRejected(externalEventSchema, { ...validEvent(), environment: "production" }, "environment", "INVALID_ENUM_VALUE");
    expectRejected(externalEventSchema, { ...validEvent(), occurredAt: "soon" }, "occurredAt", "INVALID_TIMESTAMP");
    expectRejected(externalEventSchema, { ...validEvent(), payload: { actionId: "action_x", delayMinutes: 0 } }, "payload.delayMinutes", "OUT_OF_RANGE");
    expectRejected(externalEventSchema, { ...validEvent(), payload: { actionId: "action_x", delayMinutes: -5 } }, "payload.delayMinutes", "OUT_OF_RANGE");
    expectRejected(externalEventSchema, { ...validEvent(), payload: { actionId: "action_x", delayMinutes: 1.5 } }, "payload.delayMinutes", "INVALID_TYPE");
  });

  it("rejects extra payload and top-level fields", () => {
    expectRejected(
      externalEventSchema,
      { ...validEvent(), payload: { actionId: "action_x", delayMinutes: 5, command: "rm -rf" } },
      "payload",
      "UNRECOGNIZED_FIELD",
    );
    expectRejected(externalEventSchema, { ...validEvent(), apply: true }, "$", "UNRECOGNIZED_FIELD");
  });

  it("rejects a protected window event that ends before it starts", () => {
    expectRejected(
      externalEventSchema,
      { ...windowEvent, payload: { ...windowEvent.payload, endAt: "2026-10-23T14:00:00.000Z" } },
      "payload.endAt",
      "INVALID_ORDER",
    );
  });

  it("rejects an invalid provider outcome", () => {
    expectRejected(
      externalEventSchema,
      { ...outcomeEvent, payload: { ...outcomeEvent.payload, outcome: "delivered" } },
      "payload.outcome",
      "INVALID_ENUM_VALUE",
    );
  });
});

describe("toolResultSchema", () => {
  const schema = toolResultSchema(z.object({ count: z.number() }).strict());
  const error = {
    code: "PROVIDER_TIMEOUT",
    message: "The external service did not respond in time.",
    retryability: "retryable",
  };

  it("accepts a successful result and a failed result", () => {
    expectAccepted(schema, { success: true, requestId: "req_0001", data: { count: 2 } });
    expectAccepted(schema, { success: false, requestId: "req_0001", error });
  });

  it("accepts warnings on a successful result", () => {
    expectAccepted(schema, {
      success: true,
      requestId: "req_0001",
      data: { count: 1 },
      warnings: [{ code: "PLAN_AT_RISK", message: "Slack is below the threshold." }],
    });
  });

  it("rejects success without data or with an error", () => {
    expectRejected(schema, { success: true, requestId: "req_0001" }, "data", "REQUIRED_FIELD_MISSING");
    expectRejected(schema, { success: true, requestId: "req_0001", data: { count: 1 }, error }, "error", "INCONSISTENT_STATE");
  });

  it("rejects failure without an error or with data", () => {
    expectRejected(schema, { success: false, requestId: "req_0001" }, "error", "REQUIRED_FIELD_MISSING");
    expectRejected(schema, { success: false, requestId: "req_0001", error, data: { count: 1 } }, "data", "INCONSISTENT_STATE");
  });

  it("validates data against the supplied schema", () => {
    expectRejected(schema, { success: true, requestId: "req_0001", data: { count: "2" } }, "data.count", "INVALID_TYPE");
  });

  it("rejects an unknown error code and bad warning codes", () => {
    expectRejected(schema, { success: false, requestId: "req_0001", error: { ...error, code: "SOMETHING_ELSE" } }, "error.code", "INVALID_ENUM_VALUE");
    expectRejected(
      schema,
      { success: true, requestId: "req_0001", data: { count: 1 }, warnings: [{ code: "lower", message: "x" }] },
      "warnings[0].code",
      "INVALID_FORMAT",
    );
  });

  it("rejects a missing requestId and extra fields", () => {
    expectRejected(schema, { success: true, data: { count: 1 } }, "requestId", "REQUIRED_FIELD_MISSING");
    expectRejected(schema, { success: true, requestId: "req_0001", data: { count: 1 }, commitmentFulfilled: true }, "$", "UNRECOGNIZED_FIELD");
  });

  it("keeps tool success distinct from commitment status", () => {
    const result = schema.safeParse({ success: true, requestId: "req_0001", data: { count: 1 } });
    expect(result.success).toBe(true);
    expect(Object.keys(result.success ? result.data : {})).not.toContain("commitmentStatus");
  });
});

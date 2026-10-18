import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/errors/domain-error.js";
import type { StructuredLogEntry } from "../../src/intent/bedrock-adapter.js";
import { FakeIntentModel } from "../../src/intent/fake-intent-model.js";
import { IntentService } from "../../src/intent/intent-service.js";

const VALID_RESPONSE = {
  summary: "Organize project kickoff",
  commitments: [
    {
      commitmentId: "comm_kickoff",
      title: "Kickoff Meeting",
      desiredOutcome: "Team is aligned on goals.",
    },
  ],
  actions: [
    {
      actionId: "act_send_invite",
      commitmentIds: ["comm_kickoff"],
      toolName: "sendEmail",
      input: { recipient: "all@company.com", subject: "Kickoff", body: "Join us" },
      idempotencyKey: "idem_key_kickoff_01",
    },
  ],
};

describe("IntentService (End-to-end model invocation & Algorithm A normalization)", () => {
  it("interprets natural language into a canonical IntentProposal", async () => {
    const fakeModel = new FakeIntentModel().setSuccessResponse(VALID_RESPONSE);
    const service = new IntentService(fakeModel);

    const proposal = await service.interpretIntent({
      text: "Organize project kickoff meeting and send invite.",
      context: { currentTimestamp: "2026-10-23T09:00:00Z" },
    });

    expect(proposal.summary).toBe("Organize project kickoff");
    expect(proposal.commitments).toHaveLength(1);
    expect(proposal.commitments[0]?.commitmentId).toBe("comm_kickoff");
    expect(proposal.commitments[0]?.status).toBe("open");
    expect(proposal.actions).toHaveLength(1);
    expect(proposal.actions[0]?.status).toBe("proposed");
    expect(proposal.requiresClarification).toBe(false);
  });

  it("emits intentValidationFailed structured log when normalization fails", async () => {
    const logs: StructuredLogEntry[] = [];
    const fakeModel = new FakeIntentModel().setDefaultBehavior({ kind: "malformedJson" });
    const service = new IntentService(fakeModel, undefined, {
      logSink: (entry) => logs.push(entry),
    });

    await expect(
      service.interpretIntent({
        text: "Bad model response",
        requestId: "req_validation_fail_01",
      }),
    ).rejects.toThrowError(DomainError);

    expect(logs).toHaveLength(1);
    expect(logs[0]?.eventName).toBe("intentValidationFailed");
    expect(logs[0]?.requestId).toBe("req_validation_fail_01");
    expect(logs[0]?.result).toBe("failure");
    expect(logs[0]?.errorCode).toBe("SCHEMA_VALIDATION_FAILED");
  });
});

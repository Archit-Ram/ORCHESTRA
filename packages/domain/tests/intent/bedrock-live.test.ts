import process from "node:process";
import { describe, expect, it } from "vitest";
import { BedrockIntentAdapter } from "../../src/intent/bedrock-adapter.js";
import { normalizeIntentProposal } from "../../src/intent/intent-normalizer.js";

const hasLiveCredentials = Boolean(
  process.env["AWS_ACCESS_KEY_ID"] &&
  process.env["AWS_SECRET_ACCESS_KEY"] &&
  process.env["BEDROCK_MODEL_ID"],
);

describe("Live Amazon Bedrock Integration Test", () => {
  if (!hasLiveCredentials) {
    it.skip("executes real Amazon Bedrock model call and normalizes live response (skipped: credentials or BEDROCK_MODEL_ID not configured)", () => {
      // Intentionally skipped when live credentials are not present in environment
    });
  } else {
    it("executes real Amazon Bedrock model call and normalizes live response", async () => {
      const adapter = new BedrockIntentAdapter({
        region: process.env["AWS_REGION"] ?? "us-east-1",
        modelId: process.env["BEDROCK_MODEL_ID"] ?? "anthropic.claude-3-haiku-20240307-v1:0",
      });

      const response = await adapter.generateIntent({
        text: "Please send an email to rahul@example.com summarizing the project status tomorrow at 10 AM.",
      });

      expect(response.rawText).toBeTruthy();
      expect(response.modelId).toBe(process.env["BEDROCK_MODEL_ID"]);
      expect(response.latencyMs).toBeGreaterThan(0);

      const proposal = normalizeIntentProposal(response.rawText);
      expect(proposal.commitments.length).toBeGreaterThan(0);
      expect(proposal.actions.length).toBeGreaterThan(0);
    });
  }
});

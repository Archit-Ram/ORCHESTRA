import { describe, expect, it, vi } from "vitest";
import type {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { DomainError } from "../../src/errors/domain-error.js";
import {
  BedrockIntentAdapter,
  classifyBedrockError,
  type StructuredLogEntry,
} from "../../src/intent/bedrock-adapter.js";

function createMockClient(
  handler: (command: ConverseCommand) => Promise<ConverseCommandOutput>,
): BedrockRuntimeClient {
  return {
    send: vi.fn().mockImplementation(handler),
  } as unknown as BedrockRuntimeClient;
}

const SAMPLE_RESPONSE_TEXT = JSON.stringify({
  summary: "Sample valid intent",
  commitments: [
    {
      commitmentId: "comm_test",
      title: "Test Commitment",
      desiredOutcome: "Complete test",
    },
  ],
  actions: [
    {
      actionId: "act_test",
      commitmentIds: ["comm_test"],
      toolName: "sendEmail",
      input: { recipient: "a@b.com", subject: "S", body: "B" },
      idempotencyKey: "idem_key_001",
    },
  ],
});

describe("Amazon Bedrock Intent Adapter (BedrockIntentAdapter)", () => {
  it("successfully invokes Converse API and extracts response, latency, and tokens", async () => {
    const logs: StructuredLogEntry[] = [];
    const mockClient = createMockClient(async (cmd) => {
      expect(cmd.input.modelId).toBe("anthropic.claude-3-haiku-20240307-v1:0");
      expect(cmd.input.messages?.[0]?.content?.[0]?.text).toBe("Send a report to Rahul.");
      return {
        $metadata: { httpStatusCode: 200, requestId: "aws_req_12345" },
        output: {
          message: {
            role: "assistant",
            content: [{ text: SAMPLE_RESPONSE_TEXT }],
          },
        },
        usage: {
          inputTokens: 120,
          outputTokens: 250,
          totalTokens: 370,
        },
        metrics: {
          latencyMs: 340,
        },
      };
    });

    const adapter = new BedrockIntentAdapter({
      client: mockClient,
      modelId: "anthropic.claude-3-haiku-20240307-v1:0",
      region: "us-east-1",
      logSink: (entry) => logs.push(entry),
    });

    const response = await adapter.generateIntent({
      text: "Send a report to Rahul.",
      correlationId: "corr_abc",
    });

    expect(response.rawText).toBe(SAMPLE_RESPONSE_TEXT);
    expect(response.modelId).toBe("anthropic.claude-3-haiku-20240307-v1:0");
    expect(response.requestId).toBe("aws_req_12345");
    expect(response.usage?.totalTokens).toBe(370);
    expect(response.latencyMs).toBeGreaterThanOrEqual(0);

    // Verify structured logging: started & completed emitted
    expect(logs).toHaveLength(2);
    expect(logs[0]?.eventName).toBe("intentParsingStarted");
    expect(logs[1]?.eventName).toBe("intentParsingCompleted");
    expect(logs[1]?.result).toBe("success");
    expect(logs[1]?.usage?.totalTokens).toBe(370);

    // Verify no secret or full user prompt was logged in log fields
    for (const log of logs) {
      expect((log as unknown as Record<string, unknown>)["text"]).toBeUndefined();
      expect((log as unknown as Record<string, unknown>)["prompt"]).toBeUndefined();
    }
  });

  it("retries transient timeout errors with backoff and jitter, then succeeds", async () => {
    const sleepSpy = vi.fn().mockResolvedValue(undefined);
    let attempts = 0;

    const mockClient = createMockClient(async () => {
      attempts += 1;
      if (attempts === 1) {
        const timeoutErr = new Error("Model timeout");
        timeoutErr.name = "ModelTimeoutException";
        throw timeoutErr;
      }
      return {
        $metadata: { httpStatusCode: 200, requestId: "aws_req_retry_ok" },
        output: {
          message: {
            role: "assistant",
            content: [{ text: SAMPLE_RESPONSE_TEXT }],
          },
        },
      };
    });

    const adapter = new BedrockIntentAdapter({
      client: mockClient,
      maxRetries: 3,
      sleep: sleepSpy,
      randomSource: () => 0.5,
    });

    const response = await adapter.generateIntent({ text: "Hello" });
    expect(response.rawText).toBe(SAMPLE_RESPONSE_TEXT);
    expect(attempts).toBe(2);
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    // Base delay 100ms * 2^0 + jitter (0.5 * 100 = 50ms) = 150ms
    expect(sleepSpy).toHaveBeenCalledWith(150);
  });

  it("retries transient throttling (rate limit) errors and maps to PROVIDER_RATE_LIMITED on exhaustion", async () => {
    const sleepSpy = vi.fn().mockResolvedValue(undefined);
    let attempts = 0;

    const mockClient = createMockClient(async () => {
      attempts += 1;
      const throttleErr = new Error("Too many requests");
      throttleErr.name = "ThrottlingException";
      throw throttleErr;
    });

    const adapter = new BedrockIntentAdapter({
      client: mockClient,
      maxRetries: 2,
      sleep: sleepSpy,
      randomSource: () => 0.0,
    });

    await expect(adapter.generateIntent({ text: "Hello" })).rejects.toThrowError(DomainError);

    expect(attempts).toBe(3); // 1 initial + 2 retries
    expect(sleepSpy).toHaveBeenCalledTimes(2);

    try {
      attempts = 0;
      await adapter.generateIntent({ text: "Hello" });
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("PROVIDER_RATE_LIMITED");
      expect((err as DomainError).isRetryable).toBe(true);
    }
  });

  it("retries transient 500 / 503 internal server errors and maps to BEDROCK_UNAVAILABLE", async () => {
    const sleepSpy = vi.fn().mockResolvedValue(undefined);
    let attempts = 0;

    const mockClient = createMockClient(async () => {
      attempts += 1;
      const serverErr = new Error("Internal Server Error");
      serverErr.name = "InternalServerException";
      (serverErr as unknown as { $metadata: { httpStatusCode: number } }).$metadata = {
        httpStatusCode: 500,
      };
      throw serverErr;
    });

    const adapter = new BedrockIntentAdapter({
      client: mockClient,
      maxRetries: 1,
      sleep: sleepSpy,
    });

    await expect(adapter.generateIntent({ text: "Hello" })).rejects.toThrowError(DomainError);
    expect(attempts).toBe(2); // 1 initial + 1 retry

    try {
      attempts = 0;
      await adapter.generateIntent({ text: "Hello" });
    } catch (err) {
      expect((err as DomainError).code).toBe("BEDROCK_UNAVAILABLE");
    }
  });

  it("fails immediately on non-transient ValidationException without retrying", async () => {
    const sleepSpy = vi.fn().mockResolvedValue(undefined);
    let attempts = 0;

    const mockClient = createMockClient(async () => {
      attempts += 1;
      const valErr = new Error("Invalid request parameter");
      valErr.name = "ValidationException";
      throw valErr;
    });

    const adapter = new BedrockIntentAdapter({
      client: mockClient,
      maxRetries: 3,
      sleep: sleepSpy,
    });

    await expect(adapter.generateIntent({ text: "Hello" })).rejects.toThrowError(DomainError);

    // Crucial: Must NOT retry non-transient validation failure!
    expect(attempts).toBe(1);
    expect(sleepSpy).not.toHaveBeenCalled();

    try {
      attempts = 0;
      await adapter.generateIntent({ text: "Hello" });
    } catch (err) {
      expect((err as DomainError).code).toBe("INVALID_INPUT");
      expect((err as DomainError).isRetryable).toBe(false);
    }
  });

  it("fails immediately on non-transient AccessDeniedException without retrying", async () => {
    let attempts = 0;

    const mockClient = createMockClient(async () => {
      attempts += 1;
      const accessErr = new Error("Access denied");
      accessErr.name = "AccessDeniedException";
      throw accessErr;
    });

    const adapter = new BedrockIntentAdapter({
      client: mockClient,
      maxRetries: 3,
    });

    await expect(adapter.generateIntent({ text: "Hello" })).rejects.toThrowError(DomainError);
    expect(attempts).toBe(1);

    try {
      attempts = 0;
      await adapter.generateIntent({ text: "Hello" });
    } catch (err) {
      expect((err as DomainError).code).toBe("POLICY_DENIED");
      expect((err as DomainError).isRetryable).toBe(false);
    }
  });

  it("never silently switches to fabricated results when Bedrock fails", async () => {
    const mockClient = createMockClient(async () => {
      throw new Error("Fatal network connection breakdown");
    });

    const adapter = new BedrockIntentAdapter({
      client: mockClient,
      maxRetries: 0,
    });

    // Rejection is guaranteed; no fallback fake object is returned
    await expect(adapter.generateIntent({ text: "Hello" })).rejects.toThrowError(DomainError);
  });

  it("classifyBedrockError handles standard AWS error properties", () => {
    expect(classifyBedrockError({ name: "ThrottlingException" }).code).toBe(
      "PROVIDER_RATE_LIMITED",
    );
    expect(classifyBedrockError({ $metadata: { httpStatusCode: 429 } }).code).toBe(
      "PROVIDER_RATE_LIMITED",
    );
    expect(classifyBedrockError({ name: "ModelTimeoutException" }).code).toBe("PROVIDER_TIMEOUT");
    expect(classifyBedrockError({ name: "TimeoutError" }).code).toBe("PROVIDER_TIMEOUT");
    expect(classifyBedrockError({ name: "InternalServerException" }).code).toBe(
      "BEDROCK_UNAVAILABLE",
    );
    expect(classifyBedrockError({ $metadata: { httpStatusCode: 503 } }).code).toBe(
      "BEDROCK_UNAVAILABLE",
    );
    expect(classifyBedrockError({ name: "ValidationException" }).code).toBe("INVALID_INPUT");
    expect(classifyBedrockError({ name: "AccessDeniedException" }).code).toBe("POLICY_DENIED");
  });
});

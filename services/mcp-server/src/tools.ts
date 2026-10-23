import { randomUUID } from "node:crypto";
import { DomainError, isDomainError, type OrchestraService } from "@orchestra/domain";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/, "Use letters, digits, and _ . : - only.");
const optionalCorrelation = id.optional().describe("Trace ID; generated when omitted.");

const outputShape = {
  success: z
    .boolean()
    .describe(
      "Whether the tool operation itself completed. Not whether a commitment is fulfilled.",
    ),
  requestId: z.string(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  warnings: z.array(z.string()).optional(),
};

export interface ToolLogEntry {
  readonly timestamp: string;
  readonly level: "info" | "warn" | "error";
  readonly serviceName: "orchestra-mcp";
  readonly environment: "simulator";
  readonly eventName: "mcpToolCallStarted" | "mcpToolCallCompleted" | "mcpToolCallFailed";
  readonly requestId: string;
  readonly correlationId: string;
  readonly toolName: string;
  readonly durationMs?: number;
  readonly result?: "success" | "failure";
  readonly errorCode?: string;
}

/**
 * Registers the ORCHESTRA tools. Every handler calls the domain service; none
 * returns a canned result. Failures are sanitized to a stable code and a safe
 * message (no stack traces, no payloads); tool inputs are never logged.
 */
export function registerTools(
  server: McpServer,
  service: OrchestraService,
  log: (entry: ToolLogEntry) => void,
): void {
  function tool<Shape extends z.ZodRawShape>(
    name: string,
    title: string,
    description: string,
    inputSchema: Shape,
    run: (
      args: z.objectOutputType<Shape, z.ZodTypeAny>,
      correlationId: string,
    ) => unknown | Promise<unknown>,
  ): void {
    server.registerTool(
      name,
      { title, description, inputSchema, outputSchema: outputShape },
      (async (args: unknown): Promise<CallToolResult> => {
        const requestId = `req_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        const supplied = (args as { correlationId?: string }).correlationId;
        const correlationId = supplied ?? `corr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        const started = Date.now();
        const base = {
          serviceName: "orchestra-mcp",
          environment: "simulator",
          requestId,
          correlationId,
          toolName: name,
        } as const;
        log({
          ...base,
          timestamp: new Date().toISOString(),
          level: "info",
          eventName: "mcpToolCallStarted",
        });
        try {
          const data = await run(args as z.objectOutputType<Shape, z.ZodTypeAny>, correlationId);
          const structuredContent = { success: true, requestId, data };
          log({
            ...base,
            timestamp: new Date().toISOString(),
            level: "info",
            eventName: "mcpToolCallCompleted",
            durationMs: Date.now() - started,
            result: "success",
          });
          return {
            content: [{ type: "text", text: JSON.stringify(structuredContent) }],
            structuredContent,
          };
        } catch (error) {
          const code = isDomainError(error) ? error.code : "INTERNAL_ERROR";
          const message = isDomainError(error)
            ? (error.userMessage ?? "The request could not be completed.")
            : "The request could not be completed.";
          const structuredContent = { success: false, requestId, error: { code, message } };
          log({
            ...base,
            timestamp: new Date().toISOString(),
            level: isDomainError(error) ? "warn" : "error",
            eventName: "mcpToolCallFailed",
            durationMs: Date.now() - started,
            result: "failure",
            errorCode: code,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(structuredContent) }],
            structuredContent,
            isError: true,
          };
        }
      }) as never,
    );
  }

  tool(
    "createCommitment",
    "Create commitments and a plan",
    "Creates commitments, actions and rules and stores them as plan version 1 with its schedule and verification. Give `text` (interpreted by Amazon Bedrock, needs configuration) or `scenario: demoReport` (the built-in simulator scenario). Nothing is executed.",
    {
      text: z.string().min(1).max(4000).optional(),
      scenario: z.enum(["demoReport"]).optional(),
      recipient: z.string().min(3).max(254).includes("@").optional(),
      correlationId: optionalCorrelation,
    },
    async (args, correlationId) => {
      if ((args.text === undefined) === (args.scenario === undefined)) {
        throw new DomainError({
          code: "INVALID_INPUT",
          userMessage: "Give exactly one of text or scenario.",
        });
      }
      return args.text !== undefined
        ? service.createFromText(args.text, correlationId)
        : service.createDemoScenario(correlationId, args.recipient);
    },
  );

  tool(
    "getCommitmentStatus",
    "Get a commitment's evidence-based status",
    "Recomputes the commitment's status from recorded evidence and action state, stores a legal change, and returns the status with its basis. A succeeded tool call alone does not make a commitment fulfilled.",
    { planId: id, commitmentId: id, correlationId: optionalCorrelation },
    (args) => service.getCommitmentStatus(args.planId, args.commitmentId),
  );

  tool(
    "buildExecutionPlan",
    "Compute schedule and risk",
    "Recomputes the deterministic schedule (with protected-window repair) and per-action risk for the current plan version. It is a heuristic, not a proven optimum. Read-only.",
    { planId: id, correlationId: optionalCorrelation },
    (args) => service.evaluatePlan(args.planId),
  );

  tool(
    "verifyExecutionPlan",
    "Verify a plan independently",
    "Runs the deterministic verifier over the current plan version and returns every violation, hard or soft. A plan with a hard violation cannot execute. Read-only.",
    { planId: id, correlationId: optionalCorrelation },
    (args) => {
      const evaluated = service.evaluatePlan(args.planId);
      return {
        planId: evaluated.planId,
        planVersion: evaluated.planVersion,
        environment: evaluated.environment,
        verification: evaluated.verification,
      };
    },
  );

  tool(
    "requestActionApproval",
    "Request or record an approval",
    "Without `decision`: marks the action as awaiting approval and returns the exact payload, its hash and the plan version an approval would be bound to. With `decision`: records the approval or rejection as the authenticated user. An approval is bound to that payload and plan version and is void if either changes.",
    {
      planId: id,
      actionId: id,
      decision: z.enum(["approved", "rejected"]).optional(),
      correlationId: optionalCorrelation,
    },
    (args, correlationId) =>
      service.requestApproval({
        planId: args.planId,
        actionId: args.actionId,
        decision: args.decision,
        correlationId,
      }),
  );

  tool(
    "executeApprovedAction",
    "Execute an action through the gate",
    "Runs one action through the execution gate (approval, dependencies, protected windows, plan version, idempotency) and, if allowed, the simulator adapter. No email or calendar anywhere is touched; results are labelled simulator. Denials return a typed error and no side effect happens.",
    { planId: id, actionId: id, correlationId: optionalCorrelation },
    (args, correlationId) =>
      service.executeAction({ planId: args.planId, actionId: args.actionId, correlationId }),
  );

  tool(
    "getExecutionTimeline",
    "Get the execution timeline",
    "Returns plan versions, action state transitions, schedule revisions, evidence and external events for a plan, oldest first (at most 500 entries). Optionally filtered by correlation ID.",
    { planId: id, correlationId: optionalCorrelation },
    (args) =>
      service.getExecutionTimeline(args.planId, (args as { correlationId?: string }).correlationId),
  );

  tool(
    "simulateExternalEvent",
    "Inject a simulator event",
    "Records a simulator event with a server-generated ID; it changes nothing until replanAfterEvent applies it. Types: dependencyDelayed {actionId, delayMinutes}, protectedWindowChanged {invariantId, startAt, endAt}, providerOutcomeReported {actionId, outcome, providerReference}. The environment is always simulator.",
    {
      eventType: z.enum(["dependencyDelayed", "protectedWindowChanged", "providerOutcomeReported"]),
      payload: z.record(z.string(), z.unknown()),
      correlationId: optionalCorrelation,
    },
    (args) =>
      service.simulateExternalEvent({
        eventType: args.eventType,
        payload: args.payload,
        correlationId: (args as { correlationId?: string }).correlationId,
      }),
  );

  tool(
    "replanAfterEvent",
    "Replan after an event",
    "Applies a recorded event once: finds the affected actions, builds and independently verifies candidate plans, stores a new plan version (the old one stays readable) and returns the diff. If no plan satisfies the hard constraints it returns requiresUserDecision with the conflicts; it never bypasses a constraint.",
    {
      planId: id,
      eventId: id,
      expectedPlanVersion: z.number().int().min(1).optional(),
      correlationId: optionalCorrelation,
    },
    (args) =>
      service.replan({
        planId: args.planId,
        eventId: args.eventId,
        expectedPlanVersion: args.expectedPlanVersion,
      }),
  );
}

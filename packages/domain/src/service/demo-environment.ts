import { z } from "zod";
import { AdapterRegistry } from "../execution/adapter-registry.js";
import { SimulatorAdapter } from "../execution/simulator-adapter.js";
import { createToolCatalog, type ToolCatalog } from "../policy/tool-catalog.js";
import type { PlannedAction } from "../schemas/action.js";
import type { Commitment } from "../schemas/commitment.js";
import type { Invariant } from "../schemas/invariant.js";

const EMAIL_INPUT = z
  .object({ recipient: z.string().min(3).includes("@"), documentId: z.string().min(1) })
  .strict();
const DOCUMENT_INPUT = z.object({ documentId: z.string().min(1) }).strict();
const CALENDAR_INPUT = z.object({ calendarId: z.string().min(1) }).strict();

/** Scopes the demo principal holds. */
export const DEMO_SCOPES = ["email:send", "docs:write", "calendar:read"] as const;

/** The tools of the demo, all backed by simulator adapters. */
export function createDemoToolCatalog(): ToolCatalog {
  return createToolCatalog([
    {
      toolName: "sendEmail",
      environment: "simulator",
      category: "externalCommunication",
      riskClass: "high",
      isReversible: false,
      requiredScopes: ["email:send"],
      inputSchema: EMAIL_INPUT,
    },
    {
      toolName: "prepareDocument",
      environment: "simulator",
      category: "write",
      riskClass: "low",
      isReversible: true,
      requiredScopes: ["docs:write"],
      inputSchema: DOCUMENT_INPUT,
    },
    {
      toolName: "readCalendar",
      environment: "simulator",
      category: "read",
      riskClass: "low",
      isReversible: true,
      requiredScopes: ["calendar:read"],
      inputSchema: CALENDAR_INPUT,
    },
  ]);
}

/**
 * Simulator adapters for the demo tools. They are labelled simulators: no email
 * is sent and no calendar is read anywhere. Their results say so.
 */
export function createDemoAdapters(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(
    new SimulatorAdapter({
      toolName: "prepareDocument",
      riskClass: "low",
      inputSchema: DOCUMENT_INPUT,
      outputSchema: z.object({ documentId: z.string(), status: z.literal("prepared") }).strict(),
      defaultOutput: (input) => ({ documentId: input.documentId, status: "prepared" as const }),
    }) as never,
  );
  registry.register(
    new SimulatorAdapter({
      toolName: "sendEmail",
      riskClass: "high",
      inputSchema: EMAIL_INPUT,
      outputSchema: z
        .object({ simulated: z.literal(true), recipient: z.string(), delivered: z.boolean() })
        .strict(),
      defaultOutput: (input) => ({
        simulated: true as const,
        recipient: input.recipient,
        delivered: true,
      }),
    }) as never,
  );
  registry.register(
    new SimulatorAdapter({
      toolName: "readCalendar",
      riskClass: "low",
      inputSchema: CALENDAR_INPUT,
      outputSchema: z.object({ simulated: z.literal(true), calendarId: z.string() }).strict(),
      defaultOutput: (input) => ({ simulated: true as const, calendarId: input.calendarId }),
    }) as never,
  );
  return registry;
}

export interface PlanInput {
  readonly commitments: readonly Commitment[];
  readonly actions: readonly PlannedAction[];
  readonly invariants: readonly Invariant[];
}

const addMinutes = (iso: string, minutes: number): string =>
  new Date(Date.parse(iso) + minutes * 60_000).toISOString();

/**
 * The primary demo scenario, relative to `now`: finalize a report (60 min),
 * send it (needs approval, after finalize), a meeting from now+3h to now+4h
 * during which nothing may be sent, and a deadline at now+7h. Plain data that
 * goes through the same validation and verification as any other input.
 */
export function buildDemoScenarioInput(now: string, recipient = "rahul@example.com"): PlanInput {
  const deadlineAt = addMinutes(now, 7 * 60);
  const common = {
    commitmentIds: ["commitment_report_delivery"],
    preconditionIds: [] as string[],
    earliestStartAt: null,
    deadlineAt,
    createdAt: now,
    updatedAt: now,
    version: 1,
    status: "proposed" as const,
  };
  return {
    commitments: [
      {
        commitmentId: "commitment_report_delivery",
        title: "Deliver the final report",
        desiredOutcome: `${recipient} receives the approved final report before the deadline.`,
        successCriteria: [
          {
            criterionId: "criterion_report_sent",
            description: "The approved report was sent to the recipient (simulated).",
            isMandatory: true,
            verificationMode: "machineCheckable",
            requiredEvidenceTypes: ["simulatorEvent"],
          },
        ],
        deadlineAt,
        priority: "high",
        dependencyIds: [],
        invariantIds: ["invariant_approval", "invariant_meeting", "invariant_deadline"],
        evidenceRequirementIds: [],
        status: "open",
        createdAt: now,
        updatedAt: now,
        version: 1,
      },
    ],
    actions: [
      {
        ...common,
        actionId: "action_finalize_report",
        toolName: "prepareDocument",
        input: { documentId: "doc_final" },
        dependencyActionIds: [],
        estimatedDurationMinutes: 60,
        riskClass: "low",
        requiresApproval: false,
        approvalStatus: "notRequired",
        idempotencyKey: "idem_finalize_report_0001",
      },
      {
        ...common,
        actionId: "action_send_report",
        toolName: "sendEmail",
        input: { recipient, documentId: "doc_final" },
        dependencyActionIds: ["action_finalize_report"],
        estimatedDurationMinutes: 5,
        riskClass: "high",
        requiresApproval: true,
        approvalStatus: "pending",
        idempotencyKey: "idem_send_report_0001",
      },
    ] as PlannedAction[],
    invariants: [
      {
        invariantId: "invariant_approval",
        description: "The report may only be sent after the user approves it.",
        severity: "hard",
        ruleType: "approvalRequired",
        parameters: { actionId: "action_send_report" },
        createdAt: now,
      },
      {
        invariantId: "invariant_meeting",
        description: "Do not send anything during the meeting.",
        severity: "hard",
        ruleType: "protectedTimeWindow",
        parameters: {
          startAt: addMinutes(now, 3 * 60),
          endAt: addMinutes(now, 4 * 60),
          prohibitedToolNames: ["sendEmail"],
        },
        createdAt: now,
      },
      {
        invariantId: "invariant_deadline",
        description: "The report must be delivered before the deadline.",
        severity: "hard",
        ruleType: "deadline",
        parameters: {
          subjectType: "commitment",
          subjectId: "commitment_report_delivery",
          deadlineAt,
        },
        createdAt: now,
      },
    ] as Invariant[],
  };
}

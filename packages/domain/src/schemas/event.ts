import { z } from "zod";
import { ENVIRONMENTS } from "./enums.js";
import {
  boundedTextSchema,
  checkTimestampOrder,
  idSchema,
  isoTimestampSchema,
  nonNegativeIntegerSchema,
} from "./primitives.js";

/** Fields common to every external event. `eventId` is the replay key. */
const eventBaseShape = {
  eventId: idSchema,
  source: boundedTextSchema(100),
  occurredAt: isoTimestampSchema,
  correlationId: idSchema,
  environment: z.enum(ENVIRONMENTS),
} as const;

export const dependencyDelayedEventSchema = z
  .object({
    ...eventBaseShape,
    eventType: z.literal("dependencyDelayed"),
    payload: z
      .object({
        actionId: idSchema,
        delayMinutes: nonNegativeIntegerSchema(525_600).refine(
          (minutes) => minutes >= 1,
          "[OUT_OF_RANGE] delayMinutes must be at least 1.",
        ),
      })
      .strict(),
  })
  .strict();

export const protectedWindowChangedEventSchema = z
  .object({
    ...eventBaseShape,
    eventType: z.literal("protectedWindowChanged"),
    payload: z
      .object({
        invariantId: idSchema,
        startAt: isoTimestampSchema,
        endAt: isoTimestampSchema,
      })
      .strict()
      .superRefine((payload, ctx) => {
        checkTimestampOrder(
          ctx,
          payload.startAt,
          payload.endAt,
          ["endAt"],
          "endAt must be after startAt.",
          true,
        );
      }),
  })
  .strict();

export const providerOutcomeReportedEventSchema = z
  .object({
    ...eventBaseShape,
    eventType: z.literal("providerOutcomeReported"),
    payload: z
      .object({
        actionId: idSchema,
        outcome: z.enum(["succeeded", "failed"]),
        providerReference: boundedTextSchema(200).nullable(),
      })
      .strict(),
  })
  .strict();

/** Initial closed set of event types; the replanning phase may extend it. */
export const externalEventSchema = z.discriminatedUnion("eventType", [
  dependencyDelayedEventSchema,
  protectedWindowChangedEventSchema,
  providerOutcomeReportedEventSchema,
]);

export type ExternalEvent = z.infer<typeof externalEventSchema>;

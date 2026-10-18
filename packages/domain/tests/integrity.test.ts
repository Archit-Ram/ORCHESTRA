import { describe, expect, it } from "vitest";
import { plannedActionSchema } from "../src/schemas/action.js";
import { commitmentSchema } from "../src/schemas/commitment.js";
import { checkReferentialIntegrity } from "../src/schemas/integrity.js";
import { invariantSchema } from "../src/schemas/invariant.js";
import {
  validAction,
  validCommitment,
  validFinalizeAction,
  validInvariant,
} from "./helpers/fixtures.js";

const commitment = commitmentSchema.parse(validCommitment());
const invariant = invariantSchema.parse(validInvariant());
const sendAction = plannedActionSchema.parse(validAction());
const finalizeAction = plannedActionSchema.parse(validFinalizeAction());

function summarize(issues: ReturnType<typeof checkReferentialIntegrity>): string[] {
  return issues.map((issue) => `${issue.path}:${issue.code}`);
}

describe("checkReferentialIntegrity", () => {
  it("returns no issues for a consistent set", () => {
    const issues = checkReferentialIntegrity({
      commitments: [commitment],
      invariants: [invariant],
      actions: [finalizeAction, sendAction],
    });
    expect(issues).toEqual([]);
  });

  it("returns no issues for empty input", () => {
    expect(checkReferentialIntegrity({})).toEqual([]);
    expect(checkReferentialIntegrity({ actions: [], commitments: [], invariants: [] })).toEqual([]);
  });

  it("reports duplicate IDs in every collection", () => {
    const issues = summarize(
      checkReferentialIntegrity({
        commitments: [commitment, commitment],
        invariants: [invariant, invariant],
        actions: [finalizeAction, finalizeAction],
      }),
    );
    expect(issues).toContain("commitments[1].commitmentId:DUPLICATE_ID");
    expect(issues).toContain("invariants[1].invariantId:DUPLICATE_ID");
    expect(issues).toContain("actions[1].actionId:DUPLICATE_ID");
  });

  it("reports unresolved action dependencies", () => {
    const issues = summarize(checkReferentialIntegrity({ actions: [sendAction] }));
    expect(issues).toEqual(["actions[0].dependencyActionIds[0]:UNRESOLVED_REFERENCE"]);
  });

  it("reports unresolved commitment, invariant, and dependency references", () => {
    const orphanCommitment = commitmentSchema.parse({
      ...validCommitment(),
      dependencyIds: ["commitment_ghost"],
      invariantIds: ["invariant_ghost"],
    });
    const orphanAction = plannedActionSchema.parse({
      ...validFinalizeAction(),
      commitmentIds: ["commitment_ghost"],
    });
    const issues = summarize(
      checkReferentialIntegrity({
        commitments: [orphanCommitment],
        invariants: [invariant],
        actions: [orphanAction],
      }),
    );
    expect(issues).toContain("commitments[0].dependencyIds[0]:UNRESOLVED_REFERENCE");
    expect(issues).toContain("commitments[0].invariantIds[0]:UNRESOLVED_REFERENCE");
    expect(issues).toContain("actions[0].commitmentIds[0]:UNRESOLVED_REFERENCE");
  });

  it("does not check references into collections that were not provided", () => {
    const issues = checkReferentialIntegrity({ commitments: [commitment] });
    expect(issues).toEqual([]);
    expect(checkReferentialIntegrity({ actions: [finalizeAction] })).toEqual([]);
  });

  it("treats a provided but empty collection as having no records", () => {
    const issues = summarize(
      checkReferentialIntegrity({ commitments: [], actions: [finalizeAction] }),
    );
    expect(issues).toEqual(["actions[0].commitmentIds[0]:UNRESOLVED_REFERENCE"]);
  });
});

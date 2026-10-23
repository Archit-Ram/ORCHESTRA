/**
 * @module @orchestra/domain
 *
 * Core domain types, schemas, algorithms, and business logic for ORCHESTRA.
 * This package contains no external service dependencies.
 */

/** Package identifier used in structured logs. */
export const DOMAIN_PACKAGE = "@orchestra/domain" as const;

export * from "./errors/index.js";
export * from "./schemas/index.js";
export * from "./graph/index.js";
export * from "./scheduler/index.js";
export * from "./policy/index.js";
export * from "./verifier/index.js";
export * from "./persistence/index.js";
export * from "./execution/index.js";
export * from "./intent/index.js";
export * from "./replanning/index.js";

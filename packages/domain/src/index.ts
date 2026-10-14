/**
 * @module @orchestra/domain
 *
 * Core domain types, schemas, algorithms, and business logic for ORCHESTRA.
 * This package contains no external service dependencies.
 *
 * Modules will be added in subsequent implementation phases:
 * - Prompt 2: schemas, typed errors
 * - Prompt 3: commitment graph
 * - Prompt 4: scheduler, risk engine
 * - Prompt 5: verifier, policy engine
 */

/** Package identifier used in structured logs. */
export const DOMAIN_PACKAGE = "@orchestra/domain" as const;

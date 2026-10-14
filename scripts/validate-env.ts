/**
 * Environment variable validation for ORCHESTRA.
 *
 * Validates that required configuration is present and well-formed.
 * Does NOT validate secrets — only checks that expected names exist
 * and values conform to allowed sets where applicable.
 *
 * Run: pnpm validate:env
 */

interface EnvVarSpec {
  name: string;
  required: boolean;
  description: string;
  allowedValues?: readonly string[];
  defaultValue?: string;
}

const ENV_SPECS: readonly EnvVarSpec[] = [
  {
    name: "NODE_ENV",
    required: false,
    description: "Runtime environment",
    allowedValues: ["development", "production", "test"],
    defaultValue: "development",
  },
  {
    name: "ORCHESTRA_ENVIRONMENT",
    required: false,
    description: "Execution environment: simulator or live",
    allowedValues: ["simulator", "live"],
    defaultValue: "simulator",
  },
  {
    name: "API_PORT",
    required: false,
    description: "HTTP API server port",
    defaultValue: "3001",
  },
  {
    name: "MCP_PORT",
    required: false,
    description: "MCP server port",
    defaultValue: "3002",
  },
  {
    name: "AWS_REGION",
    required: false,
    description: "AWS region for Bedrock calls",
  },
  {
    name: "BEDROCK_MODEL_ID",
    required: false,
    description: "Amazon Bedrock model identifier",
  },
  {
    name: "BEDROCK_REQUEST_TIMEOUT_MS",
    required: false,
    description: "Bedrock request timeout in milliseconds",
    defaultValue: "30000",
  },
  {
    name: "BEDROCK_MAX_RETRIES",
    required: false,
    description: "Maximum retry count for transient Bedrock errors",
    defaultValue: "3",
  },
  {
    name: "LOG_LEVEL",
    required: false,
    description: "Structured log level",
    allowedValues: ["debug", "info", "warn", "error", "fatal"],
    defaultValue: "info",
  },
  {
    name: "RISK_THRESHOLD_MINUTES",
    required: false,
    description: "Deadline slack threshold for at-risk classification",
    defaultValue: "30",
  },
  {
    name: "USER_TIMEZONE",
    required: false,
    description: "IANA timezone for user-facing time display",
    defaultValue: "America/Los_Angeles",
  },
] as const;

interface ValidationIssue {
  name: string;
  severity: "error" | "warning";
  message: string;
}

function validateEnvironment(): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const spec of ENV_SPECS) {
    const value = process.env[spec.name];

    if (value === undefined || value === "") {
      if (spec.required) {
        issues.push({
          name: spec.name,
          severity: "error",
          message: `Required environment variable ${spec.name} is not set. ${spec.description}`,
        });
      } else if (spec.defaultValue === undefined) {
        issues.push({
          name: spec.name,
          severity: "warning",
          message: `Optional variable ${spec.name} is not set and has no default. ${spec.description}`,
        });
      }
      continue;
    }

    if (spec.allowedValues && !spec.allowedValues.includes(value)) {
      issues.push({
        name: spec.name,
        severity: "error",
        message: `${spec.name}="${value}" is not in allowed values: [${spec.allowedValues.join(", ")}]`,
      });
    }
  }

  return issues;
}

/* --- CLI entrypoint --- */
const issues = validateEnvironment();
const errors = issues.filter((i) => i.severity === "error");
const warnings = issues.filter((i) => i.severity === "warning");

console.log("ORCHESTRA Environment Validation");
console.log("================================\n");

if (warnings.length > 0) {
  console.log(`⚠  ${warnings.length} warning(s):`);
  for (const w of warnings) {
    console.log(`   ${w.name}: ${w.message}`);
  }
  console.log();
}

if (errors.length > 0) {
  console.log(`✗  ${errors.length} error(s):`);
  for (const e of errors) {
    console.log(`   ${e.name}: ${e.message}`);
  }
  console.log();
  process.exit(1);
} else {
  console.log(`✓  No required-variable errors. ${warnings.length} warning(s).`);
  process.exit(0);
}

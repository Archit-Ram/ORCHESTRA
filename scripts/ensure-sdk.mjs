// Makes sure the MCP SDK is a pinned dependency of services/mcp-server.
// Only does anything the first time (it runs `pnpm add -E`, which pins the exact
// version and updates pnpm-lock.yaml); after you commit that, it is a no-op.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageJson = fileURLToPath(new URL("../services/mcp-server/package.json", import.meta.url));
const manifest = JSON.parse(readFileSync(packageJson, "utf8"));

if (manifest.dependencies?.["@modelcontextprotocol/sdk"] !== undefined) {
  process.exit(0);
}

process.stdout.write("Adding the pinned MCP SDK (one time only)...\n");
const result = spawnSync(
  "pnpm",
  ["--filter", "@orchestra/mcp-server", "add", "-E", "@modelcontextprotocol/sdk"],
  { stdio: "inherit", shell: process.platform === "win32" },
);
if (result.status !== 0) {
  process.stderr.write(
    "Could not add @modelcontextprotocol/sdk. Check your network and run:\n" +
      "  pnpm --filter @orchestra/mcp-server add -E @modelcontextprotocol/sdk\n",
  );
  process.exit(1);
}
process.stdout.write(
  "Done. Commit services/mcp-server/package.json and pnpm-lock.yaml so others do not need this step.\n",
);

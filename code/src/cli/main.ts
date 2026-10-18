#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { dispatchInput, routeInput } from "./input-router.js";
import { renderDispatchResult, renderError, renderStartup, renderVersion } from "./renderer.js";

async function main(): Promise<void> {
  if (process.argv.slice(2).some((arg) => arg === "--version" || arg === "-v")) {
    output.write(`${renderVersion()}\n`);
    return;
  }
  const { AgentKernel } = await import("../kernel/agent-kernel.js");
  const codeRoot = fileURLToPath(new URL("../..", import.meta.url));
  const kernel = await AgentKernel.start({ workspaceRoot: resolve(codeRoot, ".."), configRoot: codeRoot });
  output.write(`${renderStartup(kernel.session.id)}\n`);

  const readline = createInterface({ input, output, prompt: "figo-agent> " });
  readline.prompt();

  for await (const line of readline) {
    try {
      const result = await dispatchInput(routeInput(line), kernel);
      const text = renderDispatchResult(result);
      if (text) output.write(`${text}\n`);
      if (result.exit) {
        readline.close();
        break;
      }
    } catch (error) {
      output.write(`${renderError(error)}\n`);
    }
    readline.prompt();
  }
}

main().catch((error) => {
  output.write(`${renderError(error)}\n`);
  process.exitCode = 1;
});

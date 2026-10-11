#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { AgentKernel } from "../kernel/agent-kernel.js";
import { dispatchInput, routeInput } from "./input-router.js";
import { renderDispatchResult, renderError, renderStartup } from "./renderer.js";

async function main(): Promise<void> {
  const kernel = await AgentKernel.start({ workspaceRoot: process.cwd() });
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

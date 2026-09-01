import { readStdinJson, processHookEvent } from "./guard.js";
import { loadConfig } from "./config.js";

/** Entry point used by the `kguard hook <event>` CLI command. */
export async function runHook(event: string): Promise<number> {
  const payload = await readStdinJson();
  let outcome;
  try {
    outcome = processHookEvent(event, loadConfig(), payload);
  } catch (err) {
    process.stderr.write(`[kimi-guard] guard error (fail-open): ${(err as Error).message}\n`);
    return 0;
  }
  if (outcome.stdout) process.stdout.write(outcome.stdout + "\n");
  if (outcome.stderr) process.stderr.write(outcome.stderr + "\n");
  return outcome.code;
}

export { readStdinJson };

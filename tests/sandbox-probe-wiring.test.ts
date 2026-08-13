import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("Sandbox reachability probing does not depend on optional socket tools", () => {
  const sandbox = source("lib/runner/sandbox.ts");

  assert.doesNotMatch(sandbox, /\bss -ltnH\b/);
  assert.doesNotMatch(sandbox, /\bnetstat -ltn\b/);
  assert.match(sandbox, /\/dev\/tcp\/127\.0\.0\.1/);
  assert.match(sandbox, /orderedProbePorts\(exposedPorts, preferredPort\)/);
  assert.match(sandbox, /sandbox\.domain\(port\)/);
});

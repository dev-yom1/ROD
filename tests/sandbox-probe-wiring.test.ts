import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("Sandbox reachability probing discovers listeners without optional socket tools", () => {
  const sandbox = source("lib/runner/sandbox.ts");

  assert.doesNotMatch(sandbox, /\bss -ltnH\b/);
  assert.doesNotMatch(sandbox, /\bnetstat -ltn\b/);
  assert.match(sandbox, /\/proc\/net\/tcp/);
  assert.match(sandbox, /\/proc\/net\/tcp6/);
  assert.match(sandbox, /\/dev\/tcp\/127\.0\.0\.1/);
  assert.match(sandbox, /extractPortsFromStartCommand\(startCommand\)/);
  assert.match(sandbox, /baselinePorts: Set<number>/);
  assert.match(sandbox, /filter\(\(port\) => !baselinePorts\.has\(port\)\)/);
  assert.match(sandbox, /const baseline = await readListeningPorts\(sandbox\)/);
  assert.match(sandbox, /sandbox\.domain\(port\)/);
});

test("Sandbox start-command port hints include CLI and PORT forms", () => {
  const sandbox = source("lib/runner/sandbox.ts");

  assert.match(sandbox, /--port/);
  assert.match(sandbox, /PORT=/);
  assert.match(sandbox, /\(\?:\^\|\\s\)-p\\s\+/);
});

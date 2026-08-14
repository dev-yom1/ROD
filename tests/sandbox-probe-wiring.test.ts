import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { extractPortsFromStartCommand } from "../lib/runner/sandbox";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("Sandbox reachability probing uses proc socket identity without optional socket tools", () => {
  const sandbox = source("lib/runner/sandbox.ts");

  assert.doesNotMatch(sandbox, /\bss -ltnH\b/);
  assert.doesNotMatch(sandbox, /\bnetstat -ltn\b/);
  assert.match(sandbox, /\/proc\/net\/tcp/);
  assert.match(sandbox, /\/proc\/net\/tcp6/);
  assert.match(sandbox, /hasNewListener/);
  assert.match(sandbox, /readStartExitCode/);
  assert.match(sandbox, /\/dev\/tcp\/127\.0\.0\.1/);
  assert.match(sandbox, /sandbox\.domain\(port\)/);
  assert.match(sandbox, /sandbox\.stop\(\)\.catch/);
});

test("Sandbox start-command port hints share the README command grammar", () => {
  assert.deepEqual(extractPortsFromStartCommand("npm run dev -- --port 4000"), [4000]);
  assert.deepEqual(extractPortsFromStartCommand("npm run dev -p 4200"), [4200]);
  assert.deepEqual(extractPortsFromStartCommand("PORT=8888 npm run dev"), [8888]);
});

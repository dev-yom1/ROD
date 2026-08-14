import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { extractReadmePlan } from "../lib/analyzer/readme";

test("ROD README includes setup before development and excludes later checks fence", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const plan = extractReadmePlan(readme);

  assert.deepEqual(plan.commands, [
    "cp .env.example .env.local",
    "npm install",
    "npm run dev",
  ]);
  assert.equal(plan.startCommand, "npm run dev");
  assert.equal(plan.expectedPort, 3000);
  assert(!plan.commands.includes("npm test"));
  assert(!plan.commands.includes("npm run typecheck"));
  assert(!plan.commands.includes("npm run build"));
});

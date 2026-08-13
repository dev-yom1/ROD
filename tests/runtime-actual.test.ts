import assert from "node:assert/strict";
import test from "node:test";
import {
  nodeReadmeRequirementFitsRepo,
  pythonReadmeRequirementFitsRepo,
  selectNodeSandboxRuntime,
} from "../lib/analyzer/runtime";

test("major runtime selection remains a candidate that exact Node version must satisfy", () => {
  assert.equal(selectNodeSandboxRuntime("22.x"), "node22");
  assert.equal(selectNodeSandboxRuntime(">=22 <23"), "node22");

  const narrow = ">=22.0.0 <22.1.0";
  assert.equal(selectNodeSandboxRuntime(narrow), "node22");
  assert.equal(nodeReadmeRequirementFitsRepo(narrow, "22.0.5"), true);
  assert.equal(nodeReadmeRequirementFitsRepo(narrow, "22.15.0"), false);

  assert.equal(selectNodeSandboxRuntime("=22.0.0"), "node22");
  assert.equal(nodeReadmeRequirementFitsRepo("=22.0.0", "22.0.0"), true);
  assert.equal(nodeReadmeRequirementFitsRepo("=22.0.0", "22.0.1"), false);
});

test("actual Python patch version must satisfy a narrow repository constraint", () => {
  const narrow = ">=3.13.0 <3.13.1";
  assert.equal(pythonReadmeRequirementFitsRepo(narrow, "3.13.0"), true);
  assert.equal(pythonReadmeRequirementFitsRepo(narrow, "3.13.7"), false);
});

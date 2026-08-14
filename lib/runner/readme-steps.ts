import { isSafeOnboardingCommand } from "../analyzer/readme";
import type { ReadmePlan } from "../analyzer/types";

export type ReadmeStep = {
  kind: "preparation" | "install" | "start" | "skipped";
  command: string;
};

function isPreparation(command: string): boolean {
  return /^(?:cp|copy|mkdir|touch)\s+/i.test(command);
}

export function buildReadmeSteps(plan: ReadmePlan): ReadmeStep[] {
  const steps: ReadmeStep[] = [];
  let afterStart = false;

  for (const command of plan.commands) {
    if (afterStart) {
      steps.push({ kind: "skipped", command });
      continue;
    }

    if (command === plan.startCommand) {
      steps.push({ kind: isSafeOnboardingCommand(command) ? "start" : "skipped", command });
      afterStart = true;
      continue;
    }

    if (command === plan.installCommand) {
      steps.push({ kind: isSafeOnboardingCommand(command) ? "install" : "skipped", command });
      continue;
    }

    if (isPreparation(command) && isSafeOnboardingCommand(command)) {
      steps.push({ kind: "preparation", command });
      continue;
    }

    steps.push({ kind: "skipped", command });
  }

  return steps;
}

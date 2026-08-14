import { isSafeOnboardingCommand } from "../analyzer/readme";
import type { ReadmePlan } from "../analyzer/types";

export type OrderedReadmeStep = {
  role: "preparation" | "install" | "start" | "skipped";
  command: string;
};

function isPreparation(command: string): boolean {
  return /^(?:cp|copy|mkdir|touch)\s+/i.test(command);
}

export function orderedReadmeSteps(plan: ReadmePlan): OrderedReadmeStep[] {
  const result: OrderedReadmeStep[] = [];
  let phase: "preparation" | "install" | "start" = "preparation";

  for (const command of plan.commands) {
    if (phase === "start") {
      result.push({ role: "skipped", command });
      continue;
    }

    if (command === plan.startCommand) {
      result.push({ role: isSafeOnboardingCommand(command) ? "start" : "skipped", command });
      phase = "start";
      continue;
    }

    if (command === plan.installCommand) {
      result.push({ role: isSafeOnboardingCommand(command) ? "install" : "skipped", command });
      phase = "install";
      continue;
    }

    if (isPreparation(command)) {
      const inPlace = phase === "preparation" && isSafeOnboardingCommand(command);
      result.push({ role: inPlace ? "preparation" : "skipped", command });
      continue;
    }

    result.push({ role: "skipped", command });
  }

  return result;
}

export function runnerReadmePlan(plan: ReadmePlan): ReadmePlan {
  const steps = orderedReadmeSteps(plan);
  const commands = steps.filter((step) => step.role !== "skipped").map((step) => step.command);
  const installCommand = steps.some((step) => step.role === "install") ? plan.installCommand : null;
  const startCommand = steps.some((step) => step.role === "start") ? plan.startCommand : null;

  return {
    ...plan,
    commands,
    installCommand,
    startCommand,
  };
}

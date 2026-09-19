import type { MachineDefinition } from './machine';
import type { ProcedureContent } from './procedure';

export type ProcedureIssue = { path: string; message: string };
export type LinkTargets = Record<string /* procedureSlug */, string[] /* step ids */>;

/** Reference checks that Zod cannot express. Returns [] when valid. Does not throw. */
export function validateProcedure(
  content: ProcedureContent,
  machine: MachineDefinition,
  linkTargets?: LinkTargets,
): ProcedureIssue[] {
  const issues: ProcedureIssue[] = [];
  const stateVarNames = new Set(machine.stateVars.map((stateVar) => stateVar.name));
  for (const name of stateVarNames) {
    if (!Object.hasOwn(content.start, name)) {
      issues.push({
        path: `start.${name}`,
        message: `Missing initial state for "${name}".`,
      });
    }
  }
  for (const name of Object.keys(content.start)) {
    if (!stateVarNames.has(name)) {
      issues.push({
        path: `start.${name}`,
        message: `Unknown state variable "${name}".`,
      });
    }
  }

  if (content.steps.length === 0) {
    issues.push({ path: 'steps', message: 'At least one step is required.' });
  }

  const partNames = new Set(machine.parts.map((part) => part.name));
  const stepIds = new Set<string>();
  content.steps.forEach((step, stepIndex) => {
    const stepPath = `steps[${stepIndex}]`;
    if (stepIds.has(step.id)) {
      issues.push({
        path: `${stepPath}.id`,
        message: `Duplicate step id "${step.id}".`,
      });
    }
    stepIds.add(step.id);

    step.parts.forEach((name, partIndex) => {
      if (!partNames.has(name)) {
        issues.push({
          path: `${stepPath}.parts[${partIndex}]`,
          message: `Unknown part "${name}".`,
        });
      }
    });

    for (const name of Object.keys(step.state ?? {})) {
      if (!stateVarNames.has(name)) {
        issues.push({
          path: `${stepPath}.state.${name}`,
          message: `Unknown state variable "${name}".`,
        });
      }
    }

    const link = step.link;
    if (linkTargets !== undefined && link !== undefined) {
      if (!Object.hasOwn(linkTargets, link.procedureSlug)) {
        issues.push({
          path: `${stepPath}.link.procedureSlug`,
          message: `Unknown linked procedure "${link.procedureSlug}".`,
        });
      } else if (
        link.stepId !== undefined &&
        !linkTargets[link.procedureSlug].includes(link.stepId)
      ) {
        issues.push({
          path: `${stepPath}.link.stepId`,
          message: `Unknown step "${link.stepId}" in procedure "${link.procedureSlug}".`,
        });
      }
    }
  });

  return issues;
}

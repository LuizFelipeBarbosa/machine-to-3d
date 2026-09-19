import type { MachineDefinition, MachineState, StateVar } from './machine';
import type { ProcedureContent } from './procedure';

export type ProcedureIssue = { path: string; message: string };
export type LinkTargets = Record<string /* procedureSlug */, string[] /* step ids */>;

function validateState(
  state: MachineState,
  stateVars: Map<string, StateVar>,
  path: string,
): ProcedureIssue[] {
  const issues: ProcedureIssue[] = [];
  for (const [name, value] of Object.entries(state)) {
    const variable = stateVars.get(name);
    if (!variable) {
      issues.push({ path: `${path}.${name}`, message: `Unknown state variable "${name}".` });
      continue;
    }

    const valid = variable.kind === 'toggle'
      ? typeof value === 'boolean'
      : typeof value === 'number' && value >= 0 && value <= 1;
    if (!valid) {
      const expected = variable.kind === 'toggle' ? 'a boolean' : 'a number in [0, 1]';
      issues.push({
        path: `${path}.${name}`,
        message: `State variable "${name}" (${variable.kind}) requires ${expected}; received ${String(value)}.`,
      });
    }
  }
  return issues;
}

/** Reference checks that Zod cannot express. Returns [] when valid. Does not throw. */
export function validateProcedure(
  content: ProcedureContent,
  machine: MachineDefinition,
  linkTargets?: LinkTargets,
): ProcedureIssue[] {
  const issues: ProcedureIssue[] = [];
  const stateVars = new Map(machine.stateVars.map((variable) => [variable.name, variable]));
  for (const name of stateVars.keys()) {
    if (!Object.hasOwn(content.start, name)) {
      issues.push({
        path: `start.${name}`,
        message: `Missing initial state for "${name}".`,
      });
    }
  }
  issues.push(...validateState(content.start, stateVars, 'start'));

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

    issues.push(...validateState(step.state ?? {}, stateVars, `${stepPath}.state`));

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

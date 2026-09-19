import { foldState } from '../../shared/foldState';
import type { MachineState, View } from '../../shared/machine';
import type { ProcedureContent, Step } from '../../shared/procedure';

function replaceStep(
  content: ProcedureContent,
  stepId: string,
  updater: (step: Step) => Step,
): ProcedureContent {
  const index = stepIndex(content, stepId);
  if (index < 0) return content;

  const steps = [...content.steps];
  steps[index] = updater(steps[index]);
  return { ...content, steps };
}

export function newStepId(existing: Step[]): string {
  const ids = new Set(existing.map((step) => step.id));
  while (true) {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const id = `step-${hex}`;
    if (!ids.has(id)) return id;
  }
}

export function blankStep(id: string, view: View): Step {
  return {
    id,
    title: 'New step',
    where: 'instrument',
    body: '',
    parts: [],
    view: { pos: [...view.pos], target: [...view.target] },
  };
}

export function addStepAfter(
  content: ProcedureContent,
  afterId: string | null,
  view: View,
): { content: ProcedureContent; stepId: string } {
  const stepId = newStepId(content.steps);
  const afterIndex = afterId === null ? -1 : stepIndex(content, afterId);
  // A stale insertion target, like null, appends the new step.
  const insertIndex = afterIndex < 0 ? content.steps.length : afterIndex + 1;
  const steps = [...content.steps];
  steps.splice(insertIndex, 0, blankStep(stepId, view));
  return { content: { ...content, steps }, stepId };
}

export function removeStep(content: ProcedureContent, stepId: string): ProcedureContent {
  if (content.steps.length <= 1 || stepIndex(content, stepId) < 0) return content;

  return { ...content, steps: content.steps.filter((step) => step.id !== stepId) };
}

export function moveStep(
  content: ProcedureContent,
  stepId: string,
  direction: -1 | 1,
): ProcedureContent {
  const index = stepIndex(content, stepId);
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= content.steps.length) return content;

  const steps = [...content.steps];
  [steps[index], steps[destination]] = [steps[destination], steps[index]];
  return { ...content, steps };
}

export function patchStep(
  content: ProcedureContent,
  stepId: string,
  patch: Partial<Omit<Step, 'id'>>,
): ProcedureContent {
  return replaceStep(content, stepId, (step) => {
    const updated = { ...step, ...patch };
    const optionalFields = ['caution', 'check', 'media', 'link', 'state'] as const;
    for (const field of optionalFields) {
      if (updated[field] === undefined) delete updated[field];
    }
    return updated;
  });
}

export function togglePart(
  content: ProcedureContent,
  stepId: string,
  part: string,
): ProcedureContent {
  return replaceStep(content, stepId, (step) => {
    const parts = step.parts.includes(part)
      ? step.parts.filter((name) => name !== part)
      : [...step.parts, part];
    return { ...step, parts };
  });
}

/** Boolean values are absolute sets; null inherits the previous step's value. */
export function setStepState(
  content: ProcedureContent,
  stepId: string,
  name: string,
  value: boolean | null,
): ProcedureContent {
  return replaceStep(content, stepId, (step) => {
    const state = value === null ? { ...step.state } : { ...step.state, [name]: value };
    if (value === null) {
      delete state[name];
    }

    const updated: Step = { ...step, state };
    if (Object.keys(state).length === 0) delete updated.state;
    return updated;
  });
}

export function setStartState(
  content: ProcedureContent,
  name: string,
  value: boolean,
): ProcedureContent {
  return { ...content, start: { ...content.start, [name]: value } };
}

export function patchMeta(
  content: ProcedureContent,
  patch: Partial<Pick<ProcedureContent, 'title' | 'summary' | 'minutes'>>,
): ProcedureContent {
  return { ...content, ...patch };
}

/** Unknown step ids return a copy of the initial state. */
export function stateForStep(content: ProcedureContent, stepId: string): MachineState {
  return foldState(content, stepIndex(content, stepId));
}

export function stateBeforeStep(content: ProcedureContent, stepId: string): MachineState {
  return foldState(content, stepIndex(content, stepId) - 1);
}

export function stepIndex(content: ProcedureContent, stepId: string): number {
  return content.steps.findIndex((step) => step.id === stepId);
}

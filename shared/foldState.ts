import type { MachineState } from './machine';
import type { ProcedureContent } from './procedure';

/** Machine state while step `stepIndex` is shown: `start`, then each step's absolute
 * sets for steps 0..stepIndex inclusive. stepIndex < 0 returns a copy of start;
 * stepIndex beyond the last step is treated as the last step. Never mutates its input. */
export function foldState(content: ProcedureContent, stepIndex: number): MachineState {
  let state = { ...content.start };
  const lastStepIndex = Math.min(stepIndex, content.steps.length - 1);
  for (let index = 0; index <= lastStepIndex; index += 1) {
    state = { ...state, ...content.steps[index].state };
  }
  return state;
}

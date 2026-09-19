import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { MachineDefinition, View } from '../../shared/machine';
import type { ProcedureContent, Step } from '../../shared/procedure';
import { validateProcedure } from '../../shared/validateProcedure';
import type { ProcedureIssue } from '../../shared/validateProcedure';
import * as editorOps from './editorOps';

export type EditorState = {
  content: ProcedureContent | null;
  selectedStepId: string | null;
  dirty: boolean;
  machine: MachineDefinition | null;
  linkTargets: Record<string, string[]>;
  load(args: {
    content: ProcedureContent;
    machine: MachineDefinition;
    linkTargets: Record<string, string[]>;
  }): void;
  select(stepId: string | null): void;
  addStep(afterId: string | null, view: View): void;
  removeStep(stepId: string): void;
  moveStep(stepId: string, direction: -1 | 1): void;
  patchStep(stepId: string, patch: Partial<Omit<Step, 'id'>>): void;
  togglePart(stepId: string, part: string): void;
  setStepState(stepId: string, name: string, value: boolean | number | null): void;
  setStartState(name: string, value: boolean | number): void;
  patchMeta(patch: Partial<Pick<ProcedureContent, 'title' | 'summary' | 'minutes'>>): void;
  markSaved(): void;
};

export const useEditorStore: UseBoundStore<StoreApi<EditorState>> = create<EditorState>()(
  (set) => {
    function updateContent(operation: (content: ProcedureContent) => ProcedureContent): void {
      set((store) => {
        if (store.content === null) return store;
        return { content: operation(store.content), dirty: true };
      });
    }

    return {
      content: null,
      selectedStepId: null,
      dirty: false,
      machine: null,
      linkTargets: {},
      load({ content, machine, linkTargets }) {
        set({
          content,
          machine,
          linkTargets,
          selectedStepId: content.steps[0]?.id ?? null,
          dirty: false,
        });
      },
      select(stepId) {
        set({ selectedStepId: stepId });
      },
      addStep(afterId, view) {
        set((store) => {
          if (store.content === null) return store;
          const result = editorOps.addStepAfter(store.content, afterId, view);
          return { content: result.content, selectedStepId: result.stepId, dirty: true };
        });
      },
      removeStep(stepId) {
        set((store) => {
          if (store.content === null) return store;
          const index = editorOps.stepIndex(store.content, stepId);
          const content = editorOps.removeStep(store.content, stepId);
          let selectedStepId = store.selectedStepId;
          if (content !== store.content && selectedStepId === stepId) {
            selectedStepId = content.steps[Math.min(index, content.steps.length - 1)].id;
          }
          return { content, selectedStepId, dirty: true };
        });
      },
      moveStep(stepId, direction) {
        updateContent((content) => editorOps.moveStep(content, stepId, direction));
      },
      patchStep(stepId, patch) {
        updateContent((content) => editorOps.patchStep(content, stepId, patch));
      },
      togglePart(stepId, part) {
        updateContent((content) => editorOps.togglePart(content, stepId, part));
      },
      setStepState(stepId, name, value) {
        updateContent((content) => editorOps.setStepState(content, stepId, name, value));
      },
      setStartState(name, value) {
        updateContent((content) => editorOps.setStartState(content, name, value));
      },
      patchMeta(patch) {
        updateContent((content) => editorOps.patchMeta(content, patch));
      },
      markSaved() {
        set({ dirty: false });
      },
    };
  },
);

const emptyIssues: ProcedureIssue[] = [];
const issueCache = new WeakMap<ProcedureContent, {
  machine: MachineDefinition;
  linkTargets: Record<string, string[]>;
  issues: ProcedureIssue[];
}>();

/** Stable for unchanged validation inputs, including across selection changes. */
export function selectIssues(state: EditorState): ProcedureIssue[] {
  const { content, machine, linkTargets } = state;
  if (content === null || machine === null) return emptyIssues;

  const cached = issueCache.get(content);
  if (cached?.machine === machine && cached.linkTargets === linkTargets) return cached.issues;

  const issues = validateProcedure(content, machine, linkTargets);
  issueCache.set(content, { machine, linkTargets, issues });
  return issues;
}

export function selectSelectedStep(state: EditorState): Step | null {
  return state.content?.steps.find((step) => step.id === state.selectedStepId) ?? null;
}

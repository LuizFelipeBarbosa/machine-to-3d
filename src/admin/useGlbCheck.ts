import { useEffect, useState } from 'react';
import { summarizeGlb } from '../../scripts/lib/glb';
import type { GlbSummary } from '../../scripts/lib/glb';
import { referencedNodes } from '../../shared/machine';
import type { MachineDefinition } from '../../shared/machine';
import { errorMessage } from '../lib/errorMessage';

type FileCheck = {
  file: File;
  summary: GlbSummary | null;
  issues: string[];
};

export function useGlbCheck(
  file: File | null,
  definition: MachineDefinition | null,
): { summary: GlbSummary | null; issues: string[] } {
  const [check, setCheck] = useState<FileCheck | null>(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;

    async function readFile(selected: File) {
      try {
        const bytes = new Uint8Array(await selected.arrayBuffer());
        const summary = summarizeGlb(bytes);
        if (!cancelled) setCheck({ file: selected, summary, issues: [] });
      } catch (cause) {
        if (!cancelled) {
          setCheck({ file: selected, summary: null, issues: [errorMessage(cause)] });
        }
      }
    }

    void readFile(file);
    return () => { cancelled = true; };
  }, [file]);

  if (!file) return { summary: null, issues: ['Choose a GLB file.'] };
  // Never expose a previous file's successful check while its replacement loads.
  if (check?.file !== file) return { summary: null, issues: ['Checking GLB…'] };
  const { summary } = check;
  if (!summary || !definition) return { summary, issues: check.issues };

  const issues: string[] = [];
  if (summary.rootNodes.length !== 1) {
    issues.push(`GLB must have exactly one root node; found ${summary.rootNodes.length}.`);
  } else if (summary.rootNodes[0] !== definition.rootNode) {
    issues.push(`rootNode: expected "${definition.rootNode}", but the GLB root is "${summary.rootNodes[0]}".`);
  }
  const namedNodes = new Set(summary.namedNodes);
  for (const name of referencedNodes(definition)) {
    if (!namedNodes.has(name)) issues.push(`Referenced node "${name}" is missing from the GLB.`);
  }
  return { summary, issues };
}

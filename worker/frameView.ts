/// <reference types="node" />

import { nodeBounds, summarizeGlb } from '../scripts/lib/glb.js';
import type { MachineDefinition, Vec3, View } from '../shared/machine.js';
import type { ProcedureContent } from '../shared/procedure.js';

export type Bounds = { min: Vec3; max: Vec3 };

export function frameView(
  target: Bounds,
  model: Bounds,
  options: { fovDegrees?: number; direction?: Vec3; padding?: number } = {},
): View {
  // Keep the default field of view in sync with MachineScene's camera.
  const { fovDegrees = 36, direction = [-0.55, 0.45, 1], padding = 1.35 } = options;
  const centre: Vec3 = [
    (target.min[0] + target.max[0]) / 2,
    (target.min[1] + target.max[1]) / 2,
    (target.min[2] + target.max[2]) / 2,
  ];
  const radius = diagonal(target) / 2;
  const distance = Math.max(
    radius / Math.sin(fovDegrees * Math.PI / 360) * padding,
    0.35 * diagonal(model),
  );
  const scale = distance / Math.hypot(...direction);
  return {
    pos: roundVector([
      centre[0] + direction[0] * scale,
      centre[1] + direction[1] * scale,
      centre[2] + direction[2] * scale,
    ]),
    target: roundVector(centre),
  };
}

export function stepViews(
  glb: Uint8Array,
  content: ProcedureContent,
  // Framing uses rest-pose geometry, independent of definition presets or effects.
  _definition: MachineDefinition,
): ProcedureContent {
  const modelBounds = summarizeGlb(glb).boundingBox;
  if (!modelBounds) throw new Error('Cannot frame a GLB without model bounds.');

  return {
    ...content,
    steps: content.steps.map(step => ({
      ...step,
      view: frameView(nodeBounds(glb, step.parts) ?? modelBounds, modelBounds),
    })),
  };
}

function diagonal(bounds: Bounds): number {
  return Math.hypot(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  );
}

function roundVector(vector: Vec3): Vec3 {
  return vector.map(value => Number(value.toFixed(2))) as Vec3;
}

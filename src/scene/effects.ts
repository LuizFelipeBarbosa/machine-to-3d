import type { MachineDefinition, Vec3 } from '../../shared/machine';

export type Quat = [number, number, number, number];
export type RestTransform = { position: Vec3; quaternion: Quat };
export type NodePose = RestTransform & { visible: boolean };

export const STATE_EASE_RATE = 4.5;

/** One easing step toward the goals. Returns a new record; values in [0,1]. */
export function easeValues(
  values: Record<string, number>,
  goals: Record<string, boolean>,
  dtSeconds: number,
): Record<string, number> {
  const alpha = 1 - Math.exp(-Math.max(0, dtSeconds) * STATE_EASE_RATE);
  const result: Record<string, number> = {};
  for (const name of new Set([...Object.keys(values), ...Object.keys(goals)])) {
    const goal = goals[name] ? 1 : 0;
    const current = Math.max(0, Math.min(1, values[name] ?? 0));
    const next = current + (goal - current) * alpha;
    result[name] = Math.abs(goal - next) <= 1e-6 ? goal : next;
  }
  return result;
}

/** Nodes referenced by any effect, deduplicated in authored order. */
export function effectNodes(definition: MachineDefinition): string[] {
  const names = new Set<string>();
  for (const variable of definition.stateVars) {
    for (const effect of variable.effects) {
      names.add(effect.node);
    }
  }
  return [...names];
}

function multiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function axisAngle(axis: 'x' | 'y' | 'z', angle: number): Quat {
  const sine = Math.sin(angle / 2);
  return [axis === 'x' ? sine : 0, axis === 'y' ? sine : 0, axis === 'z' ? sine : 0, Math.cos(angle / 2)];
}

/** Compose local offsets after the rest pose, preserving authored rotation order. */
export function computePoses(
  definition: MachineDefinition,
  values: Record<string, number>,
  rest: Record<string, RestTransform>,
): Record<string, NodePose> {
  const poses: Record<string, NodePose> = {};
  for (const name of effectNodes(definition)) {
    const transform = rest[name];
    if (!transform) {
      throw new Error(`Missing rest transform for effect node "${name}".`);
    }
    poses[name] = {
      position: [...transform.position],
      quaternion: [...transform.quaternion],
      visible: true,
    };
  }

  for (const variable of definition.stateVars) {
    const value = Math.max(0, Math.min(1, values[variable.name] ?? 0));
    for (const effect of variable.effects) {
      const pose = poses[effect.node];
      switch (effect.type) {
        case 'translate':
          for (let axis = 0; axis < 3; axis += 1) {
            pose.position[axis] += effect.offset[axis] * value;
          }
          break;
        case 'rotate':
          pose.quaternion = multiply(pose.quaternion, axisAngle(effect.axis, effect.angle * value));
          break;
        case 'visible':
          pose.visible = pose.visible && value > 0.5;
          break;
      }
    }
  }
  return poses;
}

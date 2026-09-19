import * as THREE from 'three';
import { referencedClips } from '../../shared/machine';
import type { MachineDefinition } from '../../shared/machine';
import { effectNodes } from './effects';
import type { RestTransform } from './effects';

export type ModelIndex = {
  root: THREE.Object3D;
  nodes: Map<string, THREE.Object3D>;
  rest: Record<string, RestTransform>;
  partMeshes: Map<string, THREE.Mesh[]>;
  bounds: THREE.Box3;
  clips: Map<string, { clip: THREE.AnimationClip; targetNodes: string[] }>;
};

/** Preserve the original transform when a posed node is indexed again. */
export function captureRest(node: THREE.Object3D): RestTransform {
  const userData = node.userData as { restTransform?: RestTransform };
  userData.restTransform ??= {
    position: [node.position.x, node.position.y, node.position.z],
    quaternion: [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w],
  };
  return userData.restTransform;
}

export function indexModel(
  scene: THREE.Object3D,
  definition: MachineDefinition,
  animations: THREE.AnimationClip[] = [],
): ModelIndex {
  const roots = scene.children.filter((child) => child.name.length > 0);
  if (roots.length !== 1) {
    throw new Error(`Expected one named model root in "${scene.name}", found ${roots.length}.`);
  }
  const root = roots[0];
  if (root.name !== definition.rootNode) {
    throw new Error(`Expected model root "${definition.rootNode}", found "${root.name}".`);
  }
  const nodes = new Map<string, THREE.Object3D>();
  root.traverse((node) => {
    if (!node.name) return;
    if (nodes.has(node.name)) {
      throw new Error(`Duplicate model node name "${node.name}".`);
    }
    nodes.set(node.name, node);
  });

  const clips = indexClips(nodes, definition, animations);
  const rest: Record<string, RestTransform> = {};
  for (const name of effectNodes(definition)) {
    const node = requireNode(nodes, name);
    rest[name] = captureRest(node);
  }
  const partMeshes = new Map<string, THREE.Mesh[]>();
  for (const part of definition.parts) {
    const meshes: THREE.Mesh[] = [];
    requireNode(nodes, part.name).traverse((node) => {
      if (node instanceof THREE.Mesh) meshes.push(node);
    });
    partMeshes.set(part.name, meshes);
  }

  root.updateWorldMatrix(true, true);
  // Box3 includes invisible descendants, so hidden authored parts still affect framing.
  const bounds = new THREE.Box3().setFromObject(root);
  if (bounds.isEmpty()) {
    throw new Error(`Model root "${root.name}" has no geometry to frame.`);
  }
  return { root, nodes, rest, partMeshes, bounds, clips };
}

function clipTargetNodes(clip: THREE.AnimationClip): string[] {
  const names = new Set<string>();
  for (const track of clip.tracks) {
    const name = THREE.PropertyBinding.parseTrackName(track.name).nodeName
      || track.name.substring(0, track.name.lastIndexOf('.'));
    if (name) names.add(name);
  }
  return [...names];
}

function indexClips(
  nodes: Map<string, THREE.Object3D>,
  definition: MachineDefinition,
  animations: THREE.AnimationClip[],
): ModelIndex['clips'] {
  const movedNodes = new Set<string>();
  for (const variable of definition.stateVars) {
    for (const effect of variable.effects) {
      if (effect.type === 'translate' || effect.type === 'rotate') {
        movedNodes.add(effect.node);
      }
    }
  }

  const clips: ModelIndex['clips'] = new Map();
  const owners = new Map<string, string>();
  for (const name of referencedClips(definition)) {
    const clip = animations.find((animation) => animation.name === name);
    if (!clip) throw new Error(`Missing animation clip "${name}"`);
    const targetNodes = clipTargetNodes(clip);
    for (const nodeName of targetNodes) {
      if (!nodes.has(nodeName)) {
        throw new Error(`Clip "${name}" animates unknown node "${nodeName}"`);
      }
      if (movedNodes.has(nodeName)) {
        throw new Error(`Clip "${name}" animates node "${nodeName}", which is also moved by a translate/rotate effect`);
      }
      const owner = owners.get(nodeName);
      if (owner !== undefined) {
        throw new Error(`Clips "${owner}" and "${name}" both animate node "${nodeName}"`);
      }
      owners.set(nodeName, name);
    }
    clips.set(name, { clip, targetNodes });
  }
  return clips;
}

function requireNode(nodes: Map<string, THREE.Object3D>, name: string): THREE.Object3D {
  const node = nodes.get(name);
  if (!node) throw new Error(`Machine definition references missing model node "${name}".`);
  return node;
}

/** Walk up from a picked object to its nearest part ancestor. */
export function partOf(object: THREE.Object3D, definition: MachineDefinition): string | null {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (definition.parts.some((part) => part.name === node.name)) return node.name;
  }
  return null;
}

export function isHiddenByAncestor(object: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (!node.visible) return true;
  }
  return false;
}

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { MachineDefinition } from '../../shared/machine';
import { captureRest, indexModel } from './modelIndex';

const definition: MachineDefinition = {
  formatVersion: 1,
  rootNode: 'R',
  parts: [],
  presetViews: [],
  stateVars: [{
    name: 'lift',
    label: 'lift',
    kind: 'toggle',
    effects: [{ type: 'translate', node: 'head', offset: [0, 0.3, 0] }],
  }],
};

function createScene() {
  const scene = new THREE.Group();
  const root = new THREE.Group();
  root.name = 'R';
  scene.add(root);
  const head = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  head.name = 'head';
  root.add(head);
  return { scene, root, head };
}

describe('indexModel', () => {
  it('preserves the rest position when re-indexing a posed node', () => {
    const { scene, head } = createScene();
    const initial = indexModel(scene, definition);
    expect(initial.rest.head.position).toEqual([0, 0, 0]);

    head.position.y += 0.3;
    const reindexed = indexModel(scene, definition);
    expect(reindexed.rest.head.position).toEqual([0, 0, 0]);
    expect(reindexed.rest.head).toBe(initial.rest.head);
    expect(head.position.y).toBe(0.3);
  });

  it('rejects duplicate node names under the root', () => {
    const { scene, root } = createScene();
    const duplicate = new THREE.Object3D();
    duplicate.name = 'head';
    root.add(duplicate);

    expect(() => indexModel(scene, definition)).toThrow(new Error('Duplicate model node name "head".'));
  });
});

describe('captureRest', () => {
  it('returns the same stored transform after the live transform changes', () => {
    const node = new THREE.Object3D();
    node.position.set(1, 2, 3);
    const rest = captureRest(node);
    expect(rest).toEqual({ position: [1, 2, 3], quaternion: [0, 0, 0, 1] });
    expect(node.userData.restTransform).toBe(rest);

    node.position.y += 0.3;
    node.rotateY(Math.PI / 2);
    expect(captureRest(node)).toBe(rest);
    expect(rest).toEqual({ position: [1, 2, 3], quaternion: [0, 0, 0, 1] });
  });
});

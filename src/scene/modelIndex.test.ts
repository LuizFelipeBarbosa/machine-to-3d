import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Effect, MachineDefinition } from '../../shared/machine';
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

const clipDefinition: MachineDefinition = {
  formatVersion: 1,
  rootNode: 'Box',
  parts: [],
  presetViews: [],
  stateVars: [{
    name: 'open',
    label: 'Open door',
    kind: 'toggle',
    effects: [{ type: 'clip', clip: 'doorOpen' }],
  }],
};

function createClipScene() {
  const scene = new THREE.Group();
  const root = new THREE.Group();
  root.name = 'Box';
  scene.add(root);
  for (const name of ['body', 'door', 'panel']) {
    const node = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    node.name = name;
    root.add(node);
  }
  return scene;
}

function createClip(name = 'doorOpen', node = 'door') {
  return new THREE.AnimationClip(name, -1, [
    new THREE.QuaternionKeyframeTrack(`${node}.quaternion`, [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
  ]);
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

  it('indexes only referenced clips and their target nodes', () => {
    const clip = createClip();
    const unreferenced = createClip('unused', 'ghost');
    const index = indexModel(createClipScene(), clipDefinition, [clip, unreferenced]);

    expect([...index.clips.keys()]).toEqual(['doorOpen']);
    expect(index.clips.get('doorOpen')).toEqual({ clip, targetNodes: ['door'] });
    expect(index.clips.get('doorOpen')!.clip).toBe(clip);
  });

  it('has no indexed clips when the definition has no clip effects', () => {
    const { scene } = createScene();
    expect(indexModel(scene, definition).clips.size).toBe(0);
  });

  it('rejects missing referenced clips', () => {
    expect(() => indexModel(createClipScene(), clipDefinition, [])).toThrow(
      new Error('Missing animation clip "doorOpen"'),
    );
  });

  it.each<Effect>([
    { type: 'rotate', node: 'door', axis: 'y', angle: Math.PI / 2 },
    { type: 'translate', node: 'door', offset: [1, 0, 0] },
  ])('rejects clip targets also moved by a $type effect', (effect) => {
    const conflictingDefinition: MachineDefinition = {
      ...clipDefinition,
      stateVars: [{
        ...clipDefinition.stateVars[0],
        effects: [...clipDefinition.stateVars[0].effects, effect],
      }],
    };

    expect(() => indexModel(createClipScene(), conflictingDefinition, [createClip()])).toThrow(
      new Error('Clip "doorOpen" animates node "door", which is also moved by a translate/rotate effect'),
    );
  });

  it('rejects shared clip targets in definition order', () => {
    const conflictingDefinition: MachineDefinition = {
      ...clipDefinition,
      stateVars: [
        ...clipDefinition.stateVars,
        {
          name: 'close',
          label: 'Close door',
          kind: 'toggle',
          effects: [{ type: 'clip', clip: 'doorClose' }],
        },
      ],
    };
    const animations = [createClip('doorClose'), createClip('doorOpen')];

    expect(() => indexModel(createClipScene(), conflictingDefinition, animations)).toThrow(
      new Error('Clips "doorOpen" and "doorClose" both animate node "door"'),
    );
  });

  it('allows a visible effect on a clip target', () => {
    const visibleDefinition: MachineDefinition = {
      ...clipDefinition,
      stateVars: [{
        ...clipDefinition.stateVars[0],
        effects: [...clipDefinition.stateVars[0].effects, { type: 'visible', node: 'door' }],
      }],
    };
    const clip = createClip();
    const index = indexModel(createClipScene(), visibleDefinition, [clip]);

    expect(index.clips.get('doorOpen')).toEqual({ clip, targetNodes: ['door'] });
  });

  it('rejects unknown clip target nodes', () => {
    expect(() => indexModel(createClipScene(), clipDefinition, [createClip('doorOpen', 'ghost')])).toThrow(
      new Error('Clip "doorOpen" animates unknown node "ghost"'),
    );
  });

  it('deduplicates target nodes across tracks', () => {
    const clip = createClip();
    clip.tracks.push(new THREE.VectorKeyframeTrack('door.position', [0, 1], [0, 0, 0, 1, 0, 0]));
    const index = indexModel(createClipScene(), clipDefinition, [clip]);

    expect(index.clips.get('doorOpen')!.targetNodes).toEqual(['door']);
  });

  it('skips tracks without a target node name', () => {
    const clip = createClip();
    clip.tracks.push(new THREE.VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 1, 0, 0]));
    const index = indexModel(createClipScene(), clipDefinition, [clip]);

    expect(index.clips.get('doorOpen')!.targetNodes).toEqual(['door']);
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

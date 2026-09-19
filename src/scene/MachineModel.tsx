import { useLayoutEffect, useMemo, useRef } from 'react';
import type { JSX } from 'react';
import { useFrame } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import type { MachineDefinition, MachineState } from '../../shared/machine';
import { computePoses, easeValues } from './effects';
import { indexModel, isHiddenByAncestor, partOf } from './modelIndex';
import type { ModelIndex } from './modelIndex';
import { prefersReducedMotion } from './reducedMotion';

export type MachineModelProps = {
  url: string;
  definition: MachineDefinition;
  state: MachineState;
  highlightedParts: string[];
  instant?: boolean;
  onIndexed?: (index: ModelIndex) => void;
  onPickPart?: (part: string | null) => void;
};

type EmissiveMaterial = THREE.Material & { emissive: THREE.Color; emissiveIntensity: number };

function hasEmissive(material: THREE.Material): material is EmissiveMaterial {
  return 'emissive' in material && material.emissive instanceof THREE.Color;
}

function highlightedMaterial(base: THREE.Material, cache: Map<THREE.Material, THREE.Material>): THREE.Material {
  const cached = cache.get(base);
  if (cached) return cached;
  const clone = base.clone();
  if (hasEmissive(clone)) {
    clone.emissive.setHex(0x2587ab);
    clone.emissiveIntensity = 0.4;
  }
  cache.set(base, clone);
  return clone;
}

function goalValues(definition: MachineDefinition, state: MachineState): Record<string, number> {
  return Object.fromEntries(definition.stateVars.map(({ name }) => [name, state[name] ? 1 : 0]));
}

export function MachineModel({
  url, definition, state, highlightedParts, instant = false, onIndexed, onPickPart,
}: MachineModelProps): JSX.Element {
  const gltf = useGLTF(url);
  const scene = useMemo(() => gltf.scene.clone(true), [gltf.scene]);
  const index = useMemo(() => indexModel(scene, definition), [scene, definition]);
  const values = useRef(goalValues(definition, state));
  const pointerDown = useRef<{ x: number; y: number; id: number } | null>(null);
  const materials = useMemo(() => {
    const bases = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    for (const meshes of index.partMeshes.values()) {
      for (const mesh of meshes) bases.set(mesh, mesh.material);
    }
    return { bases, clones: new Map<THREE.Material, THREE.Material>() };
  }, [index]);
  const highlightedMeshes = useMemo(() => {
    const meshes = new Set<THREE.Mesh>();
    for (const part of highlightedParts) {
      for (const mesh of index.partMeshes.get(part) ?? []) meshes.add(mesh);
    }
    return meshes;
  }, [index, highlightedParts]);

  useLayoutEffect(() => {
    const visibility = new Map<THREE.Object3D, boolean>();
    for (const name of Object.keys(index.rest)) {
      const node = index.nodes.get(name)!;
      visibility.set(node, node.visible);
    }
    const shadows = new Map<THREE.Mesh, boolean>();
    index.root.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        shadows.set(node, node.castShadow);
        node.castShadow = true;
      }
    });
    return () => {
      for (const [mesh, base] of materials.bases) mesh.material = base;
      for (const clone of materials.clones.values()) clone.dispose();
      materials.clones.clear();
      for (const [mesh, castShadow] of shadows) mesh.castShadow = castShadow;
      for (const [name, rest] of Object.entries(index.rest)) {
        const node = index.nodes.get(name)!;
        node.position.fromArray(rest.position);
        node.quaternion.fromArray(rest.quaternion);
        node.visible = visibility.get(node)!;
      }
    };
  }, [index, materials]);

  useLayoutEffect(() => {
    onIndexed?.(index);
  }, [index, onIndexed]);

  function updateModel(elapsedSeconds: number, dt: number): void {
    const reducedMotion = prefersReducedMotion();
    values.current = instant || reducedMotion
      ? goalValues(definition, state)
      : easeValues(values.current, state, Math.min(dt, 0.1));
    const poses = computePoses(definition, values.current, index.rest);
    for (const [name, pose] of Object.entries(poses)) {
      const node = index.nodes.get(name)!;
      node.position.fromArray(pose.position);
      node.quaternion.fromArray(pose.quaternion);
      node.visible = pose.visible;
    }
    for (const [mesh, base] of materials.bases) {
      if (!highlightedMeshes.has(mesh)) {
        mesh.material = base;
      } else if (Array.isArray(base)) {
        // Reuse the array between frames as well as the individual clones.
        if (mesh.material === base) {
          mesh.material = base.map((material) => highlightedMaterial(material, materials.clones));
        }
      } else {
        mesh.material = highlightedMaterial(base, materials.clones);
      }
    }
    const intensity = reducedMotion ? 0.4 : 0.34 + 0.16 * Math.sin(elapsedSeconds / 0.32);
    for (const clone of materials.clones.values()) {
      if (hasEmissive(clone)) clone.emissiveIntensity = intensity;
    }
    index.root.updateWorldMatrix(true, true);
  }

  useFrame(({ clock }, dt) => updateModel(clock.elapsedTime, dt));

  function handlePointerUp(event: ThreeEvent<PointerEvent>): void {
    const start = pointerDown.current;
    pointerDown.current = null;
    if (!start || start.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
    let picked: string | null = null;
    for (const intersection of event.intersections) {
      if (isHiddenByAncestor(intersection.object)) continue;
      picked = partOf(intersection.object, definition);
      if (picked) break;
    }
    if (picked) event.stopPropagation();
    onPickPart?.(picked);
  }

  return (
    <primitive
      object={scene}
      dispose={null}
      onPointerDown={(event: ThreeEvent<PointerEvent>) => {
        pointerDown.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
      }}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => { pointerDown.current = null; }}
    />
  );
}

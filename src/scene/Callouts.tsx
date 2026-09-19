import { useMemo, useRef } from 'react';
import type { JSX } from 'react';
import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { isHiddenByAncestor } from './modelIndex';
import type { ModelIndex } from './modelIndex';

export function Callouts({ index, parts, labelOf }: {
  index: ModelIndex | null;
  parts: string[];
  labelOf: (part: string) => string;
}): JSX.Element | null {
  if (!index) return null;
  return (
    <>
      {[...new Set(parts)].map((part, position) => (
        <PartCallout key={part} index={index} part={part} label={labelOf(part)} right={position % 2 === 0} />
      ))}
    </>
  );
}

function PartCallout({ index, part, label, right }: {
  index: ModelIndex; part: string; label: string; right: boolean;
}): JSX.Element {
  const anchor = useRef<THREE.Group>(null);
  const content = useRef<HTMLDivElement>(null);
  const bounds = useMemo(() => new THREE.Box3(), []);
  const centre = useMemo(() => new THREE.Vector3(), []);
  const x = right ? 80 : -80;

  function updateCallout(): void {
    if (!anchor.current || !content.current) return;
    const node = index.nodes.get(part);
    const meshes = index.partMeshes.get(part) ?? [];
    const visible = node && !isHiddenByAncestor(node)
      && meshes.some((mesh) => !isHiddenByAncestor(mesh));
    if (!visible || !node) {
      content.current.style.display = 'none';
      return;
    }
    bounds.setFromObject(node);
    content.current.style.display = bounds.isEmpty() ? 'none' : '';
    if (!bounds.isEmpty()) anchor.current.position.copy(bounds.getCenter(centre));
  }

  useFrame(updateCallout);
  return (
    <group ref={anchor}>
      <Html zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
        <div ref={content} style={{ position: 'relative', pointerEvents: 'none' }}>
          <svg
            className="callout-leader"
            width="1"
            height="1"
            aria-hidden="true"
            style={{ position: 'absolute', overflow: 'visible', pointerEvents: 'none' }}
          >
            <line x1="0" y1="0" x2={x} y2="-70" stroke="currentColor" />
            <circle cx="0" cy="0" r="2" fill="currentColor" />
          </svg>
          <div
            className="callout"
            style={{ position: 'absolute', left: x, top: -70, transform: right ? 'translateY(-50%)' : 'translate(-100%, -50%)' }}
          >
            {label}
          </div>
        </div>
      </Html>
    </group>
  );
}

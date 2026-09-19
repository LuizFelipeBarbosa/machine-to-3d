import { Component, forwardRef, Suspense, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { JSX, ReactNode, Ref } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { CameraControls } from '@react-three/drei';
import type { CameraControlsImpl } from '@react-three/drei';
import * as THREE from 'three';
import type { MachineDefinition, MachineState, View } from '../../shared/machine';
import { MachineModel } from './MachineModel';
import { Callouts } from './Callouts';
import type { ModelIndex } from './modelIndex';
import { prefersReducedMotion } from './reducedMotion';

export type MachineSceneHandle = {
  goToView(view: View, options?: { instant?: boolean }): void;
  getCurrentView(): View;
};

export type MachineSceneProps = {
  modelUrl: string;
  definition: MachineDefinition;
  state: MachineState;
  highlightedParts: string[];
  initialView?: View;
  onPickPart?: (part: string | null) => void;
  labelOf?: (part: string) => string;
  className?: string;
  children?: ReactNode;
};

export const CAMERA_SMOOTH_TIME = 0.35;

function SceneFailure(): JSX.Element {
  return <p className="scene-fail" role="alert">The 3D view could not start. The procedure still works without it.</p>;
}

class SceneErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? <SceneFailure /> : this.props.children;
  }
}

export const MachineScene = forwardRef<MachineSceneHandle, MachineSceneProps>(function MachineScene(props, ref) {
  return (
    <div className={`machine-scene ${props.className ?? ''}`} style={{ position: 'relative' }}>
      <SceneErrorBoundary key={props.modelUrl}>
        <Canvas
          shadows
          dpr={[1, 2]}
          gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 0.9 }}
          camera={{ fov: 36, near: 0.05 }}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
          fallback={<SceneFailure />}
          onPointerMissed={() => props.onPickPart?.(null)}
          onCreated={({ gl }) => {
            gl.domElement.setAttribute('role', 'img');
            gl.domElement.setAttribute('aria-label', 'Interactive 3D model. The current step highlights the parts it involves.');
          }}
        >
          <SceneContents {...props} sceneRef={ref} />
        </Canvas>
      </SceneErrorBoundary>
      {props.children}
    </div>
  );
});

function applyView(controls: CameraControlsImpl, view: View, aspect: number, instant: boolean): void {
  const stretch = aspect < 1.25 ? Math.min(1.25 / Math.max(aspect, 0.001), 1.9) : 1;
  const target = new THREE.Vector3(...view.target);
  const position = new THREE.Vector3(...view.pos).sub(target).multiplyScalar(stretch).add(target);
  const reducedMotion = prefersReducedMotion();
  void controls.setLookAt(position.x, position.y, position.z, ...view.target, !instant && !reducedMotion);
}

function SceneContents({
  modelUrl, definition, state, highlightedParts, initialView, onPickPart, labelOf, sceneRef,
}: MachineSceneProps & { sceneRef: Ref<MachineSceneHandle> }): JSX.Element {
  const [index, setIndex] = useState<ModelIndex | null>(null);
  const controls = useRef<CameraControlsImpl>(null);
  const keyLight = useRef<THREE.DirectionalLight>(null);
  const pendingView = useRef<{ view: View; instant: boolean } | null>(null);
  const camera = useThree((store) => store.camera);
  const getThree = useThree((store) => store.get);
  const geometry = useMemo(() => {
    if (!index) return null;
    const dimensions = index.bounds.getSize(new THREE.Vector3());
    return {
      size: Math.max(dimensions.x, dimensions.y, dimensions.z, 0.001),
      centre: index.bounds.getCenter(new THREE.Vector3()),
      floorY: index.bounds.min.y,
    };
  }, [index]);
  const lightTarget = useMemo(() => new THREE.Object3D(), []);

  useImperativeHandle(sceneRef, () => ({
    goToView(view, options) {
      if (!index || !controls.current) {
        pendingView.current = { view, instant: options?.instant ?? false };
        return;
      }
      const viewport = getThree().size;
      applyView(controls.current, view, viewport.width / viewport.height, options?.instant ?? false);
    },
    getCurrentView() {
      const position = new THREE.Vector3();
      const target = new THREE.Vector3();
      if (controls.current) {
        // false requests the actual current pose during an animated transition.
        controls.current.getPosition(position, false);
        controls.current.getTarget(target, false);
      } else {
        position.copy(camera.position);
      }
      return { pos: [position.x, position.y, position.z], target: [target.x, target.y, target.z] };
    },
  }), [camera, getThree, index]);

  useLayoutEffect(() => {
    if (!index || !geometry || !controls.current) return;
    camera.far = geometry.size * 40;
    camera.updateProjectionMatrix();
    lightTarget.position.copy(geometry.centre);
    lightTarget.updateMatrixWorld();
    keyLight.current?.shadow.camera.updateProjectionMatrix();

    const viewport = getThree().size;
    const requested = pendingView.current;
    pendingView.current = null;
    if (requested) {
      applyView(controls.current, requested.view, viewport.width / viewport.height, requested.instant);
    } else if (initialView) {
      applyView(controls.current, initialView, viewport.width / viewport.height, true);
    } else {
      const padding = geometry.size * 0.1;
      void controls.current.fitToBox(index.root, false, {
        paddingTop: padding, paddingBottom: padding, paddingLeft: padding, paddingRight: padding,
      });
    }
  }, [camera, geometry, getThree, index, initialView, lightTarget]);

  const label = labelOf ?? ((name: string) => definition.parts.find((part) => part.name === name)?.label ?? name);
  const size = geometry?.size ?? 1;
  const centre = geometry?.centre ?? new THREE.Vector3();
  const lightScale = size / 4;

  return (
    <>
      <hemisphereLight args={[0xffffff, 0x79808a, 0.75]} />
      <primitive object={lightTarget} />
      <directionalLight
        ref={keyLight}
        color={0xffffff}
        intensity={1.5}
        position={[centre.x + 4 * lightScale, centre.y + 9 * lightScale, centre.z + 6 * lightScale]}
        target={lightTarget}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0005}
        shadow-camera-left={-size}
        shadow-camera-right={size}
        shadow-camera-top={size}
        shadow-camera-bottom={-size}
        shadow-camera-near={0.05}
        shadow-camera-far={size * 40}
      />
      <directionalLight color={0xc4d9ff} intensity={0.7} target={lightTarget} position={[centre.x - 5 * lightScale, centre.y + 4 * lightScale, centre.z + 2 * lightScale]} />
      <directionalLight color={0xffffff} intensity={1.5} target={lightTarget} position={[centre.x + 2 * lightScale, centre.y + 6 * lightScale, centre.z - 5 * lightScale]} />
      {geometry && (
        <mesh rotation-x={-Math.PI / 2} position={[centre.x, geometry.floorY, centre.z]} receiveShadow>
          <planeGeometry args={[200, 200]} />
          <shadowMaterial opacity={0.15} />
        </mesh>
      )}
      <CameraControls ref={controls} makeDefault smoothTime={CAMERA_SMOOTH_TIME} minDistance={size * 0.25} maxDistance={size * 3.5} />
      <Suspense fallback={null}>
        <MachineModel url={modelUrl} definition={definition} state={state} highlightedParts={highlightedParts} onIndexed={setIndex} onPickPart={onPickPart} />
        <Callouts index={index} parts={highlightedParts} labelOf={label} />
      </Suspense>
    </>
  );
}

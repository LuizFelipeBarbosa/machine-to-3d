import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { buildNx10Model } from './buildModel';

declare global {
  interface Window {
    __glbBase64?: string;
    __glbError?: string;
  }
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(''));
}

function renderPreview(root: THREE.Group): void {
  const scene = new THREE.Scene();
  scene.add(root);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x79808a, .75));
  for (const [color, intensity, x, y, z] of [
    [0xffffff, 1.5, 4, 9, 6],
    [0xc4d9ff, .7, -5, 4, 2],
    [0xffffff, 1.5, 2, 6, -5],
  ]) {
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.set(x, y, z);
    scene.add(light);
  }

  const width = Math.max(window.innerWidth, 1);
  const height = Math.max(window.innerHeight, 1);
  const camera = new THREE.PerspectiveCamera(36, width / height, .05, 100);
  const bounds = new THREE.Box3().setFromObject(root);
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const verticalFov = THREE.MathUtils.degToRad(camera.fov);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
  const distance = sphere.radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2) * 1.1;
  camera.position.set(-7.5, 3.1, 9.5).normalize().multiplyScalar(distance).add(sphere.center);
  camera.lookAt(sphere.center);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = .9;
  renderer.domElement.setAttribute('aria-label', 'Park NX10 model preview');
  document.body.appendChild(renderer.domElement);
  renderer.render(scene, camera);
}

async function main(): Promise<void> {
  const status = document.getElementById('status');
  try {
    const root = buildNx10Model();
    const exporter = new GLTFExporter();
    const result = await exporter.parseAsync(root, { binary: true });
    if (!(result instanceof ArrayBuffer)) throw new Error('Expected a binary glTF export.');
    window.__glbBase64 = toBase64(result);
    if (status) status.textContent = `Export ready: ${result.byteLength} bytes`;

    // A missing WebGL context must not prevent the offline GLB export.
    try {
      renderPreview(root);
    } catch (error) {
      console.warn('NX10 preview unavailable:', error);
      if (status) status.textContent += ' (WebGL preview unavailable)';
    }
  } catch (error) {
    window.__glbError = error instanceof Error ? error.message : String(error);
    if (status) status.textContent = window.__glbError;
  }
}

void main();

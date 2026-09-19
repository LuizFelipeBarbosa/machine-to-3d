import * as THREE from 'three';

function buildBody(): THREE.Group {
  const body = new THREE.Group();
  body.name = 'body';
  const material = new THREE.MeshStandardMaterial({ color: 0xb8c2cc, roughness: .6 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(3, 2, 2), material);
  mesh.position.y = 1;
  body.add(mesh);
  return body;
}

function buildDoor(): THREE.Group {
  const door = new THREE.Group();
  door.name = 'door';
  // The front faces +Z. Keep the group origin on the left hinge edge and offset
  // the mesh by half its width, so the group swings about the hinge, not its center.
  door.position.set(-1.4, 1, 1.08);
  const material = new THREE.MeshStandardMaterial({ color: 0x367ca3, roughness: .4 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2.8, 1.8, .12), material);
  mesh.position.x = 1.4;
  door.add(mesh);
  return door;
}

function buildPanel(): THREE.Group {
  const panel = new THREE.Group();
  panel.name = 'panel';
  panel.position.set(0, 2, .35);
  const material = new THREE.MeshStandardMaterial({ color: 0x424c56, roughness: .5 });
  const plate = new THREE.Mesh(new THREE.BoxGeometry(1.4, .12, .7), material);
  plate.position.y = .06;
  panel.add(plate);

  const knobMaterial = new THREE.MeshStandardMaterial({ color: 0x20262c, roughness: .7 });
  const knobGeometry = new THREE.CylinderGeometry(.14, .14, .18, 24);
  for (const x of [-.35, .35]) {
    const knob = new THREE.Mesh(knobGeometry, knobMaterial);
    knob.position.set(x, .21, 0);
    panel.add(knob);
  }
  return panel;
}

function buildDoorClip(): THREE.AnimationClip {
  const axis = new THREE.Vector3(0, 1, 0);
  const rotations: number[] = [];
  for (const degrees of [0, -50, -100]) {
    const quaternion = new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(degrees));
    rotations.push(...quaternion.toArray());
  }
  const track = new THREE.QuaternionKeyframeTrack('door.quaternion', [0, .75, 1.5], rotations);
  return new THREE.AnimationClip('doorOpen', 1.5, [track]);
}

/** Builds a texture-free machine with named parts and an explicit list of exportable clips. */
export function buildModel(): { root: THREE.Group; clips: THREE.AnimationClip[] } {
  const root = new THREE.Group();
  root.name = 'Kit_Box';
  root.add(buildBody(), buildDoor(), buildPanel());
  return { root, clips: [buildDoorClip()] };
}

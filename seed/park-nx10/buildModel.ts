import * as THREE from 'three';

function mesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  parent: THREE.Group,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const result = new THREE.Mesh(geometry, material);
  result.position.set(x, y, z);
  result.castShadow = true;
  result.receiveShadow = true;
  parent.add(result);
  return result;
}

function box(
  w: number, h: number, d: number,
  x: number, y: number, z: number,
  material: THREE.Material, parent: THREE.Group,
): THREE.Mesh {
  return mesh(new THREE.BoxGeometry(w, h, d), material, parent, x, y, z);
}

function rounded(
  w: number, h: number, d: number, r: number,
  x: number, y: number, z: number,
  material: THREE.Material, parent: THREE.Group,
): THREE.Mesh {
  const shape = new THREE.Shape();
  const left = -w / 2;
  const bottom = -h / 2;
  shape.moveTo(left + r, bottom);
  shape.lineTo(left + w - r, bottom);
  shape.quadraticCurveTo(left + w, bottom, left + w, bottom + r);
  shape.lineTo(left + w, bottom + h - r);
  shape.quadraticCurveTo(left + w, bottom + h, left + w - r, bottom + h);
  shape.lineTo(left + r, bottom + h);
  shape.quadraticCurveTo(left, bottom + h, left, bottom + h - r);
  shape.lineTo(left, bottom + r);
  shape.quadraticCurveTo(left, bottom, left + r, bottom);

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: d,
    bevelEnabled: true,
    bevelSegments: 3,
    steps: 1,
    bevelSize: .025,
    bevelThickness: .025,
    curveSegments: 12,
  });
  geometry.translate(0, 0, -d / 2);
  return mesh(geometry, material, parent, x, y, z);
}

function cyl(
  r: number, h: number,
  x: number, y: number, z: number,
  material: THREE.Material, parent: THREE.Group,
  axis: 'x' | 'y' | 'z' = 'y',
): THREE.Mesh {
  const result = mesh(new THREE.CylinderGeometry(r, r, h, 40), material, parent, x, y, z);
  if (axis === 'z') result.rotation.x = Math.PI / 2;
  if (axis === 'x') result.rotation.z = Math.PI / 2;
  return result;
}

function screw(x: number, y: number, z: number, parent: THREE.Group): void {
  cyl(.033, .022, x, y, z, materials.dark, parent, 'z');
  box(.041, .006, .008, x, y, z + .015, materials.black, parent);
}

function text(
  label: string, w: number, h: number,
  x: number, y: number, z: number, parent: THREE.Group,
): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create a 2D canvas for NX10 text decals.');
  context.clearRect(0, 0, 512, 128);
  context.fillStyle = '#969c9c';
  context.font = 'italic 72px Georgia';
  context.textAlign = 'center';
  context.fillText(label, 256, 87);
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
  });
  return mesh(new THREE.PlaneGeometry(w, h), material, parent, x, y, z);
}

function cheek(x: number, covers: THREE.Group): void {
  const shape = new THREE.Shape();
  shape.moveTo(-1.35, 1.04);
  shape.lineTo(.5, 1.04);
  shape.lineTo(.5, 2.73);
  shape.quadraticCurveTo(.5, 3.38, 1.1, 3.38);
  shape.lineTo(1.1, 4.65);
  shape.lineTo(-1.35, 4.65);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: .25,
    bevelEnabled: true,
    bevelSize: .035,
    bevelThickness: .035,
    bevelSegments: 3,
    curveSegments: 18,
  });
  mesh(geometry, materials.white, covers, x, 0, 0).rotation.y = -Math.PI / 2;
}

const materials = {
  white: new THREE.MeshStandardMaterial({ color: 0xe9e9e6, metalness: .28, roughness: .3 }),
  black: new THREE.MeshStandardMaterial({ color: 0x171b1e, metalness: .35, roughness: .34 }),
  silver: new THREE.MeshStandardMaterial({ color: 0xb9c1c5, metalness: .78, roughness: .27 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x3f4449, metalness: .7, roughness: .3 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x0d1013, roughness: .8 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xc8a457, metalness: .7, roughness: .24 }),
  specimen: new THREE.MeshStandardMaterial({ color: 0x6a7f97, metalness: .9, roughness: .19 }),
};

function addChassis(root: THREE.Group, covers: THREE.Group): void {
  const { rubber, white, black } = materials;
  for (const x of [-1.15, 1.15]) {
    for (const z of [-.95, .95]) {
      cyl(.22, .16, x, .13, z, rubber, root);
    }
  }
  rounded(3.05, .58, 2.65, .18, 0, .47, 0, white, root);
  rounded(3.5, .35, 3.03, .16, 0, .85, 0, white, covers);
  rounded(3.43, .09, 2.95, .2, 0, 1.08, 0, black, covers);
  box(.68, .23, .08, -.9, .4, 1.335, rubber, root);
  text('NX10', .47, .12, 1.05, .83, 1.54, covers);
}

function addRearSupport(root: THREE.Group, covers: THREE.Group): void {
  const { black, white } = materials;
  box(2.48, 3.47, .42, 0, 2.65, -1.12, black, root);
  rounded(2.88, 3.7, .18, .09, 0, 2.78, -1.42, white, covers);
  cheek(-1.2, covers);
  cheek(1.46, covers);
  rounded(2.87, .14, 1.56, .08, 0, 4.62, -.57, white, covers);
}

function addZStage(stage: THREE.Group): void {
  const { black, silver, dark } = materials;
  box(1.15, 4.56, .32, .24, 3.42, -.7, black, stage);
  for (const x of [-.16, .63]) {
    box(.09, 3.85, .09, x, 3.35, -.47, silver, stage);
    for (let y = 1.55; y < 5.2; y += .4) {
      screw(x, y, -.407, stage);
    }
  }
  cyl(.075, 3.64, .27, 3.37, -.43, silver, stage);
  for (let i = 0; i < 55; i++) {
    cyl(.095, .016, .27, 1.65 + i * .062, -.43, dark, stage);
  }
  const carriage = box(.68, .46, .26, .25, 2.23, -.23, dark, stage);
  carriage.name = 'zCarriage';
}

function addFocusStage(focus: THREE.Group): void {
  const { dark, silver } = materials;
  box(.8, .88, .3, .22, 3.88, -.17, dark, focus);
  for (const x of [-.12, .56]) {
    cyl(.045, 1.75, x, 4.2, .01, silver, focus);
  }
}

function addOptics(optics: THREE.Group, covers: THREE.Group): void {
  const { white, black, dark, silver, gold } = materials;
  rounded(.98, 2.94, .83, .06, .22, 4.52, .14, white, covers);
  box(.32, 2.85, .015, -.07, 4.53, .575, black, covers);
  text('Park', .5, .2, .4, 3.45, .589, covers);
  box(.46, .7, .43, .22, 5.32, .13, dark, optics);
  cyl(.19, 2.2, .22, 4.05, .25, silver, optics);
  rounded(1.04, .4, .85, .08, .22, 3.03, .2, silver, optics);
  cyl(.275, .22, .22, 2.74, .28, black, optics);
  cyl(.225, .58, .22, 2.38, .28, silver, optics);
  for (const y of [2.12, 2.18, 2.58, 2.63]) {
    cyl(.236, .025, .22, y, .28, dark, optics);
  }
  cyl(.234, .024, .22, 2.1, .28, gold, optics);
  cyl(.145, .12, .22, 2.02, .28, black, optics);
  for (const x of [-.4, .85]) {
    cyl(.075, .23, x, 3.02, .27, silver, optics, 'x');
    cyl(.09, .09, x, 3.02, .38, silver, optics, 'z');
  }
  screw(-.12, 3.03, .651, optics);
}

function addHead(head: THREE.Group): void {
  const { silver, dark, gold } = materials;
  rounded(.79, .92, .24, .22, .22, 1.97, -.22, silver, head);
  rounded(.77, .29, .67, .13, .22, 1.89, .21, silver, head);
  rounded(.5, .32, .14, .12, .22, 1.88, .61, silver, head);
  for (const x of [-.09, .53]) {
    cyl(.075, .11, x, 2.04, .49, silver, head);
    cyl(.072, .1, x, 1.75, .55, silver, head, 'z');
    screw(x, 1.86, .7, head);
  }
  const probe = new THREE.Group();
  probe.name = 'probe';
  head.add(probe);
  box(.19, .09, .21, .22, 1.68, .34, dark, probe);
  box(.028, .012, .16, .22, 1.62, .43, gold, probe);
  mesh(new THREE.ConeGeometry(.018, .05, 8), silver, probe, .22, 1.59, .5).rotation.z = Math.PI;
}

function addXyStage(stage: THREE.Group): void {
  const { silver, dark } = materials;
  rounded(1.9, .13, 1.7, .06, .1, .99, .08, silver, stage);
  box(1.55, .16, 1.24, .1, 1.14, .08, dark, stage);
  for (const x of [-.54, .73]) {
    box(.11, .12, 1.39, x, 1.2, .08, silver, stage);
  }
  box(1.31, .13, .95, .1, 1.29, .15, silver, stage);
}

function addSample(sample: THREE.Group): void {
  const { silver, black, dark } = materials;
  rounded(.61, .15, .61, .05, .22, 1.42, .36, silver, sample);
  const specimen = new THREE.Group();
  specimen.name = 'specimen';
  sample.add(specimen);
  cyl(.2, .046, .22, 1.52, .36, black, specimen);
  box(.19, .015, .19, .22, 1.55, .36, materials.specimen, specimen);
  for (const x of [-.02, .46]) {
    for (const z of [.12, .6]) {
      cyl(.025, .016, x, 1.51, z, dark, sample);
    }
  }
}

function addMisc(root: THREE.Group): void {
  const { black, silver } = materials;
  box(.3, .74, .35, -.69, 1.89, -.1, black, root);
  for (let y = 1.68; y < 2.1; y += .12) {
    box(.12, .025, .01, -.69, y, .081, silver, root);
  }
  for (const x of [-1.32, 1.32]) {
    for (const y of [1.35, 4.37]) {
      screw(x, y, -1.31, root);
    }
  }
}

function addGrille(covers: THREE.Group): void {
  for (let x = -.94; x < 1; x += .13) {
    box(.04, .67, .022, x, 2.5, -1.525, materials.dark, covers);
  }
}

/** Builds the NX10 model. Returns the root group (no lights, no floor, no camera). */
export function buildNx10Model(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'Park_NX10';
  const covers = new THREE.Group();
  covers.name = 'covers';
  root.add(covers);
  const parts = {
    optics: new THREE.Group(),
    head: new THREE.Group(),
    sample: new THREE.Group(),
    xy: new THREE.Group(),
    z: new THREE.Group(),
    focus: new THREE.Group(),
  };
  for (const [name, group] of Object.entries(parts)) {
    group.name = name;
    root.add(group);
  }

  addChassis(root, covers);
  addRearSupport(root, covers);
  addZStage(parts.z);
  addFocusStage(parts.focus);
  addOptics(parts.optics, covers);
  addHead(parts.head);
  addXyStage(parts.xy);
  addSample(parts.sample);
  addMisc(root);
  addGrille(covers);
  return root;
}

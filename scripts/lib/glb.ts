export type Vec3 = [number, number, number];
type Bounds = { min: Vec3; max: Vec3 };

export type GlbSummary = {
  generator: string | undefined;
  namedNodes: string[];
  duplicateNames: string[];
  rootNodes: string[];
  nodeCount: number;
  meshCount: number;
  animationCount: number;
  extensionsUsed: string[];
  boundingBox: Bounds | null;
  nodeBounds: Record<string, Bounds>;
};

type GltfNode = {
  name?: string;
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: Vec3;
  rotation?: [number, number, number, number];
  scale?: Vec3;
};
type GltfDocument = {
  asset?: { generator?: string };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { primitives: { attributes: { POSITION?: number } }[] }[];
  accessors?: { min?: number[]; max?: number[] }[];
  animations?: unknown[];
  extensionsUsed?: string[];
};

export function parseGlbJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength < 12) {
    throw new Error('Invalid GLB: header is shorter than 12 bytes.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) {
    throw new Error('Invalid GLB: bad magic; expected glTF.');
  }
  if (view.getUint32(4, true) !== 2) {
    throw new Error('Invalid GLB: unsupported version; expected version 2.');
  }
  if (view.getUint32(8, true) !== bytes.byteLength) {
    throw new Error('Invalid GLB: declared length does not match the buffer.');
  }

  let json: unknown;
  let hasJson = false;
  for (let offset = 12; offset < bytes.byteLength;) {
    if (offset + 8 > bytes.byteLength) {
      throw new Error('Invalid GLB: truncated chunk header.');
    }
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length;
    if (length % 4 !== 0 || end > bytes.byteLength) {
      throw new Error('Invalid GLB: unaligned or truncated chunk.');
    }
    if (type === 0x4e4f534a && !hasJson) {
      try {
        json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, end)));
      } catch (error) {
        throw new Error('Invalid GLB: could not parse the JSON chunk.', { cause: error });
      }
      hasJson = true;
    }
    offset = end;
  }
  if (!hasJson) {
    throw new Error('Invalid GLB: missing JSON chunk.');
  }
  return json;
}

function readGlbDocument(bytes: Uint8Array): GltfDocument {
  const json = parseGlbJson(bytes);
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('Invalid GLB: JSON document must be an object.');
  }
  return json as GltfDocument;
}

/** World-space subtree bounds for named nodes in the default scene. */
export function nodeBounds(bytes: Uint8Array): Record<string, { min: Vec3; max: Vec3 }> {
  return calculateBounds(readGlbDocument(bytes)).nodeBounds;
}

export function summarizeGlb(bytes: Uint8Array): GlbSummary {
  const document = readGlbDocument(bytes);
  const nodes = document.nodes ?? [];
  const roots = document.scenes?.[document.scene ?? 0]?.nodes ?? [];
  const namedNodes = nodes.flatMap(node => node.name ? [node.name] : []);
  const seenNames = new Set<string>();
  const duplicateNames = new Set<string>();
  for (const name of namedNodes) {
    if (seenNames.has(name)) duplicateNames.add(name);
    seenNames.add(name);
  }
  return {
    generator: document.asset?.generator,
    namedNodes,
    duplicateNames: [...duplicateNames].sort(),
    rootNodes: roots.map(index => getNode(nodes, index).name ?? ''),
    nodeCount: nodes.length,
    meshCount: document.meshes?.length ?? 0,
    animationCount: document.animations?.length ?? 0,
    extensionsUsed: document.extensionsUsed ?? [],
    ...calculateBounds(document),
  };
}

function getNode(nodes: GltfNode[], index: number): GltfNode {
  const node = nodes[index];
  if (!node) {
    throw new Error(`Invalid GLB: node ${index} does not exist.`);
  }
  return node;
}

function identityMatrix(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function nodeMatrix(node: GltfNode): number[] {
  if (node.matrix) return node.matrix;
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  // glTF uses column-major matrices and T * R * S composition.
  return [
    (1 - 2 * (y * y + z * z)) * sx,
    2 * (x * y + z * w) * sx,
    2 * (x * z - y * w) * sx,
    0,
    2 * (x * y - z * w) * sy,
    (1 - 2 * (x * x + z * z)) * sy,
    2 * (y * z + x * w) * sy,
    0,
    2 * (x * z + y * w) * sz,
    2 * (y * z - x * w) * sz,
    (1 - 2 * (x * x + y * y)) * sz,
    0,
    tx, ty, tz, 1,
  ];
}

function multiplyMatrices(left: number[], right: number[]): number[] {
  const result = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) {
        result[column * 4 + row] += left[k * 4 + row] * right[column * 4 + k];
      }
    }
  }
  return result;
}

function mergeBounds(target: Bounds, source: Bounds): void {
  for (let axis = 0; axis < 3; axis++) {
    target.min[axis] = Math.min(target.min[axis], source.min[axis]);
    target.max[axis] = Math.max(target.max[axis], source.max[axis]);
  }
}

function emptyBounds(): Bounds {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

function calculateBounds(document: GltfDocument): Pick<GlbSummary, 'boundingBox' | 'nodeBounds'> {
  const boundingBox = emptyBounds();
  const namedBounds = new Map<string, Bounds>();
  const ancestors = new Set<number>();

  function visit(index: number, parentMatrix: number[]): Bounds {
    if (ancestors.has(index)) {
      throw new Error(`Invalid GLB: cycle at node ${index}.`);
    }
    const node = getNode(document.nodes ?? [], index);
    const worldMatrix = multiplyMatrices(parentMatrix, nodeMatrix(node));
    const bounds = emptyBounds();
    if (node.mesh !== undefined) {
      const mesh = document.meshes?.[node.mesh];
      if (!mesh) throw new Error(`Invalid GLB: mesh ${node.mesh} does not exist.`);
      for (const primitive of mesh.primitives) {
        const position = primitive.attributes.POSITION;
        const accessor = position === undefined ? undefined : document.accessors?.[position];
        if (!accessor?.min || !accessor.max) continue;
        // Rotation or negative scale can make any of the eight corners an extremum.
        for (let corner = 0; corner < 8; corner++) {
          const x = corner & 1 ? accessor.max[0] : accessor.min[0];
          const y = corner & 2 ? accessor.max[1] : accessor.min[1];
          const z = corner & 4 ? accessor.max[2] : accessor.min[2];
          for (let axis = 0; axis < 3; axis++) {
            const value = worldMatrix[axis] * x + worldMatrix[4 + axis] * y
              + worldMatrix[8 + axis] * z + worldMatrix[12 + axis];
            bounds.min[axis] = Math.min(bounds.min[axis], value);
            bounds.max[axis] = Math.max(bounds.max[axis], value);
          }
        }
      }
    }
    ancestors.add(index);
    for (const child of node.children ?? []) {
      mergeBounds(bounds, visit(child, worldMatrix));
    }
    ancestors.delete(index);
    if (node.name && bounds.min[0] !== Infinity) {
      // Duplicate names share an entry encompassing every matching subtree.
      const combined = namedBounds.get(node.name) ?? emptyBounds();
      mergeBounds(combined, bounds);
      namedBounds.set(node.name, combined);
    }
    return bounds;
  }

  const roots = document.scenes?.[document.scene ?? 0]?.nodes ?? [];
  for (const root of roots) {
    mergeBounds(boundingBox, visit(root, identityMatrix()));
  }
  return {
    boundingBox: boundingBox.min[0] === Infinity ? null : boundingBox,
    nodeBounds: Object.fromEntries(namedBounds),
  };
}

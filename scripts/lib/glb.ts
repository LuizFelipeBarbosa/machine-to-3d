export type Vec3 = [number, number, number];
type Bounds = { min: Vec3; max: Vec3 };

export type GlbAnimationSummary = { name: string; duration: number; targetNodes: string[] };

export type GlbSummary = {
  generator: string | undefined;
  namedNodes: string[];
  duplicateNames: string[];
  rootNodes: string[];
  nodeCount: number;
  meshCount: number;
  animationCount: number;
  animations: GlbAnimationSummary[];
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
  animations?: {
    name?: string;
    channels: { target: { node?: number; path: string } }[];
    samplers: { input: number }[];
  }[];
  extensionsUsed?: string[];
};

export function parseGlbJson(bytes: Uint8Array): unknown {
  return readJsonChunk(bytes).json;
}

type JsonChunk = { offset: number; length: number; json: unknown };

function readJsonChunk(bytes: Uint8Array): JsonChunk {
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
  let jsonChunk: JsonChunk | undefined;
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
      jsonChunk = { offset, length, json };
      hasJson = true;
    }
    offset = end;
  }
  if (!hasJson) {
    throw new Error('Invalid GLB: missing JSON chunk.');
  }
  return jsonChunk!;
}

function readGlbDocument(bytes: Uint8Array): GltfDocument {
  const json = parseGlbJson(bytes);
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('Invalid GLB: JSON document must be an object.');
  }
  return json as GltfDocument;
}

export function dedupeNodeNames(bytes: Uint8Array): { bytes: Uint8Array; renamed: Record<string, string[]> } {
  const jsonChunk = readJsonChunk(bytes);
  if (typeof jsonChunk.json !== 'object' || jsonChunk.json === null || Array.isArray(jsonChunk.json)) {
    throw new Error('Invalid GLB: JSON document must be an object.');
  }
  const document = jsonChunk.json as GltfDocument;
  const nodes = document.nodes ?? [];
  const reservedNames = new Set(nodes.flatMap(node => node.name ? [node.name] : []));
  const seenNames = new Set<string>();
  const renamed: Record<string, string[]> = {};

  for (const node of nodes) {
    if (!node.name) continue;
    const originalName = node.name;
    if (!seenNames.has(originalName)) {
      seenNames.add(originalName);
      continue;
    }

    let suffix = 2;
    let newName = `${originalName}_${suffix}`;
    while (reservedNames.has(newName)) {
      suffix++;
      newName = `${originalName}_${suffix}`;
    }
    node.name = newName;
    reservedNames.add(newName);
    const names = Object.hasOwn(renamed, originalName) ? renamed[originalName] : undefined;
    if (names) {
      names.push(newName);
    } else {
      Object.defineProperty(renamed, originalName, {
        value: [newName], enumerable: true, configurable: true, writable: true,
      });
    }
  }

  if (Object.keys(renamed).length === 0) return { bytes, renamed };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(document));
  const paddedLength = Math.ceil(jsonBytes.length / 4) * 4;
  const oldChunkEnd = jsonChunk.offset + 8 + jsonChunk.length;
  const result = new Uint8Array(bytes.byteLength - jsonChunk.length + paddedLength);
  result.set(bytes.subarray(0, jsonChunk.offset), 0);
  result.set(bytes.subarray(jsonChunk.offset, jsonChunk.offset + 8), jsonChunk.offset);
  result.set(jsonBytes, jsonChunk.offset + 8);
  result.fill(0x20, jsonChunk.offset + 8 + jsonBytes.length, jsonChunk.offset + 8 + paddedLength);
  result.set(bytes.subarray(oldChunkEnd), jsonChunk.offset + 8 + paddedLength);

  const resultView = new DataView(result.buffer, result.byteOffset, result.byteLength);
  resultView.setUint32(8, result.byteLength, true);
  resultView.setUint32(jsonChunk.offset, paddedLength, true);
  return { bytes: result, renamed };
}

/** World-space subtree bounds for named nodes in the default scene. */
export function nodeBounds(bytes: Uint8Array): Record<string, Bounds>;
/** Rest-pose world bounds of the union of the requested named subtrees. */
export function nodeBounds(bytes: Buffer | Uint8Array, names: string[]): Bounds | null;
export function nodeBounds(bytes: Uint8Array, names?: string[]): Record<string, Bounds> | Bounds | null {
  const document = readGlbDocument(bytes);
  if (names === undefined) return calculateBounds(document).nodeBounds;
  const requestedNames = new Set(names);
  if (!document.nodes?.some(node => node.name && requestedNames.has(node.name))) return null;

  const boundsByName = calculateBounds(document, true).nodeBounds;
  const bounds = emptyBounds();
  for (const name of requestedNames) {
    if (Object.hasOwn(boundsByName, name)) mergeBounds(bounds, boundsByName[name]);
  }
  return bounds.min[0] === Infinity ? null : bounds;
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
    animations: summarizeAnimations(document),
    extensionsUsed: document.extensionsUsed ?? [],
    ...calculateBounds(document),
  };
}

function summarizeAnimations(document: GltfDocument): GlbAnimationSummary[] {
  return (document.animations ?? []).map(animation => {
    let duration = 0;
    for (const sampler of animation.samplers) {
      duration = Math.max(duration, document.accessors?.[sampler.input]?.max?.[0] ?? 0);
    }
    const targetNodes = new Set<string>();
    for (const channel of animation.channels) {
      const index = channel.target.node;
      const name = index === undefined ? undefined : document.nodes?.[index]?.name;
      if (name) targetNodes.add(name);
    }
    return { name: animation.name ?? '', duration, targetNodes: [...targetNodes] };
  });
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

function calculateBounds(document: GltfDocument, includeAllNodes = false): Pick<GlbSummary, 'boundingBox' | 'nodeBounds'> {
  const boundingBox = emptyBounds();
  const namedBounds = new Map<string, Bounds>();
  const ancestors = new Set<number>();
  const visited = new Set<number>();

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
    visited.add(index);
    if (node.name && bounds.min[0] !== Infinity) {
      // Duplicate names share an entry encompassing every matching subtree.
      const combined = namedBounds.get(node.name) ?? emptyBounds();
      mergeBounds(combined, bounds);
      namedBounds.set(node.name, combined);
    }
    return bounds;
  }

  const nodes = document.nodes ?? [];
  let roots = document.scenes?.[document.scene ?? 0]?.nodes ?? [];
  if (includeAllNodes) {
    const children = new Set(nodes.flatMap(node => node.children ?? []));
    roots = nodes.map((_, index) => index).filter(index => !children.has(index));
  }
  for (const root of roots) {
    mergeBounds(boundingBox, visit(root, identityMatrix()));
  }
  if (includeAllNodes) {
    // Components without a root still need to be checked for cycles.
    for (let index = 0; index < nodes.length; index++) {
      if (!visited.has(index)) mergeBounds(boundingBox, visit(index, identityMatrix()));
    }
  }
  return {
    boundingBox: boundingBox.min[0] === Infinity ? null : boundingBox,
    nodeBounds: Object.fromEntries(namedBounds),
  };
}

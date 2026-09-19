import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGlbJson } from '../../scripts/lib/glb.js';
import { validateWorkspace } from './validate.js';

function demoProcedure() {
  return {
    formatVersion: 1,
    title: 'Open the door',
    summary: 'Open the access door. Check that the chamber is accessible.',
    minutes: 1,
    start: { doorOpen: false },
    steps: [{
      id: 'demo-01', title: 'Open the door', where: 'instrument', body: 'Swing the door open.',
      parts: ['door'], view: { pos: [0, 0, 0], target: [0, 0, 0] },
      state: { doorOpen: true }, check: 'I have opened the chamber door',
      provenance: 'observed', sourceTimestamp: 1,
    }],
  };
}

function writeJson(dir: string, file: string, value: unknown): void {
  writeFileSync(join(dir, file), JSON.stringify(value));
}

describe('validateWorkspace', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kit-validation-'));
    cpSync(new URL('./template/', import.meta.url), dir, { recursive: true });
    mkdirSync(join(dir, 'procedures'), { recursive: true });
    writeJson(dir, 'procedures/demo.json', demoProcedure());
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('accepts the template with an observed door-opening procedure', () => {
    expect(validateWorkspace(dir)).toEqual({ issues: [], warnings: [] });
  });

  it('reports an unknown part', () => {
    const procedure = demoProcedure();
    procedure.steps[0].parts = ['handle'];
    writeJson(dir, 'procedures/demo.json', procedure);
    expect(validateWorkspace(dir).issues).toContain('procedures/demo.json.steps[0].parts[0]: Unknown part "handle".');
  });

  it('reports a referenced clip missing from the GLB', () => {
    const machine = JSON.parse(readFileSync(join(dir, 'machine.json'), 'utf8'));
    machine.stateVars[0].effects[0].clip = 'nope';
    writeJson(dir, 'machine.json', machine);
    expect(validateWorkspace(dir).issues).toContain('model.glb: Missing referenced clip "nope".');
  });

  it('warns about inferred steps without blocking the workspace or CLI', () => {
    const procedure = demoProcedure();
    procedure.steps[0].provenance = 'inferred';
    writeJson(dir, 'procedures/demo.json', procedure);
    const warning = 'warning: demo: step demo-01 is inferred';
    expect(validateWorkspace(dir)).toEqual({ issues: [], warnings: [warning] });
    const result = spawnSync(process.execPath, [
      '--import', 'tsx', fileURLToPath(new URL('./validate.ts', import.meta.url)), dir,
    ], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('validate: ok (1 procedures)\n');
    expect(result.stderr).toBe(`${warning}\n`);
  });

  it('reports schema problems in both machine and procedure files', () => {
    const machine = JSON.parse(readFileSync(join(dir, 'machine.json'), 'utf8'));
    machine.formatVersion = 2;
    writeJson(dir, 'machine.json', machine);
    const procedure = demoProcedure();
    procedure.minutes = 0;
    procedure.steps[0].provenance = 'guessed';
    writeJson(dir, 'procedures/demo.json', procedure);
    const { issues } = validateWorkspace(dir);
    expect(issues).toEqual(expect.arrayContaining([
      expect.stringMatching(/^machine.json.formatVersion:/),
      expect.stringMatching(/^procedures\/demo.json.minutes:/),
      expect.stringMatching(/^procedures\/demo.json.steps.0.provenance:/),
    ]));
  });

  it('reports incorrect roots, missing nodes and transform/clip conflicts', () => {
    const machine = JSON.parse(readFileSync(join(dir, 'machine.json'), 'utf8'));
    machine.rootNode = 'wrongRoot';
    machine.stateVars[0].effects.push({ type: 'translate', node: 'door', offset: [1, 0, 0] });
    machine.stateVars[0].effects.push({ type: 'visible', node: 'missingPanel' });
    writeJson(dir, 'machine.json', machine);
    expect(validateWorkspace(dir).issues).toEqual(expect.arrayContaining([
      expect.stringContaining('Expected exactly one root named "wrongRoot"'),
      'model.glb: Missing referenced node "missingPanel".',
      'model.glb: Clip "doorOpen" targets node "door", also targeted by a translate/rotate effect.',
    ]));
  });

  it('rejects two referenced clips targeting the same node', () => {
    const document = parseGlbJson(readFileSync(join(dir, 'model.glb'))) as {
      animations: { name: string }[];
    };
    document.animations.push({ ...document.animations[0], name: 'otherMotion' });
    // Summary validation needs only the JSON chunk, not the geometry's binary payload.
    const json = Buffer.from(JSON.stringify(document));
    const paddedLength = Math.ceil(json.length / 4) * 4;
    const bytes = Buffer.alloc(20 + paddedLength, 0x20);
    bytes.writeUInt32LE(0x46546c67, 0);
    bytes.writeUInt32LE(2, 4);
    bytes.writeUInt32LE(bytes.length, 8);
    bytes.writeUInt32LE(paddedLength, 12);
    bytes.writeUInt32LE(0x4e4f534a, 16);
    json.copy(bytes, 20);
    writeFileSync(join(dir, 'model.glb'), bytes);
    const machine = JSON.parse(readFileSync(join(dir, 'machine.json'), 'utf8'));
    machine.stateVars[0].effects.push({ type: 'clip', clip: 'otherMotion' });
    writeJson(dir, 'machine.json', machine);
    expect(validateWorkspace(dir).issues).toContain('model.glb: Node "door" is targeted by two referenced clips: "doorOpen" and "otherMotion".');
  });

  it('resolves links across all procedures and rejects unknown step IDs', () => {
    const linked = demoProcedure();
    linked.steps[0].id = 'other-01';
    writeJson(dir, 'procedures/other.json', linked);
    const procedure = demoProcedure();
    const link = { procedureSlug: 'other', stepId: 'other-01', label: 'Continue' };
    Object.assign(procedure.steps[0], { link });
    writeJson(dir, 'procedures/demo.json', procedure);
    expect(validateWorkspace(dir).issues).toEqual([]);
    link.stepId = 'missing';
    writeJson(dir, 'procedures/demo.json', procedure);
    expect(validateWorkspace(dir).issues).toContain('procedures/demo.json.steps[0].link.stepId: Unknown step "missing" in procedure "other".');
  });

  it('reports malformed files without throwing and permits a missing procedures folder', () => {
    rmSync(join(dir, 'procedures'), { recursive: true });
    expect(validateWorkspace(dir)).toEqual({ issues: [], warnings: [] });
    writeFileSync(join(dir, 'machine.json'), '{');
    writeFileSync(join(dir, 'model.glb'), 'bad');
    expect(validateWorkspace(dir).issues).toEqual([
      expect.stringMatching(/^machine.json:/), expect.stringMatching(/^model.glb:/),
    ]);
  });
});

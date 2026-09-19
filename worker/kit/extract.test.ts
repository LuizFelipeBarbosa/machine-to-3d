import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0 ? 'ffmpeg'
  : existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : undefined;
if (!ffmpeg) console.warn('Skipping extract.sh tests: ffmpeg was not found on PATH or at /opt/homebrew/bin/ffmpeg.');
const script = fileURLToPath(new URL('./extract.sh', import.meta.url));

describe.skipIf(!ffmpeg)('extract.sh', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kit-extract-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makeVideo(filter = 'testsrc2=size=96x64:rate=10', duration = '6', audio = true): string {
    const video = join(dir, 'input video.mp4');
    const result = spawnSync(ffmpeg!, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', filter,
      ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000'] : []),
      '-t', duration, '-c:v', 'mpeg4', '-q:v', '5', ...(audio ? ['-c:a', 'aac'] : []), video,
    ], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return video;
  }

  function extract(video: string, env = process.env) {
    const output = join(dir, 'extracted frames');
    const result = spawnSync('bash', [script, video, output], { encoding: 'utf8', env, timeout: 60_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^extract: \d+ frames; transcript /);
    const index = JSON.parse(readFileSync(join(output, 'frames/index.json'), 'utf8')) as {
      file: string; seconds: number;
    }[];
    for (const [position, frame] of index.entries()) {
      expect(frame.file).toMatch(/^f-\d{5,}\.\d{2}\.jpg$/);
      expect(existsSync(join(output, 'frames', frame.file))).toBe(true);
      if (position > 0) expect(frame.seconds).toBeGreaterThan(index[position - 1].seconds);
    }
    const transcript = JSON.parse(readFileSync(join(output, 'transcript.json'), 'utf8'));
    expect(Array.isArray(transcript.segments)).toBe(true);
    return { index, transcript, output };
  }

  it('extracts sorted frames and a transcript envelope from a six-second video', () => {
    const { index, output } = extract(makeVideo());
    expect(index.length).toBeGreaterThanOrEqual(2);
    expect(index.map(frame => frame.seconds)).toEqual(expect.arrayContaining([0, 5]));
    expect(existsSync(join(output, 'audio.wav'))).toBe(true);
  }, 60_000);

  it('caps scene-change candidates evenly across the video and accepts silent video', () => {
    const video = makeVideo("nullsrc=size=32x32:rate=1,geq=lum='if(mod(floor(N/2),2),235,16)':cb=128:cr=128", '180', false);
    const { index, transcript } = extract(video);
    expect(index).toHaveLength(80);
    expect(index[0].seconds).toBe(0);
    expect(index.at(-1)!.seconds).toBe(178);
    const candidates = Array.from({ length: 180 }, (_, seconds) => seconds)
      .filter(seconds => seconds % 2 === 0 || seconds % 5 === 0);
    expect(index.map(frame => frame.seconds)).toEqual(Array.from({ length: 80 }, (_, position) =>
      candidates[Math.round(position * (candidates.length - 1) / 79)]));
    expect(index.some(frame => frame.seconds % 5 !== 0)).toBe(true);
    expect(transcript.unavailable).toContain('no audio track');
  }, 60_000);

  it('normalizes whisper.cpp millisecond offsets when an optional CLI is available', () => {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'whisper-cli'), `#!/bin/bash
if [[ "$1" == "--help" ]]; then exit 0; fi
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-of" ]]; then
    printf '%s' '{"transcription":[{"offsets":{"from":1250,"to":2500},"text":" Open the door. "}]}' > "$2.json"
    exit 0
  fi
  shift
done
exit 1
`, { mode: 0o755 });
    const model = join(dir, 'model.bin');
    writeFileSync(model, 'test model');
    const { transcript } = extract(makeVideo(), {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, WHISPER_MODEL: model,
    });
    expect(transcript).toEqual({ segments: [{ start: 1.25, end: 2.5, text: 'Open the door.' }] });
  }, 60_000);
});

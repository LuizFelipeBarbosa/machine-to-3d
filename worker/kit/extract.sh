#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo 'Usage: extract.sh <video> <outDir>' >&2
  exit 1
fi

ffmpeg_bin=$(command -v ffmpeg || true)
if [[ -z "$ffmpeg_bin" && -x /opt/homebrew/bin/ffmpeg ]]; then
  ffmpeg_bin=/opt/homebrew/bin/ffmpeg
fi
if [[ -z "$ffmpeg_bin" ]]; then
  echo 'extract: ffmpeg is required' >&2
  exit 1
fi

# Node is supplied by the worker runtime; no Python, jq or npm packages are needed.
node --input-type=module - "$1" "$2" "$ffmpeg_bin" <<'NODE'
import { spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const [videoArgument, outputArgument, ffmpeg] = process.argv.slice(2);
const video = resolve(videoArgument);
const output = resolve(outputArgument);
mkdirSync(join(output, 'frames'), { recursive: true });
const temporary = mkdtempSync(join(output, '.extract-'));

function runFfmpeg(args, logName) {
  const log = join(temporary, logName);
  const descriptor = openSync(log, 'w');
  try {
    const result = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], {
      stdio: ['ignore', 'ignore', descriptor],
    });
    if (result.error || result.status !== 0) {
      throw new Error(result.error?.message ?? readFileSync(log, 'utf8').trim());
    }
  } finally {
    closeSync(descriptor);
  }
  return log;
}

function videoDuration() {
  const ffprobe = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', video,
  ], { encoding: 'utf8' });
  const duration = Number(ffprobe.stdout?.trim());
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function evenlyPick(items, count) {
  if (count >= items.length) return [...items];
  if (count <= 0) return [];
  if (count === 1) return [items[0]];
  return Array.from({ length: count }, (_, index) =>
    items[Math.round(index * (items.length - 1) / (count - 1))]);
}

function extractFrames() {
  const duration = videoDuration();
  const interval = Math.max(2, Math.min(10, (duration ?? 0) / 40));
  // Select the first frame, scene cuts and the first frame in each periodic bucket.
  const selection = `gt(scene,0.3)+isnan(prev_t)+gt(floor(t/${interval}),floor(prev_t/${interval}))`;
  const log = runFfmpeg([
    '-i', video, '-map', '0:v:0', '-an',
    '-vf', `setpts=PTS-STARTPTS,select='${selection}',showinfo`,
    '-fps_mode', 'vfr', '-f', 'null', '-',
  ], 'candidates.log');
  const sceneLog = runFfmpeg([
    '-i', video, '-map', '0:v:0', '-an',
    '-vf', "setpts=PTS-STARTPTS,select='gt(scene,0.3)+isnan(prev_t)',showinfo",
    '-fps_mode', 'vfr', '-f', 'null', '-',
  ], 'scenes.log');
  const scenePts = new Set();
  for (const match of readFileSync(sceneLog, 'utf8').matchAll(/\bpts:\s*(\d+)\s+pts_time:([\d.eE+-]+)/g)) {
    scenePts.add(match[1]);
  }
  const candidates = [];
  const filenames = new Set();
  for (const match of readFileSync(log, 'utf8').matchAll(/\bpts:\s*(\d+)\s+pts_time:([\d.eE+-]+)/g)) {
    const seconds = Number(match[2]);
    const file = `f-${seconds.toFixed(2).padStart(8, '0')}.jpg`;
    if (!filenames.has(file)) {
      candidates.push({ pts: match[1], seconds, file, reason: scenePts.has(match[1]) ? 'scene' : 'interval' });
      filenames.add(file);
    }
  }
  candidates.sort((left, right) => left.seconds - right.seconds);
  if (candidates.length === 0) throw new Error('No video frames found.');
  const computedCap = Math.min(240, Math.max(40, Math.ceil((duration ?? candidates.at(-1).seconds) / 1.5)));
  const configuredCap = Number.parseInt(process.env.EXTRACT_MAX_FRAMES ?? '', 10);
  const cap = Number.isInteger(configuredCap) && configuredCap > 0 ? configuredCap : computedCap;
  let selected;
  if (candidates.length <= cap) {
    selected = candidates;
  } else {
    const scenes = candidates.filter(frame => frame.reason === 'scene');
    const intervals = candidates.filter(frame => frame.reason === 'interval');
    if (scenes.length >= cap) {
      selected = evenlyPick(scenes, cap);
    } else {
      selected = [...scenes, ...evenlyPick(intervals, cap - scenes.length)];
      selected.sort((left, right) => left.seconds - right.seconds);
    }
  }

  // Decode again so only the capped subset is encoded to JPEG, preserving source PTS.
  // Keep each select expression below ffmpeg's expression-size limit for long videos.
  const encodedFiles = [];
  for (let offset = 0; offset < selected.length; offset += 80) {
    const chunk = selected.slice(offset, offset + 80);
    const filter = chunk.map(frame => `eq(pts,${frame.pts})`).join('+');
    const prefix = `frames-${offset}-`;
    runFfmpeg([
      '-loglevel', 'error', '-i', video, '-map', '0:v:0', '-an',
      '-vf', `setpts=PTS-STARTPTS,select='${filter}'`, '-fps_mode', 'vfr',
      '-q:v', '2', join(temporary, `${prefix}%03d.jpg`),
    ], `frames-${offset}.log`);
    encodedFiles.push(...readdirSync(temporary)
      .filter(file => file.startsWith(prefix) && file.endsWith('.jpg'))
      .sort()
      .map(file => join(temporary, file)));
  }
  const frames = join(output, 'frames');
  for (const file of readdirSync(frames)) {
    if (/^f-\d+\.\d{2}\.jpg$/.test(file)) rmSync(join(frames, file));
  }
  selected.forEach((frame, index) => {
    renameSync(encodedFiles[index], join(frames, frame.file));
  });
  writeFileSync(join(frames, 'index.json'), JSON.stringify(selected.map(({ file, seconds, reason }) =>
    ({ file, seconds, reason })), null, 2) + '\n');
  return selected.length;
}

function extractTranscript() {
  const audio = join(output, 'audio.wav');
  rmSync(audio, { force: true });
  try {
    runFfmpeg([
      '-loglevel', 'error', '-i', video, '-map', '0:a:0', '-vn',
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', audio,
    ], 'audio.log');
  } catch {
    rmSync(audio, { force: true });
    return { segments: [], unavailable: 'Audio extraction failed; the video may have no audio track.' };
  }

  const model = process.env.WHISPER_MODEL || join(homedir(), '.instrument-trainer/models/ggml-base.en.bin');
  const whisper = spawnSync('whisper-cli', ['--help'], { stdio: 'ignore' });
  if (whisper.error) return { segments: [], unavailable: 'whisper-cli is not available on PATH.' };
  if (!existsSync(model)) return { segments: [], unavailable: `Whisper model not found: ${model}` };

  const prefix = join(temporary, 'whisper');
  const result = spawnSync('whisper-cli', ['-m', model, '-f', audio, '-oj', '-of', prefix], {
    stdio: 'ignore',
  });
  if (result.error || result.status !== 0) {
    return { segments: [], unavailable: 'whisper-cli failed to transcribe the audio.' };
  }
  try {
    const raw = JSON.parse(readFileSync(`${prefix}.json`, 'utf8'));
    // whisper.cpp writes transcription[].offsets in milliseconds.
    // https://github.com/ggml-org/whisper.cpp/blob/master/examples/cli/cli.cpp
    const segments = raw.transcription.map(segment => {
      const start = segment.offsets?.from / 1000;
      const end = segment.offsets?.to / 1000;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start
        || typeof segment.text !== 'string') {
        throw new Error('Invalid whisper segment.');
      }
      return { start, end, text: segment.text.trim() };
    });
    return { segments };
  } catch {
    return { segments: [], unavailable: 'whisper-cli produced missing or invalid JSON.' };
  }
}

try {
  const count = extractFrames();
  const transcript = extractTranscript();
  writeFileSync(join(output, 'transcript.json'), JSON.stringify(transcript, null, 2) + '\n');
  console.log(`extract: ${count} frames; transcript ${transcript.unavailable ? `unavailable (${transcript.unavailable})` : 'available'}`);
} catch (error) {
  console.error(`extract: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
NODE

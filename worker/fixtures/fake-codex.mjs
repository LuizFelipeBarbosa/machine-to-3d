import { writeFile } from 'node:fs/promises';

const argv = process.argv.slice(2);
process.stdin.setEncoding('utf8');
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;

const mode = process.env.FAKE_CODEX_MODE;
const events = [
  process.env.FAKE_CODEX_SESSION_EVENT
    ? JSON.parse(process.env.FAKE_CODEX_SESSION_EVENT)
    : { type: 'thread.started', thread_id: 'sess-123' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'working on it' } },
  { type: 'item.completed', item: { type: 'command_execution', command: 'echo hi' } },
];
for (const event of events) console.log(JSON.stringify(event));

if (mode === 'hang' || mode === 'ignore-term') {
  if (mode === 'ignore-term') process.on('SIGTERM', () => {});
  setInterval(() => {}, 60_000);
} else if (mode === 'fail-provider'
  && argv.some((arg, index) => arg === '-c' && argv[index + 1]?.includes('model_provider'))) {
  console.error('model_provider cliproxyapi: ECONNREFUSED');
  process.exitCode = 1;
} else if (mode === 'fail-other') {
  console.error('The workspace cannot be processed.');
  process.exitCode = 1;
} else if (mode === 'fail-always') {
  console.log('Provider returned 401');
  process.exitCode = 1;
} else {
  if (mode === 'mixed-events') {
    console.log('not JSON');
    console.log('{malformed');
    console.log('null');
    console.log(JSON.stringify({ details: [{ session_id: 'later-session' }] }));
    console.log(JSON.stringify({ type: 'error', message: 'Example error' }));
    // A final unterminated line must still be delivered by readline.
    process.stdout.write(JSON.stringify({ type: 'agent_message', text: '{"last":true}' }));
  }
  const outputIndex = argv.indexOf('-o');
  if (outputIndex === -1 || !argv[outputIndex + 1]) throw new Error('Missing -o argument');
  const report = JSON.stringify({
    status: 'complete', promptLength: prompt.length, resumed: argv.includes('resume'), argv,
  });
  if (mode !== 'missing-output') {
    await writeFile(argv[outputIndex + 1], mode === 'empty-output' || mode === 'mixed-events'
      ? '' : mode === 'fenced-output' ? `\`\`\`json\n${report}\n\`\`\`` : report);
  }
}

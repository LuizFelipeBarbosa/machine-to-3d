# Worker

## What it does

The local worker polls the Convex deployment for jobs created from the app's “Draft from video” pages, prepares a per-machine workspace, extracts frames and an optional transcript from the uploaded video, and runs `codex exec` with the model kit. It verifies the outputs in code (schema validation, GLB checks, additive-model checks, and approved-procedure compatibility checks), uploads media and changed model files, and delivers a draft procedure version plus a draft machine version only when the model changed. Nothing generated becomes visible to trainees until an approver approves the procedure in the app, which also publishes its draft machine version. There is one workspace per machine at `WORKER_HOME/machines/<workspaceKey>`, where `workspaceKey` is the machine's slug; every later video job for that machine reuses it. Model changes must be additive: existing parts, state variables, and referenced clips must never be removed or renamed.

## Requirements

- Node 22+ and the repository's npm dependencies installed (`npm install` from the repo root).
- `ffmpeg` for frame and audio extraction.
- The Codex CLI, logged in. Check with `codex login status`.
- Optional: `whisper-cli` from whisper.cpp, available on `PATH`, with a model at `$WHISPER_MODEL`. The default is `~/.instrument-trainer/models/ggml-base.en.bin`, independent of `WORKER_HOME`. Without the CLI or model, the pipeline still runs and `transcript.json` contains empty `segments` and an `unavailable` reason. Missing audio, transcription failures, and invalid transcription output also use this fallback.
- Optional: CLIProxyAPI running on `127.0.0.1:8317`.

Worker runs pass `-c model_provider="cliproxyapi"` by default. If the command exits unsuccessfully within about 60 seconds and its output matches `model_provider`, `cliproxyapi`, `ECONNREFUSED`, or `401` (case-insensitive), the worker retries without that provider override, using the Codex CLI's own configured provider/login.

To use CLIProxyAPI, add this block to `~/.codex/config.toml`. Replace the placeholder with the proxy's API key from `~/.cli-proxy-api/config.yaml`:

```toml
[model_providers.cliproxyapi]
name = "CLIProxyAPI"
base_url = "http://127.0.0.1:8317/v1"
wire_api = "responses"
experimental_bearer_token = "<proxy API key>"
```

## Configuration

`worker/main.ts` reads these environment variables:

| Variable | Purpose / default |
| --- | --- |
| `WORKER_SECRET` | Required. Must equal the Convex deployment's `WORKER_SECRET`. Set the deployment value with `npx convex env set WORKER_SECRET <value>`. |
| `CONVEX_SITE_URL` | Required. The deployment's HTTP actions URL: its `.convex.site` URL for a cloud deployment, or `http://127.0.0.1:3211` for the local anonymous deployment. |
| `WORKER_HOME` | Workspace home; defaults to `~/.instrument-trainer`. |
| `WORKER_CODEX_CMD` | Overrides the `codex` executable. Useful for a stub/fixture wrapper. |
| `WORKER_POLL_MS` | Poll interval in milliseconds when no job is available; defaults to `15000`. |

`WORKER_SECRET` may be kept in `.env.local` for convenience. The worker does not load that file itself: export the values into its environment, or use Node's `--env-file=.env.local` option when launching it.

The client sends `X-Worker-Secret` on requests to the deployment. It calls these POST routes: `/worker/claim`, `/worker/heartbeat`, `/worker/event`, `/worker/stage`, `/worker/upload-url`, `/worker/deliver`, and `/worker/fail`. File bytes are posted to the storage URL returned by `/worker/upload-url`.

## Running

From the repo root, with the required environment variables set:

```sh
node --import tsx worker/main.ts
```

The startup line shows the worker ID (`<hostname>-<pid>`), repo root, and home directory:

```text
<timestamp> [info] worker <workerId> starting; repoRoot=<repoRoot>; home=<home>
```

Each stage transition and event is logged with an ISO timestamp and level. The worker claims one job at a time and sends heartbeats every 30 seconds; the claim route defaults to a 300-second lease. With no available job, it waits for `WORKER_POLL_MS` before polling again.

Stop with Ctrl-C. The SIGINT/SIGTERM handler logs `shutdown requested (<signal>)` and requests that the loop stop; the handler itself does not forcibly kill in-flight work. Interrupted jobs are resumable: after the lease expires, the same restarted worker or another worker can claim them again. A re-claimed job runs the pipeline again and reuses the machine's workspace where it exists; it does not simply skip to its last recorded stage.

## Stub mode for testing without Codex

Set `WORKER_CODEX_CMD` to an executable shell wrapper that invokes `worker/fixtures/stub-codex.mjs`, forwarding the worker's CLI arguments. For example, save the following as a wrapper, replacing `/absolute/path/to/repo`, and make it executable:

```sh
#!/bin/sh
exec node /absolute/path/to/repo/worker/fixtures/stub-codex.mjs "$@"
```

Then launch the worker with the wrapper's absolute path:

```sh
WORKER_CODEX_CMD=/absolute/path/to/stub-wrapper \
STUB_PROCEDURE_SLUG=demo \
node --import tsx worker/main.ts
```

This exercises the pipeline without an actual Codex run; extraction, verification, upload, and delivery still run. The stub copies the kit's `buildModel.ts` and `machine.json` if `buildModel.ts` is absent. It writes a two-step kit-box procedure (one observed door-opening step and one inferred logbook step), attaches the first extracted frame if available, emits a `stub-session` session event, and writes a JSON report with `modelChanged: true`. It is a kit-box fixture, so arbitrary existing machine definitions may fail verification.

| Variable / value | Effect |
| --- | --- |
| `STUB_PROCEDURE_SLUG` | Procedure slug to write; defaults to `demo`. Set it to the claimed job's procedure slug. |
| `STUB_MODE` unset/default | Reports `status: "complete"`. |
| `STUB_MODE=blocked` | Still writes the fixture output, but reports `status: "blocked"`; the pipeline fails before verification. |
| `STUB_MODE=rename-door` | Renames the `door` part to `hatch` in `machine.json` and replaces `'door'` with `'hatch'` in `buildModel.ts`. Against a current machine containing `door`, this exercises the additive-model rejection. The procedure still references `door`. |

## Workspace layout

Files are prepared or generated under `WORKER_HOME/machines/<slug>`:

```text
WORKER_HOME/machines/<slug>/
  buildModel.ts
  machine.json
  model.glb
  procedures/
    <procedureSlug>.json
  references/
    EXISTING.md
    NOTES.md
  videos/
    <procedureSlug>/
      input.<ext>
      frames/
        f-<timestamp>.jpg
        index.json
      audio.wav
      transcript.json
  package.json
  node_modules -> <repoRoot>/node_modules
  TASK.md
```

The tree includes conditional and generated files. For a new machine, workspace preparation copies `buildModel.ts` and `machine.json` from the kit. For an existing machine without local source, it restores the available source bundle. If only a published model is available, it downloads `model.glb` and `machine.json` and writes `references/EXISTING.md`, asking Codex to create compatible source. Otherwise, `model.glb` is written by the export step, not workspace preparation.

`procedures/` holds one JSON file per procedure. Approved procedures are copied in when their files are missing; a revision overwrites its target procedure file with the claimed target content. `references/` holds worker/Codex notes; the task asks Codex to record research in `NOTES.md`. Video downloads use `input.mov` for QuickTime, `input.webm` for WebM, and `input.mp4` otherwise, reusing an existing `input.*` file. Extraction writes JPEG frames and their timestamps to `frames/index.json`, plus `transcript.json`; `audio.wav` remains when audio extraction succeeds.

`TASK.md` is the rendered prompt passed to Codex. Create jobs use the `worker/kit/TASK.md` template; revision jobs use `worker/kit/REVISE.md`, but the rendered workspace file is still named `TASK.md`.

Workspace preparation writes `package.json` with `export` and `validate` scripts and a `node_modules` symlink into the repo's `node_modules`. Inside a workspace, run the same manual loop requested in the task:

```sh
npm run export
npm run validate
```

`export` runs the repo's `scripts/export-model.ts` to build `model.glb` from `buildModel.ts`. `validate` runs `worker/kit/validate.ts` on the workspace. It validates machine and procedure schemas, exactly one GLB root with the expected name, duplicate node names, referenced nodes and clips, and animation conflicts (clip targets overlapping translate/rotate effects or targets shared by two referenced clips). It also checks procedure references, including links, and warns about inferred steps. Issues cause a nonzero exit; inferred-step warnings alone do not. Fix issues, review warnings, and repeat both commands. The pipeline additionally checks additive changes and compatibility with the deployment's approved procedures.

## How a job flows

The job detail page lists these stages in this order:

1. `workspace` — Prepare or reuse the machine workspace, download inputs as needed, and render the task prompt.
2. `extract` — Runs only for `create` jobs with a video. Use ffmpeg to extract the first frame, scene changes, and frames from five-second buckets, capped at 80 JPEGs with a timestamp index; attempt the optional transcript. Up to six frames are selected as Codex image inputs.
3. `codex` — Run `codex exec` in the workspace with the model kit, asking for `buildModel.ts`, `machine.json`, `procedures/<slug>.json`, the export/validate loop, and a final JSON report.
4. `verify` — Re-export the model and validate the files, additive model changes, and approved-procedure compatibility.
5. `frame` — Assign procedure step IDs and compute camera views from the GLB, procedure, and machine definition. Revisions reuse IDs for steps whose title and body still match.
6. `upload` — Upload step media whose local paths begin with `videos/`. When the model changed, also upload the GLB and a JSON source bundle containing `buildModel.ts` and `machine.json`.
7. `done` — Delivery has completed, leaving a draft procedure and, when changed, a draft machine version. The pipeline logs an internal `deliver` stage before calling `/worker/deliver`; that route's delivery mutation sets `done`.

Codex runs use `--sandbox workspace-write`, JSON event output, the report schema via `--output-schema`, and network access enabled through the sandbox configuration. Reasoning effort defaults to `high`; the runner supports `medium`, `high`, and `xhigh` through its code options, with no effort environment variable in `worker/main.ts`. Revision jobs try `codex exec resume` with their saved session ID. If a revision exits unsuccessfully within 60 seconds with session/resume/not-found errors and has not been aborted, the pipeline retries with a fresh session and logs `Codex could not resume the session; retrying with a fresh session`.

The report is requested to match `worker/kit/report.schema.json`: completion/blocked status, whether the model changed, instrument identity and confidence, procedure slug, observed/inferred step counts, uncertainties, and notes. Verification treats the model as changed if there is no current model, the report says `modelChanged: true`, or the machine definition's content hash differs from the current definition.

A job fails on blocking validator issues, a non-additive model change, an approved procedure breaking against the new definition, a Codex report with `status: "blocked"`, `Codex did not return a JSON report` when the final message cannot be parsed as a report, or a Codex timeout (45 minutes per attempt by default). Command, download, export, and upload errors can also fail the job. For approved procedures other than the generated target, verification exempts reference-level `start` issues; schema errors and all issues in the generated procedure remain blocking. Inferred-step warnings alone do not fail verification.

## Troubleshooting

| Symptom | Meaning / action |
| --- | --- |
| HTTP 401 | The deployment's `WORKER_SECRET` is unset, the `X-Worker-Secret` header is missing, or the values differ. Check the worker environment and the selected deployment's secret. An unset local secret stops `main.ts` at startup with `WORKER_SECRET is required`. |
| HTTP 409 | The job lease was lost: another worker owns the job, or its lease expired and was reclaimed. The client turns 409 into `LeaseLostError`. A heartbeat lease loss aborts the running job; the loop avoids reporting a failure for a lease it no longer owns. |
| `Codex did not return a JSON report` | Codex's final message was not parseable JSON (or was JSON `null`). The task requires a report matching `worker/kit/report.schema.json`; inspect the last Codex messages and ensure the final answer is the report. The runner parses JSON, but does not separately validate the report against the schema; it supplies that schema to the CLI. |
| `Provider failed within 60 seconds; retrying with the default provider.` | The first command failed fast with output matching `model_provider`, `cliproxyapi`, `ECONNREFUSED`, or `401`. The worker is retrying without the `cliproxyapi` override. Check the proxy configuration/key if using it, and `codex login status` for the fallback. |

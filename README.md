# Bench guide

## What it is

Bench guide is a trainer that shows a 3D instrument beside a step-by-step procedure. Machine definitions (a GLB model plus JSON) and procedures are data. One machine workspace screen combines the 3D scene and procedure panel, so a user can explore the machine or play a procedure.

The backend has four ordered roles: `trainee`, `author`, `approver`, and `admin`. Higher roles include the permissions below them.

| Role | Backend permissions |
| --- | --- |
| Trainee | Play approved procedures, check steps, and view personal training records. |
| Author | Create, edit, save, discard, and preview procedure drafts; upload step media; create video-drafting jobs. |
| Approver | Approve procedure drafts with a change note, view all training records, and sign off another person's record. |
| Admin | Publish machine versions, upload models, and change user roles. |

Author-edited procedure versions follow `draft → approved → retired`; the seed mutations can create an approved seed version directly. Approval validates the procedure, records the approver, time, and change note, retires the previous approved version, and publishes a draft machine version attached to the procedure when needed. Machine versions are `draft` or `published`; a procedure version pins one machine version.

Training completion records the user, the exact procedure version, completion time, and self-attested checkpoints. An approver can add a sign-off identity, time, and note; a user cannot sign off their own record. Approved and retired procedure versions can be recorded.

Procedures can include a reference video and per-step frame/snapshot images. The player opens the video in a dialog and displays step media beside the step. Media is tied to procedure content by `fileId`; the seed loader converts seed paths to Convex storage IDs.

### Optional video → draft procedure pipeline

In Convex mode, an author can use **Draft from video** to upload a video for an existing machine or describe a new machine. `/jobs` lists the author's jobs (approvers see all jobs), and `/jobs/:id` shows events and stages, permits cancel/retry, and links a delivered draft to the editor. The pages enqueue work; they do not run the worker.

The local worker in `worker/` polls Convex, reuses one workspace per machine, downloads the video, extracts frames with `ffmpeg`, attempts an optional `whisper-cli` transcript, runs `codex exec`, validates the generated GLB/JSON, computes step views, uploads media and a changed model, and delivers a draft procedure plus a draft machine version when the model changed. Stages are workspace, extract, codex, verify, frame, upload, and done. Existing model parts, state variables, and referenced animation clips may not be removed or renamed. An approver must approve the procedure before trainees can see it; that approval also publishes the draft machine version.

The worker needs Node 22+, installed npm dependencies, `ffmpeg`, a logged-in Codex CLI, a Convex deployment URL, and the deployment's `WORKER_SECRET`. `whisper-cli` and its model (`$WHISPER_MODEL`) are optional; without them the pipeline keeps running with an empty transcript and an `unavailable` reason. CLIProxyAPI is optional; the worker tries its configured provider and can retry with the Codex CLI's provider. It sends authenticated POST requests to `/worker/claim`, `/worker/heartbeat`, `/worker/event`, `/worker/stage`, `/worker/upload-url`, `/worker/deliver`, and `/worker/fail`.

Stub mode is explicitly a test fixture, not a model of a real instrument: point `WORKER_CODEX_CMD` at `worker/fixtures/stub-codex.mjs`. Extraction, verification, upload, and delivery still run, but the stub writes a kit-box two-step procedure and kit-box model; arbitrary existing definitions may fail verification. `STUB_MODE=blocked` stops before verification, and `STUB_MODE=rename-door` exercises the additive-model rejection. The real path uses the Codex CLI and the real Convex routes.

See [worker/README.md](worker/README.md) for the worker's workspace layout, lease behavior, and troubleshooting details.

## Getting started

### Local demo without a backend

```sh
npm install
npm run dev
```

Leave `VITE_CONVEX_URL` empty or unset. Vite then loads the JSON, GLBs, and media under `seed/` directly. This mode has no sign-in, is read-only, and does not save training records; `/records`, `/users`, and `/jobs*` redirect to `/`. Clear an existing `VITE_CONVEX_URL` in `.env.local` and restart Vite when switching back to the demo.

### Convex

Run the repository's Convex script and keep it running:

```sh
npm run convex
```

Convex writes deployment selection and frontend connection values such as `CONVEX_DEPLOYMENT` and `VITE_CONVEX_URL` to `.env.local`. The frontend uses `VITE_CONVEX_URL` to choose backend mode. Backend environment values are deployment settings, not `VITE_` values:

| Variable | Source usage |
| --- | --- |
| `VITE_CONVEX_URL` | Frontend backend switch (`src/data/mode.ts`). Empty means demo mode. |
| `CONVEX_SITE_URL` | Convex Auth provider domain and the worker's HTTP actions URL. |
| `ADMIN_EMAIL` | The first newly registered matching email receives the `admin` role. Password sign-up does not verify email ownership. |
| `WORKER_SECRET` | Required by worker startup and every `/worker/*` route; set it only when running the worker. |
| `JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL` | Required by Convex Auth (read by the @convex-dev/auth library). Generate the RS256 key pair with `npx @convex-dev/auth` (or a short jose script: exportPKCS8 for JWT_PRIVATE_KEY, exportJWK → {keys:[{use:'sig',...}]} for JWKS) and set them with `npx convex env set`; `SITE_URL` is the app's origin used by auth flows. Never put them in the frontend bundle. |

The installed Convex Auth package provides `npx @convex-dev/auth` for its deployment setup. Set `ADMIN_EMAIL` before the intended admin registers. In another terminal run `npm run dev`. To run the video worker, set `CONVEX_SITE_URL` to the deployment's `.convex.site` URL (or `http://127.0.0.1:3211` for local anonymous Convex), set the same `WORKER_SECRET` in Convex and the worker environment, then run:

```sh
node --import tsx worker/main.ts
```

The worker also accepts `WORKER_HOME` (default `~/.instrument-trainer`), `WORKER_CODEX_CMD` (an alternate Codex executable or test wrapper), `WORKER_CODEX_PROVIDER` (`cliproxyapi` or `default`), and `WORKER_POLL_MS` (default `15000`).

### Seeding

Validate or load every entry in `seed/manifest.ts` with:

```sh
npx tsx scripts/seed.ts --dry-run
npx tsx scripts/seed.ts
npx tsx scripts/seed.ts --force
```

The script validates machine and procedure schemas, GLB roots/nodes/clips, media paths, and procedure links before any deployment write. `--dry-run` makes no deployment calls. During a real seed, relative `.mp4`, `.jpg`, `.jpeg`, and `.png` references under each machine directory are uploaded once, then rewritten to storage IDs; the local demo keeps the relative paths.

Machine content is compared by definition with object-key order ignored. A changed definition creates a new machine version; an unchanged definition does not, even if only the GLB bytes changed. A procedure is seed-managed only when its approved version and all existing versions have `changeNote: "Seeded"` and no `createdBy`. Changed seed-managed content creates the next approved version and retires the old one. Human-authored procedures are left alone. `--force` deletes open drafts and can reset those procedures, using `Seeded (forced reset)` when it creates a replacement; the script prints a development-only warning but does not enforce the deployment type.

## Using the app

| Path | Screen | Purpose |
| --- | --- | --- |
| `/` | Machines | List machines and their procedures. |
| `/m/:machine` | Workspace, explore mode | Inspect a machine without selecting a procedure. |
| `/m/:machine/:procedure` | Workspace, procedure mode | Play the approved procedure (or a selected version preview). |
| `/m/:machine/:procedure/edit` | Editor | Authors edit drafts; approvers can approve them. |
| `/records` | Records | Trainees see their records; approvers see all records and sign-off controls. Backend mode only. |
| `/jobs` | Jobs | List video-drafting jobs. Author and approver access differs as described above. |
| `/jobs/new` | Draft from video | Upload a video for an existing or new machine. |
| `/jobs/:id` | Job detail | Show stages/events; cancel queued or running jobs and retry failed jobs. |
| `/users` | Users | Admin-only role management. |
| `/admin/machines` | Machines admin | Admin-only GLB and machine-definition validation and publishing. |
| `/sign-in` | Redirect | Redirects to `/`; unauthenticated backend sessions show the sign-in form before app routes. |

In the workspace, the procedure selector switches between **Explore the machine** and procedures without remounting the 3D scene. Explore mode exposes every state variable as a checkbox or fraction slider and has **Reset view**. Clicking a named part opens the part inspector with its label and description. Procedure mode applies each step's state, moves to its inline camera view, highlights referenced parts, and exposes only state variables marked `userToggle`; **Back to step view** restores the step camera.

The player can move back and forward, requires a checked checkpoint before advancing past a checkpoint step, follows links to another procedure or step, opens the **Reference video**, and shows step images with alt text. Completion sends the checked stable step IDs to the backend in Convex mode.

The editor creates a draft from an existing version or starts a first draft. Backend edits autosave after 1.5 seconds; **Save now**, **Preview**, **Discard draft**, and **Approve…** are available through the version bar. Preview saves pending edits and opens a “Draft preview — not recorded” workspace. Approve requires a non-empty change note. A step's screenshot/media field uploads through the media upload endpoint and stores `{ fileId, alt }`; local-demo edits are not persisted.

The admin machine screen accepts a slug, name, kind, GLB, and pasted `machine.json`. It parses the definition, checks the GLB root and referenced nodes/clips in the browser, shows a state-toggle preview, uploads the model, and publishes a new version. Existing draft machine versions can also be published from the version list.

## Content model

**Machine definition (`shared/machine.ts`).** `formatVersion: 1` contains a `rootNode`, ordered `parts` (`name`, `label`, `blurb`), named `presetViews`, and `stateVars`. A state variable is a `toggle` or a 0–1 `fraction`, may be `userToggle`, and has effects:

- `visible` shows a node only while the value is on.
- `translate` adds an offset scaled by the eased value.
- `rotate` applies an angle in radians around an axis (`x`, `y`, or `z`).
- `clip` scrubs a named GLB animation clip to value × clip duration.

**Procedure content (`shared/procedure.ts`).** `formatVersion: 1` contains a title, summary, positive `minutes`, optional `video`, an absolute `start` state, and ordered steps. Every step has a stable `id`, title, location (`instrument`, `software`, or `logbook`), body, referenced parts, and an inline `{ pos, target }` view. Optional fields are absolute-set `state` values, `caution`, checkpoint `check`, `link` (`procedureSlug` plus optional stable `stepId`), `media` (`fileId`, `alt`), provenance, uncertainty, and source timestamp. The procedure-level `video` has a `fileId` and optional label.

Versions connect the models: each procedure version stores the procedure content and the machine-version ID it uses; a machine version stores one GLB storage ID and one machine definition. Training records point to a procedure version, so later edits do not rewrite what someone completed.

## Seeded content

The table lists every entry in `seed/manifest.ts`; procedure titles are read from the referenced JSON files.

| Slug | Name | Kind | Procedure title(s) |
| --- | --- | --- | --- |
| `park-nx10` | Park NX10 | Atomic force microscope | `nc-scan` — Non-contact topography scan; `probe-exchange` — Probe exchange; `shutdown` — End of session |
| `zeiss-axioscope-5` | ZEISS Axioscope 5 | Upright light microscope | `brightfield-imaging` — Brightfield imaging of a slide; `end-of-session` — End of session |
| `hq-graphene-transfer` | HQ Graphene manual transfer system | 2D-material transfer station | `dry-transfer` — Dry transfer of a 2D material; `end-of-session` — End of session |
| `nanofrazor` | NanoFrazor benchtop | Thermal scanning-probe lithography | `load-and-pattern` — Load a sample and pattern a surface; `end-of-session` — End of session |
| `plasma-etch-pe25` | Plasma Etch PE-25 | Benchtop plasma cleaner | `plasma-clean` — Clean samples with plasma; `end-of-session` — End of session |
| `horiba-labram-odyssey` | HORIBA LabRAM Odyssey | Raman microscope | `raman-spectrum` — Acquire a Raman spectrum; `end-of-session` — End of session; `spectrometer-interior` — Inside the spectrometer (model only) |
| `nexdep` | Angstrom Nexdep | Thin-film deposition system | `evaporation-run` — Run a thin-film evaporation; `end-of-session` — End of session |
| `ppms-dynacool` | Quantum Design PPMS DynaCool | Physical property measurement system | `mount-and-measure` — Mount a puck and measure properties; `end-of-session` — End of session |
| `rise-raman-sem` | RISE Raman-SEM | Correlative Raman + scanning electron microscope | `sem-raman-correlation` — Correlate SEM images and Raman spectra; `end-of-session` — End of session |
| `teslatronpt-plus` | TeslatronPT Plus | Cryogen-free superconducting magnet system | `cooldown-and-sweep` — Cool down a sample and sweep field; `end-of-session` — End of session |
| `photo-clamshell` | Photo-clamshell split tube furnace | Split-tube furnace | `sulfurization-anneal` — Sulfurization and anneal run; `end-of-session` — End of session |
| `camera-demonstration` | Canon EOS 60D (reconstruction) | DSLR camera — demonstration | `battery-card-and-monitor` — Battery, memory card and monitor handling |
| `logitech-k400-plus` | Logitech K400 Plus (reconstruction) | Wireless keyboard — demonstration | `battery-access` — Battery access and replacement |

Lab-instrument procedures are placeholders drawn from general lab practice. They contain `(SOP: __)` blanks where a real site SOP reference or parameter must be supplied. The photo-clamshell/split-tube furnace entry is the lab's own real 14-step set; its published sequence holds sulfurization at 700 °C for 10 minutes, flushes with argon, then holds the anneal at 900 °C for 5 minutes. The camera-demonstration and logitech-k400-plus entries are educational reconstructions of demonstration videos, not real lab instruments or vetted procedures.

## Tooling

These are direct CLI commands; they are not npm scripts.

```text
npx tsx scripts/capture-glb.ts <input.html> --root <RootNodeName> --out <output.glb>
node --import tsx scripts/inspect-glb.ts <file.glb> [--root <name>] [--require <name,name,...>] [--require-clip <name,name,...>] [--nodes] [--json]
node --import tsx scripts/dedupe-glb-names.ts <in.glb> [--out <out.glb>]
npx tsx scripts/export-nx10.ts [--out seed/park-nx10/model.glb]
node --import tsx scripts/export-model.ts <buildModel.ts> --out <file.glb>
npx tsx scripts/seed.ts [--dry-run] [--force]
```

`capture-glb` loads a procedural HTML page in headless Chromium and captures the named root. `inspect-glb` reports the summary and checks exactly one root, optional root name, comma-separated node names, comma-separated clip names, and optional node bounds/JSON output. `dedupe-glb-names` rewrites duplicate node names in place unless `--out` is supplied. `export-nx10` exports the Park NX10 page, and `export-model` imports a `buildModel.ts` module whose `buildModel()` returns a root and clips. Capture/export commands need Playwright's Chromium installation.

## Testing

```sh
npm test
npm run e2e
npm run e2e:update
```

Vitest has a `node` project for `shared/`, `scripts/`, `worker/`, `seed/`, and `src/` tests, and a `convex` project using `edge-runtime` and `convex-test` for `convex/` tests. Convex tests need generated bindings from `npm run convex` or `npx convex codegen`.

The Playwright Chromium project runs at `http://localhost:5175` with `VITE_CONVEX_URL=''`, a 1400×860 viewport, and software ANGLE/SwiftShader rendering. The screenshot suite visits every seeded machine explorer and every step of every seeded procedure, plus dark/narrow NX10 cases and a linked-step jump. Baselines are under `tests/e2e/__screenshots__/`; run `npm run e2e:update` to regenerate them.

## Repository layout

- `.convex/` — Local Convex deployment state when configured.
- `.git/` — Git metadata.
- `convex/` — Schema, backend queries/mutations, auth, worker routes, and Convex tests.
- `dist/` — Vite build output when generated.
- `machines/` — Procedural Three.js source pages used to author models.
- `node_modules/` — Installed npm dependencies.
- `public/` — Static public assets.
- `scripts/` — Seed, GLB capture/inspection/deduplication, and model-export CLIs.
- `seed/` — Manifest, per-machine GLBs/definitions/procedures, and seed media.
- `shared/` — Zod schemas and validation/state helpers shared across app, scripts, worker, and backend.
- `src/` — Vite/React routes, workspace, player, editor, admin screens, data access, and styles.
- `test-results/` — Playwright output when tests produce it.
- `tests/` — Playwright end-to-end tests and screenshot baselines.
- `worker/` — Local video-to-draft worker, model kit, fixtures, and worker tests.

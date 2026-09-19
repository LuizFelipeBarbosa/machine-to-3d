# Instrument trainer

## What it is

This training app shows a 3D instrument beside a step-by-step procedure.
Machine definitions and procedure content are separate data.
The workspace reads those definitions to display parts, camera views, state changes, and instructions.

## Quick start (local demo, no backend)

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. With `VITE_CONVEX_URL` unset or empty, the app reads the content under `seed/` without sign-in; seed content is read-only and completions are not saved to the backend. If `.env.local` already sets that variable, clear it and restart Vite to use the demo. `.env.example` documents this switch.

## Running with the backend (Convex)

From the repository root, start Convex and keep it running:

```sh
npx convex dev
```

The setup offers an account-free local deployment as well as Convex cloud setup. It configures the deployment, generates `convex/_generated`, and writes deployment selection and frontend connection settings to `.env.local`: `CONVEX_DEPLOYMENT` and `VITE_CONVEX_URL` (and, when supplied, `VITE_CONVEX_SITE_URL`, the HTTP actions URL). The app uses `VITE_CONVEX_URL` to select backend mode.

Set these variables in the **Convex deployment environment**, not in the frontend bundle:

| Variable | Purpose |
| --- | --- |
| `JWT_PRIVATE_KEY` | Convex Auth's RS256 private signing key, exported as PKCS8 PEM. |
| `JWKS` | JSON public JWK set corresponding to that key. |
| `SITE_URL` | The app's origin, matching the Vite URL locally or the hosted frontend origin, for auth redirects/callbacks. |
| `ADMIN_EMAIL` | Email of the account that should receive the initial admin role. |

The installed Convex Auth package includes its setup CLI:

```sh
npx @convex-dev/auth
```

Run it after configuring the deployment; it generates and sets `JWT_PRIVATE_KEY` and `JWKS` and prompts for `SITE_URL`. Auth wiring already exists in `convex/auth.ts`, `convex/auth.config.ts`, and `convex/http.ts`; retain the app's Password provider and role-assignment callback. `convex/auth.config.ts` reads Convex's `CONVEX_SITE_URL`, which is distinct from the frontend's `SITE_URL`.

Set `ADMIN_EMAIL` in the deployment's environment settings **before registration**. The first account registered with that email becomes admin; other new accounts start as trainees. Password sign-up does not verify email ownership, so the real admin must sign up immediately after deploying and setting `ADMIN_EMAIL`. `.env.example` only documents this server setting in a comment; it does not assign it.

Start or restart `npm run dev` in another terminal, open its URL, and register the admin account.

## Seeding

Usage: `npx tsx scripts/seed.ts [--dry-run] [--force]`. Load the seed content into the configured deployment:

```sh
npx tsx scripts/seed.ts --dry-run
npx tsx scripts/seed.ts
```

`--dry-run` validates offline without deployment calls. Before any writes, the script validates all manifest entries: machine and procedure JSON against shared Zod schemas, GLB roots and referenced node names, and procedure references (including links to procedures and step IDs).

Seeding is idempotent: missing machines and procedures are created by slug, with initial versions; new procedures start at approved version 1. An existing machine receives a new published version only when its definition content differs from the current version, using key-order-insensitive deep equality. Otherwise it remains unchanged; changing only the GLB does not trigger an update.

An existing procedure is **seed-managed** only when it has an approved version and every existing version has `changeNote: "Seeded"` and no `createdBy` (no human-authored version). If its content differs from the currently approved version, again ignoring object key order, seeding inserts approved version N+1 (after the highest existing version number) and retires the previous approved version. Equal content remains unchanged. Any procedure with a human-authored version is left untouched unless `--force` is passed.

`--force` is a development-only escape hatch, not restricted to development deployments by the code. It overrides that protection and deletes open (`draft`-status) versions of existing procedures it processes. When content differs, it publishes a new approved version and retires the old approved version; an update overriding human-authored protection has change note `Seeded (forced reset)`. If approved content already matches, it creates no new version, but still deletes drafts.

## Roles and workspace

Roles inherit the permissions of every lower role; these permissions are enforced by the backend:

| Role | Permissions added |
| --- | --- |
| `trainee` | Sign in, play approved procedures, self-attest checkpoints, and view own training records. |
| `author` | Create/edit/discard procedure drafts via `procedures.create`, `createDraft`, `saveDraft`, and `discardDraft`; upload media via `files.generateUploadUrl` with kind `media`. |
| `approver` | Approve drafts via `procedures.approve`, view all records via `training.listAll`, and sign off another person's record via `training.signOff`. |
| `admin` | Publish machine versions via `machines.publishVersion`, upload models via `files.generateUploadUrl` with kind `model`, and manage roles via `users.list`/`users.setRole`. |

`/` lists machines. A single workspace route, `/m/:machine/:procedure?`, mounts `MachineWorkspace`: `/m/:machine` opens “Explore the machine” with nothing selected, and `/m/:machine/:procedure` plays the selected procedure in place (the approved version in backend mode). The side panel's procedure `<select>` (`ProcedurePicker`) switches between exploration and procedures, or between procedures. `MachineScene` stays mounted throughout those switches; the 3D scene does not remount.

In backend mode, authors and higher roles can add `?version=<versionId>` to preview a specific procedure version, including a draft, without recording training. The UI also exposes `/records`, admin-only role management at `/users`, and admin-only machine publishing at `/admin/machines` (shown as “Machines admin” in the nav). In demo mode, `/records` and `/users` redirect to `/`. `/sign-in` redirects to `/`; unauthenticated backend sessions show the sign-in form before the app routes.

Authors open `/m/:machine/:procedure/edit` to create a draft from any existing version, or start a first draft if no versions exist. In backend mode, edits autosave with a 1.5 second debounce. "Preview" saves pending edits and opens `/m/:machine/:procedure?version=<draftVersionId>` in the workspace, which shows a "Draft preview — not recorded" banner and does not save a training record. Approvers approve a draft with a required, non-empty change note; approval retires the previously approved version and promotes the draft. Steps located "In the control software" (`StepLocation` `software`) can carry an uploaded screenshot in the step's `media` field.

## Content model

**Machine definition:** `seed/<slug>/machine.json` follows `shared/machine.ts`, with `formatVersion: 1`, a GLB `rootNode`, ordered `parts` (`name`, `label`, `blurb`), named `presetViews` with camera `pos` and `target`, and boolean `stateVars` of kind `toggle`.

Each state variable has effects referencing named GLB nodes or animation clips:

- `visible`: show the node only while the variable is on.
- `translate`: apply an additive `offset: [x, y, z]` scaled by the eased state value.
- `rotate`: apply `angle` in radians around the node's origin on axis `x`, `y`, or `z`, scaled by the eased state value.
- `clip`: scrub a named GLB animation clip to the eased state value multiplied by its duration.

`userToggle: true` lets the trainee flip the variable directly in the player UI; otherwise it changes through procedure state. A backend machine version pins one GLB plus one machine definition.

**Procedure content:** `seed/<slug>/procedures/<procedure-slug>.json` follows `shared/procedure.ts`, with `formatVersion: 1`, `title`, `summary`, positive integer `minutes`, initial boolean `start` state, and ordered `steps`.

Each step has a stable `id` (never an array index), `title`, `where` (`instrument`, `software`, or `logbook`), `body`, referenced `parts`, and an inline camera `view: { pos, target }`. Optional fields include `caution`, checkpoint prompt `check`, `media: { fileId, alt }`, and `link: { procedureSlug, stepId?, label }` to another procedure on the same machine. Links identify steps by slug plus stable step ID, never by index.

A step's optional `state` is an **absolute set**: `{ "lift": true }` means lift is on from that step onward, regardless of its prior value. Repeating the value is a no-op; list only variables that change.

**Lifecycle:** procedure versions pin a machine version and move from **draft → approved → retired**. Authors create and save drafts; approval validates references, records the approver/time/change note, and retires the previously approved version. Subsequent edits use a new draft.

**Training records:** completion is self-declared and stores the user, exact procedure version, completion time, and checkpoints as `{ stepId, at }`. These are trainee attestations. Checkpoints are deduplicated by step ID; completion is rejected if the resulting count exceeds the procedure's step count, so a record cannot contain more checkpoints than the procedure has steps. A second person with approver or admin permissions can add a sign-off identity, time, and optional note; users cannot sign off their own records.

## Adding a machine

1. Author a GLB with exactly one named scene root and named part/effect nodes matching `machine.json`.
2. For procedural three.js HTML pages under `machines/`, use `scripts/capture-glb.ts`. It captures the named root in headless Chromium with three.js r128 and its `GLTFExporter`/`OrbitControls` from `three-r128`.
3. Inspect the GLB to confirm the root and required node names. The hand-ported NX10 has a separate exporter that starts Vite and opens `seed/park-nx10/export.html` in headless Chromium.

### Tools

Tool usage (replace angle-bracket placeholders; square brackets denote optional arguments):

```text
npx tsx scripts/capture-glb.ts <input.html> --root <RootNodeName> --out <output.glb>
npx tsx scripts/inspect-glb.ts <file.glb> [--root <name>] [--require <name,name,...>] [--require-clip <name,name,...>] [--nodes] [--json]
npx tsx scripts/export-nx10.ts [--out seed/park-nx10/model.glb]
```

`inspect-glb.ts` checks for exactly one scene root; `--root` checks its name, and `--require` checks comma-separated node names. `--nodes` adds world-space bounds for named nodes; `--json` emits the structured summary. `--require-clip` checks comma-separated animation clip names. Duplicate node names are errors in both this tool and seed validation; both use `summarizeGlb` from `scripts/lib/glb.ts`.

Capture/export require Playwright's Chromium browser to be installed. Put the resulting `model.glb` and `machine.json` in `seed/<slug>/`, add any procedure JSON under `procedures/`, and add a `SEED_MACHINES` entry in `seed/manifest.ts` with `slug`, `name`, `kind`, `dir`, and `procedureSlugs`. Run `npx tsx scripts/seed.ts --dry-run`, then seed the backend if needed. The local demo consumes the same manifest directly.

In backend mode, `/admin/machines` lets an admin upload a GLB and paste its `machine.json` definition. It validates referenced node names against the GLB in the browser via `useGlbCheck`, shows a live 3D preview with state-variable toggles via `DefinitionPreview`, and publishes a new machine version via `machines.publishVersion` after uploading the model through `files.generateUploadUrl`.

## Drafting procedures from video

The local worker polls Convex for jobs from the app's “Draft from video” pages,
extracts video references, and runs Codex to produce and verify a procedure draft
and, when the model changes, a machine draft in a reused per-machine workspace.
Generated content becomes visible to trainees only after an approver approves
the procedure in the app, which also publishes its draft machine version.

See [worker/README.md](worker/README.md) for requirements, configuration, running
the worker, stub testing, workspace layout, job stages, and troubleshooting.

## Seed content inventory

All 11 machines in `seed/manifest.ts` have procedures. Titles below come from their procedure JSON files.

| Machine slug | Name | Kind | Procedures: slug — title |
| --- | --- | --- | --- |
| `park-nx10` | Park NX10 | Atomic force microscope | `nc-scan` — “Non-contact topography scan”; `probe-exchange` — “Probe exchange”; `shutdown` — “End of session” |
| `zeiss-axioscope-5` | ZEISS Axioscope 5 | Upright light microscope | `brightfield-imaging` — “Brightfield imaging of a slide”; `end-of-session` — “End of session” |
| `hq-graphene-transfer` | HQ Graphene manual transfer system | 2D-material transfer station | `dry-transfer` — “Dry transfer of a 2D material”; `end-of-session` — “End of session” |
| `nanofrazor` | NanoFrazor benchtop | Thermal scanning-probe lithography | `load-and-pattern` — “Load a sample and pattern a surface”; `end-of-session` — “End of session” |
| `plasma-etch-pe25` | Plasma Etch PE-25 | Benchtop plasma cleaner | `plasma-clean` — “Clean samples with plasma”; `end-of-session` — “End of session” |
| `horiba-labram-odyssey` | HORIBA LabRAM Odyssey | Raman microscope | `raman-spectrum` — “Acquire a Raman spectrum”; `end-of-session` — “End of session”; `spectrometer-interior` — “Inside the spectrometer (model only)” |
| `nexdep` | Angstrom Nexdep | Thin-film deposition system | `evaporation-run` — “Run a thin-film evaporation”; `end-of-session` — “End of session” |
| `ppms-dynacool` | Quantum Design PPMS DynaCool | Physical property measurement system | `mount-and-measure` — “Mount a puck and measure properties”; `end-of-session` — “End of session” |
| `rise-raman-sem` | RISE Raman-SEM | Correlative Raman + scanning electron microscope | `sem-raman-correlation` — “Correlate SEM images and Raman spectra”; `end-of-session` — “End of session” |
| `teslatronpt-plus` | TeslatronPT Plus | Cryogen-free superconducting magnet system | `cooldown-and-sweep` — “Cool down a sample and sweep field”; `end-of-session` — “End of session” |
| `photo-clamshell` | Photo-clamshell split tube furnace | Split-tube furnace | `sulfurization-anneal` — “Sulfurization and in-situ anneal of MoSe₂”; `end-of-session` — “End of session” |

### Placeholder content

**All seeded procedures across all 11 machines are illustrative placeholder content written from general laboratory practice, not manufacturer or lab-specific official SOPs.** Each has been technically reviewed once for plausibility and consistency; this does not make them validated SOPs. Many steps contain literal SOP blanks beginning `(SOP: __` (with units or ranges). Instrument owners or lab staff must fill these in with site-specific parameters before use.

The Plasma Etch PE-25 cleaning procedure assumes manual PLC sequencing of pumping, gas, RF, and venting. Owners must confirm the installed unit's mode; units configured for an automatic PLC cycle require their owner-approved automatic-cycle SOP instead.

The photo-clamshell furnace’s sulfurization-anneal procedure follows the published sequence reported in Nano Lett. 2025, 25, 10123: a 700 °C / 10 min sulfurization step, a precursor purge, and a 900 °C / 5 min in-situ anneal, with flows and ramp rates left as blanks for the instrument owner to fill in.

## Testing

```sh
npm test
npm run e2e
npm run e2e:update
```

Vitest has two projects: `node` covers tests under `shared/`, `scripts/`, `seed/`, and `src/`; `convex` uses `convex-test` in `edge-runtime`. Convex tests require `convex/_generated`, produced by running `npx convex dev` or `npx convex codegen` at least once. There is no separate npm codegen script.

Playwright captures every step of every seeded procedure, plus each machine's explorer (“Explore the machine”) view. It requires Chromium and runs screenshot tests from `tests/e2e/`, with baselines in `tests/e2e/__screenshots__/`; `npm run e2e:update` updates those baselines. Its web server uses port 5175 with `VITE_CONVEX_URL=''`, so tests exercise the local seed-backed demo. If reusing an existing server on that port, ensure it is also in demo mode. Chromium uses ANGLE/SwiftShader software rendering (`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`) for reproducible screenshots without a GPU.

## Repository layout

- `convex/` — Backend functions, schema, authentication, authorization, tests, and generated API bindings.
- `machines/` — Procedural three.js source pages and captured GLBs used to author instruments.
- `public/` — Static favicon and icon assets.
- `scripts/` — Seed, capture, inspect, and NX10 export CLI tools, plus GLB helpers/tests.
- `seed/` — Per-machine JSON/GLB content, procedures, manifest, and validation tests; read by the demo and loaded into Convex by the seed script.
- `shared/` — Zod schemas and validation/state helpers shared across the app, scripts, and Convex.
- `src/` — Vite/React app: routes, machine workspace, player panel, editor, 3D scene, auth, data access, and styles.
- `tests/` — Playwright screenshot suite under `tests/e2e/`.
- `dist/` — Generated frontend build output, when present.
- `node_modules/` — Installed dependencies, when present.
- `.convex/` — Local Convex deployment state, when configured.
- `.git/` — Git repository metadata.

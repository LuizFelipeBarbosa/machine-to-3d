# Instrument trainer

## What it is

This training app shows a 3D instrument beside a step-by-step procedure.
Machine definitions and procedure content are separate data.
The player is generic: it reads those definitions to display parts, camera views, state changes, and instructions.

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

Start or restart `npm run dev` in another terminal, open its URL, and register the admin account. Load the seed content into the configured deployment:

```sh
npx tsx scripts/seed.ts --dry-run
npx tsx scripts/seed.ts
```

The dry run validates offline without deployment calls. Before any writes, the script validates all manifest entries: machine and procedure JSON against shared Zod schemas, GLB roots and referenced node names, and procedure references. Seeding is idempotent: it creates missing machines and procedures by slug, with initial versions, and skips existing entries rather than overwriting edits. Seed procedures are inserted as approved version 1.

Roles inherit the permissions of every lower role; these permissions are enforced by the backend:

| Role | Permissions added |
| --- | --- |
| `trainee` | Sign in, play approved procedures, self-attest checkpoints, and view own training records. |
| `author` | Create/edit/discard procedure drafts via `procedures.create`, `createDraft`, `saveDraft`, and `discardDraft`; upload media via `files.generateUploadUrl` with kind `media`. |
| `approver` | Approve drafts via `procedures.approve`, view all records via `training.listAll`, and sign off another person's record via `training.signOff`. |
| `admin` | Publish machine versions via `machines.publishVersion`, upload models via `files.generateUploadUrl` with kind `model`, and manage roles via `users.list`/`users.setRole`. |

The UI exposes records at `/records` and admin role management at `/users`. The editor route `/m/:machine/:procedure/edit` exists, but its save callback is currently unset; backend draft operations are available separately.

## Content model

**Machine definition:** `seed/<slug>/machine.json` follows `shared/machine.ts`, with `formatVersion: 1`, a GLB `rootNode`, ordered `parts` (`name`, `label`, `blurb`), named `presetViews` with camera `pos` and `target`, and boolean `stateVars` of kind `toggle`.

Each state variable has effects referencing named GLB nodes:

- `visible`: show the node only while the variable is on.
- `translate`: apply an additive `offset: [x, y, z]` scaled by the eased state value.
- `rotate`: apply `angle` in radians around the node's origin on axis `x`, `y`, or `z`, scaled by the eased state value.

`userToggle: true` lets the trainee flip the variable directly in the player UI; otherwise it changes through procedure state. A backend machine version pins one GLB plus one machine definition.

**Procedure content:** `seed/<slug>/procedures/<procedure-slug>.json` follows `shared/procedure.ts`, with `formatVersion: 1`, `title`, `summary`, positive integer `minutes`, initial boolean `start` state, and ordered `steps`.

Each step has a stable `id` (never an array index), `title`, `where` (`instrument`, `software`, or `logbook`), `body`, referenced `parts`, and an inline camera `view: { pos, target }`. Optional fields include `caution`, checkpoint prompt `check`, `media: { fileId, alt }`, and `link: { procedureSlug, stepId?, label }` to another procedure on the same machine. Links identify steps by slug plus stable step ID, never by index.

A step's optional `state` is an **absolute set**: `{ "lift": true }` means lift is on from that step onward, regardless of its prior value. Repeating the value is a no-op; list only variables that change.

**Lifecycle:** procedure versions pin a machine version and move from **draft → approved → retired**. Authors create and save drafts; approval validates references, records the approver/time/change note, and retires the previously approved version. Subsequent edits use a new draft.

**Training records:** completion stores the user, exact procedure version, completion time, and self-declared checkpoints as `{ stepId, at }`. These are trainee attestations. A second person with approver or admin permissions can add a sign-off identity, time, and optional note; users cannot sign off their own records.

## Adding a machine

1. Author a GLB with exactly one named scene root and named part/effect nodes matching `machine.json`.
2. For procedural three.js HTML pages under `machines/`, use `scripts/capture-glb.ts`. It captures the named root in headless Chromium with three.js r128 and its `GLTFExporter`/`OrbitControls` from `three-r128`.
3. Inspect the GLB to confirm the root and required node names. The hand-ported NX10 has a separate exporter that starts Vite and opens `seed/park-nx10/export.html` in headless Chromium.

Tool usage (replace angle-bracket placeholders; square brackets denote optional arguments):

```text
npx tsx scripts/capture-glb.ts <input.html> --root <RootNodeName> --out <output.glb>
npx tsx scripts/inspect-glb.ts <file.glb> [--root <name>] [--require <name,name,...>] [--json]
npx tsx scripts/export-nx10.ts [--out seed/park-nx10/model.glb]
```

Capture/export require Playwright's Chromium browser to be installed. Put the resulting `model.glb` and `machine.json` in `seed/<slug>/`, add any procedure JSON under `procedures/`, and add a `SEED_MACHINES` entry in `seed/manifest.ts` with `slug`, `name`, `kind`, `dir`, and `procedureSlugs`. Run `npx tsx scripts/seed.ts --dry-run`, then seed the backend if needed. The local demo consumes the same manifest directly.

Uploading through an admin machine-upload page is **planned**; no such route exists yet. The admin backend APIs `files.generateUploadUrl` and `machines.publishVersion` already exist. The manifest currently lists ten machines; only `park-nx10` has procedures (`nc-scan`, `probe-exchange`, `shutdown`), and the other entries have empty `procedureSlugs`.

## Testing

```sh
npm test
npm run e2e
npm run e2e:update
```

Vitest has two projects: `node` covers tests under `shared/`, `scripts/`, `seed/`, and `src/`; `convex` uses `convex-test` in `edge-runtime`. Convex tests require `convex/_generated`, produced by running `npx convex dev` or `npx convex codegen` at least once. There is no separate npm codegen script.

Playwright requires Chromium and runs screenshot tests from `tests/e2e/`, with baselines in `tests/e2e/__screenshots__/`; `npm run e2e:update` updates those baselines. Its web server uses port 5175 with `VITE_CONVEX_URL=''`, so tests exercise the local seed-backed demo. If reusing an existing server on that port, ensure it is also in demo mode. Chromium uses ANGLE/SwiftShader software rendering (`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`) for reproducible screenshots without a GPU.

## Repository layout

- `convex/` — Backend functions, schema, authentication, authorization, tests, and generated API bindings.
- `machines/` — Procedural three.js source pages and captured GLBs used to author instruments.
- `public/` — Static favicon and icon assets.
- `scripts/` — Seed, capture, inspect, and NX10 export CLI tools, plus GLB helpers/tests.
- `seed/` — Per-machine JSON/GLB content, procedures, manifest, and validation tests; read by the demo and loaded into Convex by the seed script.
- `shared/` — Zod schemas and validation/state helpers shared across the app, scripts, and Convex.
- `src/` — Vite/React app: routes, player, editor, explorer/3D scene, auth, data access, and styles.
- `tests/` — Playwright screenshot suite under `tests/e2e/`.
- `dist/` — Generated frontend build output, when present.
- `node_modules/` — Installed dependencies, when present.
- `.convex/` — Local Convex deployment state, when configured.
- `.git/` — Git repository metadata.

## Placeholder content notice

The NX10 procedures in `seed/park-nx10/procedures/` (`nc-scan`, `probe-exchange`, and `shutdown`) are illustrative example content written for this project, **not the manufacturer's official standard operating procedures**. Do not use them for instrument training as if they were validated SOPs.

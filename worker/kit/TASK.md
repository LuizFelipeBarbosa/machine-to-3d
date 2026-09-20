# Role

Reconstruct a lab instrument and one demonstrated procedure from a recorded video as data for a step-by-step 3D training app. Deliverables are files, not a viewer. Work in `{{WORKSPACE}}`; the readable repo is `{{REPO}}`. Machine: `{{MACHINE_SLUG}}`, `{{MACHINE_NAME}}` (kind: `{{MACHINE_KIND}}`). Procedure: `{{PROCEDURE_SLUG}}`, `{{PROCEDURE_TITLE}}`.

Author's brief:

{{BRIEF}}

The model must be recognisably the real product — correct proportions, layout of controls and moving parts — reconstructed from references, not guessed from the video alone.

# Inputs

The video is `{{VIDEO_FILE}}`, relative to the workspace. Run this first from the workspace:

```sh
bash "{{REPO}}/worker/kit/extract.sh" "{{VIDEO_FILE}}" "videos/{{PROCEDURE_SLUG}}"
```

Look at every frame in `videos/{{PROCEDURE_SLUG}}/frames/` using the image viewing tool; read `frames/index.json` and `videos/{{PROCEDURE_SLUG}}/transcript.json`. If transcription is unavailable, use the video and frames and record the limitation.

# Phase 1 — Identify and research

Identify the make and model from the frames and transcript: inspect badges, control layout and distinctive shapes. When uncertain, list candidates, pick the best-supported one and record your confidence.

Then research the product on the web. Use official product pages, manuals or quick-start guides, spec sheets with dimensions, photos from the front, side, rear and top, and images of moving parts in their open and closed positions.

Write `references/NOTES.md` with the identification and confidence; each source's URL, findings and what it contributed, including unresolved discrepancies; the overall dimensions (or best estimate) and the relative-unit scale chosen; and a **Reconstruction plan** table. The table must list every part to model (name, position and approximate size), every moving part with its pivot or slide axis and the clip that will animate it, and the state var each part maps to.

Do not start `buildModel.ts` before the plan exists.

# Phase 2 — Build the model

Geometry follows the reconstruction plan and reference photos. Compare the exported model against the reference photos, including its silhouette from the front and side, and iterate.

## buildModel.ts

Follow the exact contract in `{{REPO}}/worker/kit/template/buildModel.ts`:

```ts
import * as THREE from 'three';
export function buildModel(): { root: THREE.Group; clips: THREE.AnimationClip[] }
```

Name the root. Name it after the instrument in PascalCase_With_Underscores (for example, `Canon_EOS_50D` or `Plasma_Etch_PE25`) and set `machine.json`'s `rootNode` to that same name. Never keep the template's `Kit_Box` as the root name. Name parts and clips for the instrument's real parts (for example, `batteryDoor`, not generic template names such as `door` or `panel`); `door` or `panel` is fine only when the instrument genuinely has that part. Give each part one named group as a direct child of the root. Represent moving sub-assemblies as groups whose origins are their motion pivots (hinge or slide). Export one named `AnimationClip` per demonstrated motion; use unique, stable node and clip names. Use no textures, canvas or text. Use Y-up, rest the model on y=0, and use relative units (5–10 units tall is typical) with real-world proportions where known. Aim for illustrative accuracy: which part, which side, what moves. This is not a measured model.

## machine.json

Satisfy `{{REPO}}/shared/machine.ts`; see `{{REPO}}/worker/kit/template/machine.json` for a valid definition. Shape:

- `formatVersion: 1`, `rootNode`: the root's name.
- `parts`: `[{ "name": "nodeName", "label": "Display name", "blurb": "Purpose" }]`.
- `presetViews`: `[{ "name": "overview", "label": "Overview", "view": { "pos": [x,y,z], "target": [x,y,z] } }]`.
- `stateVars`: `[{ "name": "doorOpen", "label": "Door open", "kind": "toggle", "userToggle": true, "effects": [...] }]`; `userToggle` is optional.

Effects are `{ "type": "visible", "node": "name" }` (shown only when on), `{ "type": "translate", "node": "name", "offset": [x,y,z] }` (additive offset), `{ "type": "rotate", "node": "name", "axis": "x" | "y" | "z", "angle": radians }` (about the node origin), or `{ "type": "clip", "clip": "animationName" }` (scrub from rest to the end while turning on).

Every part name and effect node must exist in the GLB. Every clip effect must name an animation in the GLB. A node animated by a clip must not also be a translate/rotate target or be targeted by two referenced clips. A clip belongs to one state var. Keep names unique within parts, views and state vars.

# Phase 3 — Write the procedure

Satisfy `{{REPO}}/shared/procedure.ts`, including its step metadata fields (`sourceTimestamp`, `provenance`, `uncertainty`). Read `{{REPO}}/shared/foldState.ts`, `{{REPO}}/shared/validateProcedure.ts` and `{{REPO}}/seed/park-nx10/procedures/nc-scan.json` for the app contract and an example.

machine state is folded, not timed — `start` is the full state when the video begins (every state var present), each step's `state` is an ABSOLUTE set of only the vars that change from that step on (`{ "doorOpen": true }`), the player re-folds when stepping back; entering a step highlights `parts`, moves the camera and applies the folded state.

Write `formatVersion: 1`, `title: "{{PROCEDURE_TITLE}}"`, `summary` (two sentences), `minutes` (your estimate, a positive integer), `start` and `steps`. Each step has `id`, `title`, `where`, `body`, `parts` and `view`, plus the applicable fields below:

Step bodies may use facts from the manual (for example, correct names of controls), while `provenance` must still reflect what the video shows.

- One demonstrated physical action = one step whose `state` flips the corresponding state var. Add a state var and clip for every motion you model.
- `parts` = part names touched or pointed at. `where` is `instrument`, `software` or `logbook`.
- Every step showing a physical action carries a first-person `check` sentence, e.g. "I have opened the chamber door". Put anything the narrator warns about in `caution`.
- `media` = `{ "fileId": "videos/{{PROCEDURE_SLUG}}/frames/<file>", "alt": "..." }`, using the extracted frame for that moment; the worker uploads it. `sourceTimestamp` = seconds into the original video.
- `provenance` = `observed` when the video shows it, `inferred` when added from references or general practice. Include `uncertainty` text when unsure. Do NOT invent missing steps: if the narrator skips something, add nothing, or mark it `inferred` with an explicit note.
- Write `view` as `{ "pos": [0,0,0], "target": [0,0,0] }`; the worker computes camera views. Write IDs as `{{PROCEDURE_SLUG}}-01`, `{{PROCEDURE_SLUG}}-02`, and so on. No `link`s.

# Mode — {{MODE}}

For `existing-machine`, the workspace holds `machine.json`, `procedures/*.json` and `references/`. If `buildModel.ts` is missing, `references/EXISTING.md` describes the published model; read it first and satisfy it exactly when writing `buildModel.ts` from scratch. Otherwise, extend the existing `buildModel.ts`. NEVER rename or remove an existing part, node, state var or clip; other procedures depend on them. Add what the new video shows and refine proportions. When adding a state var, supply its initial value in every existing procedure's `start`. Report `modelChanged` accordingly.

For `new-machine`, start from a copy of `{{REPO}}/worker/kit/template/`, rename the root, parts and clips for the instrument, then add geometry.

# Loop until clean

Run `npm run export` (writes `model.glb`), then `npm run validate`, from the workspace. Both scripts exist in its `package.json`. Validation uses `node --import tsx {{REPO}}/worker/kit/validate.ts {{WORKSPACE}}`; it checks schemas, GLB roots/nodes/clips, animation conflicts and procedure references, and warns about inferred steps. Fix every issue and review every warning. Repeat both commands until clean; validate every existing procedure as well as the new one.

# Final answer

JSON only, matching `{{REPO}}/worker/kit/report.schema.json`. Report completion or the concrete blocker, whether the model changed, instrument identity/confidence, `procedureSlug`, observed/inferred step counts, uncertainties and notes. The report's `notes` field should mention how the model was validated against the references, such as silhouette and dimension comparison against the reference photos. Counts refer to this procedure. Do not claim completion while validation has blocking issues.

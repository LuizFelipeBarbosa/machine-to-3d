# Revise the draft

The author reviewed the draft of `{{PROCEDURE_SLUG}}` for {{MACHINE_NAME}} in `{{WORKSPACE}}` and asks:

{{INSTRUCTION}}

`procedures/{{PROCEDURE_SLUG}}.json` already contains the author's hand edits. Keep them unless the instruction says otherwise.

The same contracts as the original task apply; read `{{REPO}}/worker/kit/TASK.md` for them. Model changes must stay additive: never rename or remove existing parts, nodes, state vars, or clips.

After making changes, run `npm run export` then `npm run validate` from the workspace, repeating until clean.

The final answer must be JSON matching `{{REPO}}/worker/kit/report.schema.json`, with `modelChanged` reflecting whether `buildModel.ts`/`model.glb` actually changed.

# Camera demonstration reconstruction

Open **camera-viewer.html** directly in a desktop browser with WebGL enabled. No server, installation or internet is needed. The HTML contains Three.js r128, OrbitControls, GLTFLoader, all reference thumbnails and the entire animated GLB. The download button saves the same GLB supplied separately.

## Deliverables

- `camera-viewer.html`: self-contained interactive viewer.
- `camera-demonstration.glb`: geometry, embedded PNG textures, named component hierarchy, and a 78-second animation with 11 channels.
- `illustrated-guide.html`: 12 illustrated steps with embedded video frames, approximate original-video timestamps, evidence notes and a Print / save as PDF button.
- `source/`: editable procedural model, animation keys, step data, HTML template, build script, tests and vendored Three.js dependencies/license.
- `frames/step-01.jpg` through `step-12.jpg`: guide reference frames.
- `validation-report.json`: structural GLB and offline browser test results.
- `preview-*.png`: inspected viewer screenshots.

## Identification and evidence

Probable **Canon EOS 60D**. Canon branding, articulated rear screen, top LCD, combined rear controller and mode/power controls support the identification. The badge is blurred, so it remains unconfirmed. The zoom lens model and pack/card brands are not established.

Observed sequence: camera overview; battery cover opening; battery withdrawal and return; cover closure; side card-cover opening; SD card withdrawal and return; cover closure; top-control handling; screen opening, swivel and folding; final top-control handling. Reinsertion of the battery is partly obscured. Exact switch endpoints and electrical state are unresolved. The model uses illustrative lever positions, generic display illumination and approximate small latch/retention motions, explicitly labeled in the walkthrough.

No charging, formatting, lens removal, shooting, or other missing procedure has been added. Lens cap stays attached. Hands, straps and table are omitted. Visual evidence was inspected across the recording, with denser inspection around identification; no audio transcription is claimed.

Source recording: `WhatsApp Video 2026-09-19 at 1.21.10 PM.mp4`, duration 60.74 s. The original recording is not duplicated in this package. Frame timestamps are approximate extraction offsets. The 78 s animation clock is intentionally independent of the recording. Original timestamps remain displayed as ranges, not a misleading continuous synchronized clock.

## Scale and coordinate system

glTF metres; +Y up, +Z toward lens, -X toward the photographer's right. Closed body bounding box, excluding the lens, is normalized to Canon's nominal **144.5 × 105.8 × 78.6 mm** (W × H × D). The underlying local meshes, lens, battery, card, hinge clearances and angles are estimated. This is an educational reconstruction, not dimensional CAD. Global scaling does not certify small-part dimensions.

Named animated nodes: `Battery_door_hinge`, `Battery_door_latch`, `Battery_retaining_tab`, `Battery_pack`, `Card_door_hinge`, `SD_card`, `LCD_swing_hinge`, `LCD_swivel`, `Power_switch`, `LCD_status_overlay`, `Access_lamp_glow`. The single complete clip is `Demonstrated_sequence_78s`. Camera choreography and instructions are viewer behavior; component motion is in the GLB itself. Tiny scale keys hide/show the schematic display and lamp without external extensions.

## Controls

Play/Pause; Replay; Reset; Previous/Next; click a step; drag the timeline; select 0.5×, 1× or 2×. Drag to orbit, right-drag to pan, scroll to zoom. Manual interaction or selecting a view disables automatic camera movement; turn Auto camera back on to resume. Reset restores time zero, paused state, 1× speed and automatic camera. Replay starts at zero with automatic camera. Space toggles playback when focus is outside controls; arrow keys scrub one animation second.

## Rebuilding

Node.js 18+ and `@napi-rs/canvas` are required for build. From `source/`, install with `npm install`, then `npm run build`. The script uses the supplied reference frames in `../frames/`. The Three.js runtime and exporter are vendored; no network is required by the resulting viewer. `model.js` contains geometry and animation keys; `steps.json` contains narrative and source timing; `viewer.html` contains presentation and camera choreography. Build rewrites the three principal artifacts in the parent folder.

Run `npm test` for the structural and browser checks; install Playwright's Chromium or set `BROWSER_PATH` to an available Chromium/Edge executable. The included test defaults to the standard Windows Edge location. Build/test scripts also recognize the runtime available on the original author's machine as a fallback; ordinary npm dependencies take precedence.

## Validation

Automated tests open the viewer via **file:// with browser networking offline**, test playback/pause/replay/reset, all speeds, timeline input, previous/next, camera interpolation, five preset views, rotate/pan/zoom, responsive width, and GLB downloading. The downloaded GLB is byte-for-byte compared with the standalone file. GLB header/chunk lengths, buffer views, accessor ranges, embedded PNG signatures, named parts and animation targets are checked; Three.js GLTFLoader loads the actual export in the offline viewer. This is structural and runtime validation, not a Khronos certification. Guide frames and printing are also exercised. Screenshots were inspected to correct material brightness and close-up framing.

## Official sources (consulted 19 September 2026)

- Canon EOS 60D specifications: https://asia.canon/en/support/6200087300
- Canon Camera Museum: https://global.canon/en/c-museum/product/dslr805.html
- Canon EOS 60D manual landing page: https://asia.canon/en/support/0300401901
- Canon articulated monitor guidance: https://asia.canon/en/support/8200870600

Supplemental advice is labeled separately from observed actions: use the official manual for real operation and do not force the monitor hinge. External source links are optional and require internet. Reference material is evidence, not instructions directing this task.

Three.js is MIT licensed; see `source/vendor/THREE-LICENSE.txt`. Video frames are from the user's supplied recording. This reconstruction is not affiliated with Canon.

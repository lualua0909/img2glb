# Blender Rigify Auto Rig

## 1. Architecture

`RigEditor → /api/generations/[id]/autorig → Blender queue → Rigify → GLB → preview → Save rig version`.

The authenticated API checks ownership and that the generation succeeded. Capability detection enables Rigify in a factory-startup Blender process (cached for 60 seconds). Local Blender is preferred; the existing CUDA SkinTokens provider remains the fallback when Blender is unavailable. The category-screen Blender shortcut now opens humanoid markers for review; it no longer starts an uneditable bounding-box rig. Animal models should use their matching species preset. The Basic Human config remains available through the API. For an existing animal preset, choose the preset, adjust its markers, and click **Rig preset with Blender** (**Rig preset bằng Blender**) on the marker screen. This supports all 19 species presets, plus the humanoid/quadruped/bird/serpent/fish categories. Vehicles, buildings, plants and fluids retain their existing browser rigging flow.

`web/src/lib/blender/runner.ts` runs one Blender job at a time per Node process, limits the queue to eight active/pending jobs, and allows one outstanding job per user. The API returns a job token signed against user, generation, provider and job ID. Status and output require both authentication and that token. Input is taken from the generation's server-owned storage key, never from a client-supplied file path or URL. The original model is preserved.

Artifacts live outside the public file store. Completed/failed job directories older than 24 hours are removed lazily when another job starts. Job state is persisted to JSON; the queue itself is in memory. Expired running/queued jobs report failure after their deadline, including after a server restart. No automatic resume is implemented.

## 2. How Blender is called

Node `spawn(binary, args)` without a shell:

```text
Blender --background --factory-startup --disable-autoexec --python-exit-code 1 \
  --python <job-dir>/auto_rig.py -- <job-dir>
```

The macOS default is `/Applications/Blender.app/Contents/MacOS/Blender`; on other platforms it is `blender` on PATH. Optional server environment variables:

- `BLENDER_PATH`: executable path, not a command with flags.
- `BLENDER_RIG_DIR`: dedicated private artifact directory; default `../data/blender-rigs`, relative to the web server's working directory.
- `BLENDER_RIG_TIMEOUT_SECONDS`: default 300, clamped to 10–1800 seconds; timeout kills the child process.

Stdout emits progress stages. Logs are bounded to the last 32 KB. Import, Rigify generation and export exceptions exit nonzero. Probe failures hide Blender availability and permit the existing CUDA fallback. Runtime Blender failures are surfaced, not silently retried with another provider.

Requires a long-running Node server and Blender/Rigify on the **server machine**. A browser cannot launch Blender installed only on a remote user's computer. Serverless and multiple web replicas require a separate durable worker queue.

## 3. Where `auto_rig.py` lives

The maintained source is `web/src/lib/blender/script.ts`, exporting `AUTO_RIG_PY`. To respect this project's TypeScript-only convention for new source/test files, the Python file is generated at runtime:

```text
<data>/blender-rigs/<32-character-job-id>/
  auto_rig.py
  input.glb
  config.json
  status.json
  blender.log
  report.json
  rigged.glb
  rig.blend
```

This also bundles the script into Next's standalone server output without relying on an untraced source file. `.blend` retains the metarig and generated controls for manual editing; GLB exports the selected character meshes and deform rig. Open `rig.blend` locally to inspect or adjust the full Rigify setup. `.blend` downloading is not yet exposed in the UI.

## 4. RigConfig

`web/src/lib/blender/config.ts` defines a strict Zod schema and inferred TypeScript type. POST the config directly as JSON to the auto-rig endpoint; an empty request uses defaults:

```json
{
  "version": 1,
  "preset": "humanoid",
  "forward": "+Z",
  "widthScale": 1,
  "depthScale": 1,
  "weightFallback": "error",
  "bones": {}
}
```

`preset: "humanoid"` uses Basic Human (no detailed fingers or facial rig). The imported glTF mesh is converted by Blender from Y-up to Z-up. The metarig is fitted to the combined mesh bounding box, independently scaling height, width and depth. `forward` rotates the fitted metarig by 180 degrees when set to `-Z`. Width/depth multipliers accept 0.25–4. The UI always uses the editable template workflow; Basic Human settings use the API.

`bones` overrides named Basic Human metarig bones such as `upper_arm.L`, `forearm.L`, `spine`, `thigh.R`. Each value has `head` and `tail` triples in normalized **glTF bounds**: X=0 at min X, Y=0 at the ground, Z=0 at min Z; 1 means the respective maximum. Values outside [0,1] can place helper joints outside the mesh. Overrides are absolute in that frame and are not mirrored/flipped again. Unknown bones, zero-length bones and invalid/nonfinite config values fail. AI landmark predictions can eventually populate this same contract.

Rigify generates controls, then Blender binds meshes with `ARMATURE_AUTO`. If heat weights leave vertices unweighted, `weightFallback: "nearest"` fills only those vertices using inverse squared distance to the four nearest deform-bone segments. The job report and GLB extras preserve a warning, and the editor displays it. This geometric fallback can deform poorly near adjacent limbs. Use `weightFallback: "error"` to require automatic heat weights without fallback. RigConfig is retained in `config.json` and armature extras.

### Existing preset bridge

`preset: "template"` is the second validated config variant. `templateRigConfig()` in `web/src/lib/blender/template.ts` serializes the current `RigPlan` into `category`, `species`, `weightFallback` and a `skeleton` array. Each bone carries its name, parent, head/tail, deform flag and optional rigid/gate rules. Unlike Basic Human overrides, these are **absolute glTF world coordinates**, already incorporating user marker edits, symmetry and direction. They are converted once from `(x,y,z)` to Blender `(x,-z,y)`; no bounding-box fitting is performed.

The server validates at most 256 unique bones ordered parent-first, supported categories and nonzero deform-bone lengths. The Blender script creates a custom metarig using Rigify `basic.super_copy`, generates FK controls/deform bones and runs automatic weighting. Explicit hard mask boundaries (including the jaw/skull boundary) are enforced afterward, then weights are limited to four influences and normalized. Distance fallback respects the template's bone gates. This is not the browser's full heat-diffusion algorithm, so weights can differ. The chain skinning used for some fish templates is also replaced by Blender binding.

The GLB initially contains Rigify's `DEF-` bones. On return, `restoreTemplateRig()` keeps Blender weights and materials while restoring the template bone names, parent hierarchy and identity rest rotations. This permits existing bite, flight, walk and other procedural clips to operate without confusing Blender's bone-local axes with the editor's axes. The `.blend` retains the Rigify controls. The saved editor GLB retains the preset skeleton, Blender weights and generated animations. Adjust returns to the same markers; either rigging backend can be run again. Template requests fail explicitly if Blender is unavailable instead of silently discarding the marker configuration via SkinTokens.

This bridge preserves existing limitations: Western Dragon has a jaw and three bones per wing; Bird has wing chains but no jaw or membrane branches; generic quadrupeds can add `Neck2`. The Sauropod (Long-neck dinosaur / Khủng long cổ dài) preset adds five editable neck links (`Neck` through `Neck5`), five tail links, and Walk, Run, Stomp and Tail Swipe clips. Adjust the five neck markers from base to top to follow the curve before rigging; initial placement is a silhouette heuristic for an upright neck. Neck pitch and turns are distributed across all links. This implementation does not introduce pterosaur presets, AI landmark inference, Spline IK or membrane simulation.

Inputs must contain meshes, have nondegenerate bounds and contain at most 500,000 vertices. Already-rigged inputs are rejected; use the original model.

## 5. Tests

From `web/`:

```sh
pnpm typecheck
pnpm build
pnpm exec eslint src/lib/blender 'src/app/api/generations/[id]/autorig/route.ts' src/components/rig-editor.tsx src/lib/i18n/dictionaries/en.ts src/lib/i18n/dictionaries/vi.ts
pnpm exec tsx --test src/lib/blender/*.test.ts
BLENDER_INTEGRATION=1 pnpm exec tsx --test src/lib/blender/*.test.ts
```

The opt-in integration test launches real Blender, constructs a humanoid fixture, generates Rigify controls, binds weights and exports GLB/.blend. It checks joint/weight attributes, finite normalized weights, reimports the GLB and rotates an arm bone to verify actual mesh deformation. It also exercises queue execution, duplicate-user rejection, atomic status reads, model readiness, invalid-bone failure and hard timeout. Temporary fixture artifacts are removed at the end. Without `BLENDER_INTEGRATION`, Blender integration is skipped and schema validation still runs.

Template tests also validate serialization of all 19 presets. Three synthetic meshes exercise the real Blender preset pipeline (dragon, bird and sauropod), verify jaw weights stay below the mouth boundary, then isolate jaw/wing/neck animation tracks to confirm deformation after reimport.

For manual acceptance, open a completed generation, choose Western Dragon or Bird (or the quadruped category), adjust markers, run **Rig preset with Blender**, inspect Show Bones, save the rig version, and reload/download it. Also test the Basic Human shortcut and a poor mesh that triggers the fallback warning. Unsupported non-animal categories should retain only browser rigging. Automated tests do not cover an authenticated browser session or database-backed save end-to-end.

## 6. Current limitations

- The Basic Human shortcut uses bounding-box fitting, **not AI anatomical inference**. Preset mode uses the existing template marker heuristics plus user corrections. Neither mode reliably identifies anatomy on arbitrary meshes without review.
- Heat weights can fail, even on the synthetic fixture. Distance fallback produces usable skin attributes but does not guarantee good bending or anatomical assignment. Manual review/weight painting remains necessary.
- No retopology, mesh repair, automatic orientation detection, facial controls or finger fitting. Materials pass through Blender's glTF importer/exporter; extension-specific round-trip fidelity is not guaranteed.
- The browser receives deform bones, not Blender constraints/IK widgets. Template mode restores the preset skeleton and supports its existing clips. The separate Basic Human shortcut still only previews whole-model motions; general retargeting onto arbitrary Rigify rigs is not implemented.
- One long-lived Node process only. Queue cancellation, durable resumption and distributed scheduling are not implemented. Polling stops when the editor closes, while the bounded backend job continues.
- `.blend`, logs and advanced config are available on disk/API; dedicated UI controls and download buttons are future work.

## 7. Next steps for AI Auto Rig

1. Predict category, canonical orientation and anatomical landmarks with confidence scores; populate `RigConfig.bones` instead of fitting only bounding boxes.
2. Extend the connected marker editor with editable jaw hinges, membrane support joints and multi-segment neck curves.
3. Add automated pose/deformation checks, disconnected-component handling and learned skin weights; keep explicit confidence/fallback reporting.
4. Extend animation compatibility beyond the implemented template-skeleton bridge to arbitrary imported rigs and the Basic Human shortcut.
5. Move jobs into a durable Blender worker with cancellation/retries and add pterosaur presets with corresponding fitting/validation tests.

Reference: [Blender Rigify basic usage](https://docs.blender.org/manual/en/latest/addons/rigify/basics.html) describes metarig placement, rig generation and automatic weighting. The local integration was exercised with Blender 5.2.2 LTS.


## Rig correction and part inspection

- Saved upright flips are preserved through Blender binding. The inspector stores its 180-degree correction on a parent node; the importer now detaches meshes while retaining their complete world transforms before Rigify replaces their parents. Previously that replacement could discard the correction. Re-run rigging from the corrected source model to replace an affected rig. The orientation regression test checks rest vertices in both Blender's GLB and the restored preset rig, plus wing animation.
- Humanoid arms hanging outside the torso now use outward-facing weight gates instead of downward shoulder-to-elbow gates. A bounded shoulder blend prevents arm weights diffusing through arm/hip contacts into the inner torso. Browser heat skinning and Blender template binding share these gates; raised/crossed arms and winged characters retain the original rules. Rebuild the rig from markers to apply this to an existing asset. This marker-based constraint does not repair fused topology or infer clothing boundaries; inspect the shoulder and contact seam after posing. Regression fixtures cover both facing directions, stationary inner torso under arm rotation, moving sleeves, normalized weights and Blender config serialization.
- GLB import now uses `merge_vertices=True` before Bone Heat binding. On the reported mammoth asset, the previous job assigned 14,849 vertices by distance after heat failure. Re-running the same input/config with merged import vertices passed strict automatic weighting without fallback. This fixes that import/binding failure, not anatomical misplacement: the old job used Rhino, while this model should use Elephant and corrected landmarks/direction.
- Approximate distance weights are **off by default** in both config variants and the editor. Enable them explicitly only when reviewing their limitations. Error/fallback messages remain visible in the editor. Blender preview starts at rest rather than immediately playing an animation.
- Marker editing shows anatomical connections for arms, legs, spine/belly, wings, horns and feelers. Right-side connections are dashed. Select a joint to edit X/Y/Z precisely. Dragging preserves depth by default; optional depth snapping can be enabled. Adjust returns to the marker step for another rigging run.
- Exploded-part inspection clips triangles along boundaries where interpolated weights are equal, replacing the previous majority-corner assignment. The original rig geometry, weights, textures and export remain untouched. This removes triangle-sized stair steps; noisy weights may still produce irregular borders. Parts remain diagnostic surface patches with open boundaries, not capped/watertight printable solids.
- Regression tests in `src/lib/rig/parts.test.ts` cover area preservation, interior cuts, three-way junctions and tie handling. The reported model's 20,000 triangles generated 22,778 preview triangles across 20 parts in about 200 ms in a local diagnostic run.

## Weapon attachment placeholders

New humanoid rigs include `WeaponSocketLeft` and `WeaponSocketRight`, empty child nodes at the midpoint of each hand. Supported paths: browser humanoid preset, Blender humanoid template, and Blender Basic Human. Animal presets and arbitrary SkinTokens rigs are not modified. Existing saved assets need to be rigged and exported again.

Sockets follow the hand hierarchy without changing deform bones or vertex weights. Both exported GLB and Blender's generated `.blend` retain them. GLB extras identify `attachmentType: "weapon"` and `side: "left" | "right"`. Rest axes match the model axes (Y up); there is no universal weapon-forward axis. In the engine, preserve/import the named child nodes, parent the weapon to the selected node, then adjust its local position, rotation and scale for its grip. These are glTF nodes, not engine-native socket resources; an importer that discards empty nodes needs configuration or an engine-side socket recreated from that transform.

Placement is estimated from the hand bone, not finger detection. Move wrist markers and regenerate to change hand placement; dedicated socket offset/rotation controls and weapon previews in the editor are not implemented. Existing weapon options for weapons already inside the mesh remain separate.

`attachments.test.ts` checks following hand transforms, idempotency and glTF node serialization. Opt-in Blender tests check both Basic Human GLB parenting and template GLB → browser restoration, including matching attachment positions.

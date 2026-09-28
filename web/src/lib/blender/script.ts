/** Materialized as <job directory>/auto_rig.py. Keep the executable source bundled in Next's server output. */
export const AUTO_RIG_PY = String.raw`
import bpy, sys, json, os
from mathutils import Vector, Matrix
from mathutils.kdtree import KDTree

folder = sys.argv[sys.argv.index('--') + 1]
config = json.load(open(os.path.join(folder, 'config.json')))
def stage(message):
    print('RIG_STAGE:' + message, flush=True)

stage('Importing GLB')
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.preferences.addon_enable(module='rigify')
bpy.ops.import_scene.gltf(filepath=os.path.join(folder, 'input.glb'), merge_vertices=True)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH' and len(o.data.vertices)]
if not meshes:
    raise RuntimeError('Input contains no mesh')
if any(o.type == 'ARMATURE' for o in bpy.context.scene.objects):
    raise RuntimeError('Input is already rigged; use the original unrigged model')
if sum(len(o.data.vertices) for o in meshes) > 500000:
    raise RuntimeError('Mesh exceeds 500000 vertices; simplify it first')
# Inspector orientation edits live on parent nodes. ARMATURE_AUTO replaces that
# parent, so preserve the full imported world transform before fitting/binding.
# Snapshot every mesh first: an imported mesh can itself parent another mesh.
mesh_world = [(o, o.matrix_world.copy()) for o in meshes]
for obj, transform in mesh_world:
    obj.parent = None
    obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.matrix_world = transform
bpy.context.view_layer.update()
points = [o.matrix_world @ Vector(p) for o in meshes for p in o.bound_box]
lo = Vector([min(p[i] for p in points) for i in range(3)])
hi = Vector([max(p[i] for p in points) for i in range(3)])
size = hi - lo
if min(size) < 1e-6:
    raise RuntimeError('Mesh has degenerate bounds')
center = (lo + hi) * 0.5
def world(p):
    # glTF/Three world Y-up -> Blender world Z-up.
    return Vector((p[0], -p[2], p[1]))
template = config['preset'] == 'template'
specs = {('DEF-' + b['name']): b for b in config.get('skeleton', [])}
if template:
    stage('Building metarig from preset markers')
    bpy.ops.object.armature_add()
    meta = bpy.context.object
    meta.name = 'preset_metarig'
    bpy.ops.object.mode_set(mode='EDIT')
    bs = meta.data.edit_bones
    for b in list(bs):
        bs.remove(b)
    for spec in config['skeleton']:
        b = bs.new(spec['name'])
        b.head, b.tail = world(spec['head']), world(spec['tail'])
        if (b.tail-b.head).length < 1e-8:
            b.tail = b.head + Vector((0, 0, max(size.length*0.001, 0.0001)))
        if spec['parent']:
            b.parent = bs[spec['parent']]
        b.use_connect = False
    bpy.ops.object.mode_set(mode='OBJECT')
    collection = meta.data.collections.new('Preset Controls')
    collection.rigify_ui_row = 1
    for spec in config['skeleton']:
        b = meta.pose.bones[spec['name']]
        collection.assign(b)
        b.rigify_type = 'basic.super_copy'
        b.rigify_parameters.make_control = True
        b.rigify_parameters.make_deform = spec['deform']
else:
    stage('Fitting humanoid metarig')
    bpy.ops.object.armature_basic_human_metarig_add()
    meta = bpy.context.object
    bpy.ops.object.mode_set(mode='EDIT')
    bs = meta.data.edit_bones
    height = max(max(b.head.z, b.tail.z) for b in bs)
    width = max(max(abs(b.head.x), abs(b.tail.x)) for b in bs) * 2
    sign = 1 if config['forward'] == '+Z' else -1
    # Blender imports glTF Y-up to Blender Z-up. Depth is Blender Y.
    def fit(p):
        return Vector((center.x + sign*p.x*size.x/width*config['widthScale'],
                       center.y + sign*p.y*size.y/0.3*config['depthScale'],
                       lo.z + p.z*size.z/height))
    for b in bs:
        b.head, b.tail = fit(b.head.copy()), fit(b.tail.copy())
    def override(p):
        return Vector((lo.x + p[0]*size.x, hi.y - p[2]*size.y, lo.z + p[1]*size.z))
    for name, data in config['bones'].items():
        if name not in bs:
            raise RuntimeError('Unknown metarig bone: ' + name)
        bs[name].head, bs[name].tail = override(data['head']), override(data['tail'])
    for b in bs:
        if b.length < 1e-6:
            raise RuntimeError('Zero length bone: ' + b.name)
    bpy.ops.object.mode_set(mode='OBJECT')
stage('Generating Rigify controls')
bpy.ops.pose.rigify_generate()
rig = bpy.context.object
if rig == meta or rig.type != 'ARMATURE':
    raise RuntimeError('Rigify did not generate an armature')
surface_path = os.path.join(folder, 'surface-weights.json')
surface = json.load(open(surface_path)) if os.path.exists(surface_path) else None
surface_tree = None
if surface:
    surface_tree = KDTree(len(surface['positions']) // 3)
    for i in range(len(surface['positions']) // 3):
        surface_tree.insert(world(surface['positions'][i*3:i*3+3]), i)
    surface_tree.balance()
stage('Binding surface weights' if surface else 'Binding automatic weights')
warnings = []
for obj in meshes:
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type='ARMATURE_NAME' if surface else 'ARMATURE_AUTO')
    segments = []
    for b in rig.data.bones:
        if not b.use_deform:
            continue
        group = obj.vertex_groups.get(b.name) or obj.vertex_groups.new(name=b.name)
        a, end = rig.matrix_world @ b.head_local, rig.matrix_world @ b.tail_local
        delta = end - a
        spec = specs.get(b.name, {})
        gate = spec.get('gate')
        mask = (world(gate['origin']), world(gate['dir']).normalized(), gate.get('fade'),
                [(world(p['origin']), world(p['dir']).normalized()) for p in gate.get('planes', [])]) if gate else None
        segments.append((group, a, delta, max(delta.length_squared, 1e-12), mask, spec.get('rigid', False)))
    by_index = {s[0].index: s for s in segments}
    by_name = {s[0].name: s for s in segments}
    missing = 0
    for v in obj.data.vertices:
        p = obj.matrix_world @ v.co
        current = []
        if surface:
            _, source, distance = surface_tree.find(p)
            if distance > surface['tolerance']:
                raise RuntimeError('Surface weights do not match imported geometry')
            for slot in range(4):
                offset = source * 4 + slot
                weight = surface['weight'][offset]
                if weight > 0:
                    name = surface['bones'][surface['index'][offset]]
                    if name not in by_name:
                        raise RuntimeError('Unknown surface deform bone: ' + name)
                    current.append((by_name[name], weight))
            if not current:
                raise RuntimeError('Surface binding left unweighted vertices')
        for influence in ([] if surface else v.groups):
            seg = by_index.get(influence.group)
            if not seg or influence.weight <= 1e-8:
                continue
            mask = seg[4]
            # Preserve explicit hard boundaries, notably upper skull vs lower jaw.
            if mask and mask[2] is not None and (p-mask[0]).dot(mask[1]) < -mask[2]:
                continue
            if mask and any((p-origin).dot(direction) < 0 for origin, direction in mask[3]):
                continue
            current.append((seg, influence.weight))
        if not current:
            missing += 1
            if config['weightFallback'] == 'error':
                raise RuntimeError('Automatic weights left unweighted vertices in ' + obj.name)
            distances = []
            for seg in segments:
                group, a, delta, length, mask, rigid = seg
                if mask and (p-mask[0]).dot(mask[1]) < -(mask[2] or 0):
                    continue
                if mask and any((p-origin).dot(direction) < 0 for origin, direction in mask[3]):
                    continue
                t = max(0, min(1, (p-a).dot(delta)/length))
                distances.append(((p-a-t*delta).length_squared, seg))
            nearest = sorted(distances, key=lambda pair: pair[0])[:4]
            if not nearest:
                raise RuntimeError('No permitted deform bone for vertex in ' + obj.name)
            current = [(seg, 1/max(distance, 1e-8)) for distance, seg in nearest]
        current = sorted(current, key=lambda pair: pair[1], reverse=True)[:4]
        if current[0][0][5]:
            current = [current[0]]
        total = sum(weight for seg, weight in current)
        for influence in list(v.groups):
            if influence.group in by_index:
                obj.vertex_groups[influence.group].remove([v.index])
        for seg, weight in current:
            seg[0].add([v.index], weight/total, 'REPLACE')
    if missing:
        stage('Heat weights incomplete; filled vertices by permitted bone distance')
        warnings.append('Distance fallback used for %d vertices in %s; inspect deformation' % (missing, obj.name))
rig['rigify_warnings'] = warnings
rig['weight_method'] = 'surface' if surface else 'blender-heat'
rig['rig_config'] = json.dumps(config)
# Export real child nodes so engines can attach equipment without skinning it.
sockets = []
if config['preset'] == 'humanoid' or config.get('category') == 'humanoid':
    for side, suffix in [('Left', 'L'), ('Right', 'R')]:
        name = 'DEF-' + (side + 'Hand' if config['preset'] == 'template' else 'hand.' + suffix)
        hand = rig.data.bones.get(name)
        if hand is None:
            raise RuntimeError('Missing weapon attachment hand: ' + name)
        socket = bpy.data.objects.new('WeaponSocket' + side, None)
        bpy.context.collection.objects.link(socket)
        socket.parent = rig
        socket.parent_type = 'BONE'
        socket.parent_bone = name
        socket.empty_display_type = 'ARROWS'
        socket.empty_display_size = max(hand.length * 0.5, 0.001)
        socket['attachmentType'] = 'weapon'
        socket['side'] = side.lower()
        bpy.context.view_layer.update()
        p = rig.matrix_world @ ((hand.head_local + hand.tail_local) * 0.5)
        # glTF/model rest axes: X right, Y up, Z depth (Blender is Z-up).
        socket.matrix_world = Matrix(((1,0,0,p.x),(0,0,-1,p.y),(0,1,0,p.z),(0,0,0,1)))
        sockets.append(socket)
json.dump({'warnings': warnings, 'weightMethod': 'surface' if surface else 'blender-heat'}, open(os.path.join(folder, 'report.json'), 'w'))
stage('Exporting rigged GLB')
bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True)
for obj in meshes:
    obj.select_set(True)
for obj in sockets:
    obj.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(folder, 'rig.blend'))
bpy.ops.export_scene.gltf(filepath=os.path.join(folder, 'rigged.glb'), export_format='GLB',
    use_selection=True, export_animations=False, export_skins=True, export_def_bones=True, export_extras=True)
stage('Completed')
`;

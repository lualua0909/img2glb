import { NodeIO } from '@gltf-transform/core';
import { BufferAttribute, BufferGeometry, Mesh, Vector3 } from 'three';
import { readFile } from 'node:fs/promises';
import { buildModelData } from './src/lib/rig/model';
import { DEFAULT_RIG_OPTIONS, planRig, type Markers } from './src/lib/rig/rig';
import { templateRigConfig } from './src/lib/blender/template';
import { runRig } from './src/lib/blender/runner';
async function main() {
const source='../data/blender-rigs/3c84f292bafe65a8f2d3482cc71dd735/';
const old=JSON.parse(await readFile(source+'config.json','utf8'));
const doc=await new NodeIO().read(source+'input.glb');
const meshes=doc.getRoot().listMeshes().flatMap(m=>m.listPrimitives().map(p=>{
 const g=new BufferGeometry();g.setAttribute('position',new BufferAttribute(new Float32Array(p.getAttribute('POSITION')!.getArray()!),3));g.setIndex(new BufferAttribute(new Uint32Array(p.getIndices()!.getArray()!),1));return new Mesh(g);
}));
const model=buildModelData(meshes);
const markers:Markers={};
const head=(name:string)=>new Vector3(...old.skeleton.find((b:{name:string})=>b.name===name).head as [number,number,number]);
markers.chin=head('Head');markers.groin=head('Hips').addScaledVector(new Vector3(0,1,0),-.03*model.size.y);
for(const [side,prefix] of [['L','Left'],['R','Right']]) {
 for(const [id,bone] of [['shoulder','UpperArm'],['elbow','LowerArm'],['wrist','Hand'],['knee','LowerLeg'],['ankle','Foot']])markers[id+side]=head(prefix+bone);
 for(const [id,bone] of [['wingRoot','WingUpper'],['wingElbow','WingFore'],['wingWrist','WingHand']])markers[id+side]=head(bone+side);
 markers['wingTip'+side]=new Vector3(...old.skeleton.find((b:{name:string})=>b.name==='WingHand'+side).tail as [number,number,number]);
}
const plan=planRig('humanoid',model,markers,{...DEFAULT_RIG_OPTIONS,wings:true});
const output='../data/rig-fixes/a99c4e42-surface';
await runRig(output,source+'input.glb',templateRigConfig(plan,null),console.log);
for(const [name,file] of [['old',source+'rigged.glb'],['new',output+'/rigged.glb']]){
 const d=await new NodeIO().read(file);let headCount=0,headBad=0,max=0;
 for(const node of d.getRoot().listNodes()) {const joints=node.getSkin()?.listJoints();if(!joints)continue;for(const p of node.getMesh()!.listPrimitives()) {const pos=p.getAttribute('POSITION')!,ix=p.getAttribute('JOINTS_0')!,w=p.getAttribute('WEIGHTS_0')!;for(let i=0;i<pos.getCount();i++){const [x,y,z]=pos.getElement(i,[]);if(y>.32&&Math.abs(x)<.28&&z>-.08){headCount++;let ww=0;const ids=ix.getElement(i,[]),ws=w.getElement(i,[]);for(let k=0;k<4;k++)if(joints[ids[k]].getName().startsWith('DEF-Wing'))ww+=ws[k];max=Math.max(max,ww);if(ww>.01)headBad++;}}}}
 console.log({name,headCount,headBad,max});
}
}
main();

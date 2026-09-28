import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { rigConfigSchema, type RigConfig } from "./config";
import { AUTO_RIG_PY } from "./script";
import { needsSurfaceBinding, surfaceBinding } from "./surface";

export const blenderBinary = () => process.env.BLENDER_PATH || (process.platform === "darwin" ? "/Applications/Blender.app/Contents/MacOS/Blender" : "blender");
const timeoutMs = () => Math.min(1800, Math.max(10, Number(process.env.BLENDER_RIG_TIMEOUT_SECONDS) || 300)) * 1000;
const root = () => path.resolve(/* turbopackIgnore: true */ process.env.BLENDER_RIG_DIR || "../data/blender-rigs");
const folderOf = (id: string) => {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid job ID");
  return path.join(/* turbopackIgnore: true */ root(), id);
};
type Status = { status: "queued" | "running" | "completed" | "failed"; stage?: string; error?: string; warnings?: string[]; updatedAt: number };
const shared = globalThis as typeof globalThis & { __blenderQueue?: { tail: Promise<void>; pending: number; owners: Set<string> }; __blenderProbe?: { at: number; result: Promise<boolean> } };
const queue = shared.__blenderQueue ??= { tail: Promise.resolve(), pending: 0, owners: new Set() };

/** No shell, bounded logs, hard kill on deadline, nonzero Python failures propagate. */
export function runBlender(args: string[], onStage?: (stage: string) => void, timeout = timeoutMs()): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(/* turbopackIgnore: true */ blenderBinary(), ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    let pending = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
    const append = (chunk: Buffer) => { log = (log + chunk.toString()).slice(-32000); };
    child.stderr.on("data", append);
    child.stdout.on("data", (chunk: Buffer) => {
      append(chunk);
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop()!.slice(-4000);
      for (const line of lines) if (line.startsWith("RIG_STAGE:")) onStage?.(line.slice(10));
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("Blender rigging timed out"));
      else if (code !== 0) reject(new Error(log || `Blender exited with ${code}`));
      else resolve(log);
    });
  });
}

export function blenderAvailable() {
  if (!shared.__blenderProbe || Date.now() - shared.__blenderProbe.at > 60000) {
    shared.__blenderProbe = { at: Date.now(), result: runBlender(["--python-expr", 'import bpy; bpy.ops.preferences.addon_enable(module="rigify"); bpy.ops.object.armature_basic_human_metarig_add(); print("RIGIFY_READY")'], undefined, 20000).then(log => log.includes("RIGIFY_READY"), () => false) };
  }
  return shared.__blenderProbe.result;
}

export async function runRig(folder: string, input: string, config: RigConfig, onStage?: (stage: string) => void) {
  await mkdir(folder, { recursive: true });
  await copyFile(input, path.join(folder, "input.glb"));
  await writeFile(path.join(folder, "config.json"), JSON.stringify(rigConfigSchema.parse(config), null, 2));
  await writeFile(path.join(folder, "auto_rig.py"), AUTO_RIG_PY);
  try {
    if (needsSurfaceBinding(config)) {
      onStage?.("Computing surface weights for winged humanoid");
      await writeFile(path.join(folder, "surface-weights.json"), JSON.stringify(await surfaceBinding(input, config)));
    } else {
      await rm(path.join(folder, "surface-weights.json"), { force: true });
    }
    const log = await runBlender(["--python", path.join(folder, "auto_rig.py"), "--", folder], onStage);
    await writeFile(path.join(folder, "blender.log"), log);
    const output = await readFile(path.join(folder, "rigged.glb"));
    if (output.length < 20 || output.toString("ascii", 0, 4) !== "glTF") throw new Error("Blender produced an invalid GLB");
  } catch (error) {
    await writeFile(path.join(folder, "blender.log"), String(error));
    throw error;
  }
}

export async function startBlenderRig(input: string, config: RigConfig, owner: string) {
  if (queue.owners.has(owner) || queue.pending >= 8) return null;
  queue.owners.add(owner);
  queue.pending++;
  const id = randomBytes(16).toString("hex");
  const folder = folderOf(id);
  const save = async (s: Omit<Status, "updatedAt">) => {
    await writeFile(path.join(folder, "status.tmp"), JSON.stringify({ ...s, updatedAt: Date.now() }));
    await rename(path.join(folder, "status.tmp"), path.join(folder, "status.json"));
  };
  try {
    await mkdir(folder, { recursive: true });
    await save({ status: "queued" });
  } catch (error) { queue.pending--; queue.owners.delete(owner); throw error; }
  queue.tail = queue.tail.then(async () => {
    // Clean expired artifacts lazily, outside the public file store.
    for (const entry of await readdir(/* turbopackIgnore: true */ root())) {
      if (!/^[a-f0-9]{32}$/.test(entry) || entry === id) continue;
      const old = folderOf(entry);
      if (Date.now() - (await stat(/* turbopackIgnore: true */ old)).mtimeMs > 86400000) await rm(old, { recursive: true, force: true });
    }
    await save({ status: "running", stage: "Blender Rigify" });
    // Serialize status writes so a delayed stage can never overwrite completion.
    let writes = Promise.resolve();
    try {
      await runRig(folder, input, config, stage => { writes = writes.then(() => save({ status: "running", stage })); });
      await writes;
      const report = JSON.parse(await readFile(path.join(folder, "report.json"), "utf8"));
      await save({ status: "completed", warnings: report.warnings });
    } catch (error) {
      await writes.catch(() => {});
      console.error("[blender-rig]", id, error);
      await save({ status: "failed", error: "Blender Rigify failed. Check mesh topology, bone placement and the job's blender.log." });
    }
  }).catch(async (error) => { console.error("[blender-rig]", error); await save({ status: "failed", error: "Blender job failed" }).catch(() => {}); })
    .finally(() => { queue.pending--; queue.owners.delete(owner); });
  return id;
}

export async function blenderStatus(id: string): Promise<Status | null> {
  try {
    const status: Status = JSON.parse(await readFile(path.join(folderOf(id), "status.json"), "utf8"));
    if (["queued", "running"].includes(status.status) && Date.now() - status.updatedAt > timeoutMs() * (status.status === "queued" ? 9 : 1) + 60000)
      return { status: "failed", error: "Blender job expired or the server restarted. Please retry.", updatedAt: Date.now() };
    return status;
  } catch { return null; }
}
export async function blenderModel(id: string) {
  if ((await blenderStatus(id))?.status !== "completed") return new Response("Model not ready", { status: 409 });
  return new Response(await readFile(path.join(folderOf(id), "rigged.glb")), { headers: { "Content-Type": "model/gltf-binary" } });
}

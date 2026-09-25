import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";

export const keys = {
  input: (userId: string, id: string, ext: string) => `inputs/${userId}/${id}.${ext}`,
  model: (userId: string, id: string) => `models/${userId}/${id}.glb`,
};

// Plain files under STORAGE_DIR, served by /api/files/<key> with HMAC-signed URLs.

/** Absolute file path for a key, or null if the key would escape STORAGE_DIR. */
export function localPath(key: string) {
  const root = path.resolve(env().STORAGE_DIR);
  const file = path.resolve(root, key);
  return /^[\w./-]+$/.test(key) && file.startsWith(root + path.sep) ? file : null;
}

const sign = (key: string, exp: string, dl: string) =>
  createHmac("sha256", env().FILE_URL_SECRET).update(`${key}\n${exp}\n${dl}`).digest("base64url");

export function verifyLocalUrl(key: string, params: URLSearchParams) {
  const exp = params.get("exp") ?? "";
  const got = Buffer.from(params.get("sig") ?? "");
  const want = Buffer.from(sign(key, exp, params.get("dl") ?? ""));
  return Number(exp) > Date.now() / 1000 && got.length === want.length && timingSafeEqual(got, want);
}

export async function putObject(key: string, body: Uint8Array) {
  const file = localPath(key);
  if (!file) throw new Error(`Invalid storage key: ${key}`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
}

export async function readObject(key: string) {
  const file = localPath(key);
  if (!file) throw new Error(`Invalid storage key: ${key}`);
  return new Uint8Array(await readFile(file));
}

export async function copyObject(from: string, to: string) {
  const [src, dst] = [localPath(from), localPath(to)];
  if (!src || !dst) throw new Error(`Invalid storage key: ${src ? to : from}`);
  await mkdir(path.dirname(dst), { recursive: true });
  await copyFile(src, dst);
}

export async function objectExists(key: string) {
  const file = localPath(key);
  return file ? access(file).then(() => true, () => false) : false;
}

/** Short-lived signed URL to /api/files, or null when the file is gone. */
export async function signedFileUrl(key: string | null, opts: { expiresIn?: number; downloadName?: string } = {}) {
  return key && (await objectExists(key)) ? signedGetUrl(key, opts) : null;
}

/** Short-lived signed URL to /api/files. */
export async function signedGetUrl(key: string, opts: { expiresIn?: number; downloadName?: string } = {}) {
  const exp = String(Math.floor(Date.now() / 1000) + (opts.expiresIn ?? 3600));
  const dl = opts.downloadName ?? "";
  const q = new URLSearchParams({ exp, sig: sign(key, exp, dl), ...(dl ? { dl } : {}) });
  return `${env().APP_URL}/api/files/${key}?${q}`;
}

export async function deleteObjects(objectKeys: string[]) {
  await Promise.all(objectKeys.map((k) => localPath(k)).map((f) => f && rm(f, { force: true })));
}

/** Download a remote file (provider output) with size cap. */
export async function fetchBytes(url: string, init?: RequestInit, maxBytes = 200 * 1024 * 1024) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Download failed (${res.status}) from ${new URL(url).host}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new Error("Remote file too large");
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new Error("Remote file too large");
  return { bytes: buf, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
}

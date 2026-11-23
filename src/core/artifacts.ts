import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';

export const Artifact = z.object({ path: z.string(), downloadUrl: z.string().optional(), bytes: z.number(), sha256: z.string() });
export const outputDirectory = () => path.resolve(process.env.OUTPUT_DIR || './output');
export async function saveArtifact(filename: string, text: string): Promise<z.infer<typeof Artifact>> {
  const id = randomUUID(), folder = path.join(outputDirectory(), id), bytes = Buffer.from(text, 'utf8');
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, filename);
  await writeFile(file, bytes, { flag: 'wx' });
  return { path: file, ...(process.env.PUBLIC_BASE_URL ? { downloadUrl: `${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/files/${id}/${filename}` } : {}),
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

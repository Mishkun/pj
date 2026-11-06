import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../vendor/ticket/', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
for (const file of manifest.files) {
  const data = fs.readFileSync(path.join(root, file.path));
  const sha256 = createHash('sha256').update(data).digest('hex');
  const blob = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
  if (sha256 !== file.sha256 || blob !== file.gitBlob) throw new Error(`Vendor integrity failed: ${file.path}`);
}
for (const [name, target] of Object.entries(manifest.symlinks)) if (fs.readlinkSync(path.join(root, name)) !== target) throw new Error(`Vendor symlink changed: ${name}`);
console.log(`Verified ${manifest.files.length} upstream files at ${manifest.revision}`);

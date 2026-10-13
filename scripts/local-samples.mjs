// Real sessions on one machine, named for the checks (CX1, CL2…): their paths
// stay out of the repository, in local/samples.json (or $TICKBIRD_SAMPLES).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function localSamples() {
  const file = process.env.TICKBIRD_SAMPLES || join(dirname(dirname(fileURLToPath(import.meta.url))), 'local', 'samples.json');
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch {
    console.error(`这个检查读本机的真实会话。在 ${file} 写上 {"projectPath": "…", "claudeProjectDir": "…", "files": {"CX1": "…rollout….jsonl", "CL1": "….jsonl"}}`);
    process.exit(2);
  }
}

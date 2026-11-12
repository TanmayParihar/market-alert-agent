import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../src/types';

/** Loads .dev.vars (local use only) and lets real environment variables (GitHub Actions secrets) win. */
export function loadEnv(): Env {
  const out: Record<string, string> = {};
  const file = path.resolve(process.cwd(), '.dev.vars');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'CALLMEBOT_PHONE', 'CALLMEBOT_APIKEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'GITHUB_TOKEN', 'GITHUB_REPO', 'ADMIN_TOKEN', 'DRY_RUN']) {
    if (process.env[k]) out[k] = process.env[k]!;
  }
  return out as unknown as Env;
}

export function requireEnv(env: Env, keys: Array<keyof Env>): void {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    console.error(`Missing required secrets: ${missing.join(', ')}`);
    process.exit(2);
  }
}

export const hasFlag = (f: string) => process.argv.includes(f);
export const argValue = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

// npm run setup
// One interactive script for the few things only YOU can supply. It never prints or logs your secrets.
// It (1) asks for each missing value, (2) discovers your Telegram chat id for you, (3) stores every secret in
// Cloudflare (wrangler) AND GitHub Actions (gh) AND your local git-ignored .dev.vars, (4) sends the test alerts.
// Values already present in .dev.vars are reused, so you can re-run it safely.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';

const file = path.resolve(process.cwd(), '.dev.vars');
const cur: Record<string, string> = {};
if (fs.existsSync(file)) {
  for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l);
    if (m && !l.trim().startsWith('#')) cur[m[1]] = m[2];
  }
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>((r) => rl.question(q, (a) => r(a.trim())));
const save = () => fs.writeFileSync(file, Object.entries(cur).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');

async function need(key: string, prompt: string, opts: { optional?: boolean; validate?: (v: string) => string | null } = {}) {
  if (cur[key]) { console.log(`  ✓ ${key} already set`); return; }
  for (;;) {
    const v = await ask(`${prompt}${opts.optional ? ' (Enter to skip)' : ''}: `);
    if (!v && opts.optional) return;
    const bad = v ? opts.validate?.(v) ?? null : 'required';
    if (bad) { console.log(`  ✗ ${bad}`); continue; }
    cur[key] = v; save(); return;
  }
}

console.log('\n=== Market-alert agent: secrets setup ===\n');
console.log('1/4  Supabase. Dashboard -> Project Settings -> API Keys -> "Secret key" (sb_secret_...). Keep it private.');
await need('SUPABASE_SERVICE_KEY', 'Paste the Supabase SECRET key', { validate: (v) => (v.startsWith('sb_secret_') || v.startsWith('eyJ') ? null : 'expected sb_secret_... (or a legacy service_role JWT)') });

console.log('\n2/4  Telegram. In Telegram open @BotFather -> /newbot -> copy the token. Then open YOUR new bot and send it any message.');
await need('TELEGRAM_BOT_TOKEN', 'Paste the Telegram bot token', { validate: (v) => (/^\d+:[A-Za-z0-9_-]{20,}$/.test(v) ? null : 'that does not look like a bot token') });
if (!cur.TELEGRAM_CHAT_ID) {
  for (;;) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${cur.TELEGRAM_BOT_TOKEN}/getUpdates`);
      const j: any = await r.json();
      const chat = [...(j.result ?? [])].reverse().map((u: any) => u.message?.chat ?? u.my_chat_member?.chat).find((c: any) => c?.type === 'private');
      if (chat) { cur.TELEGRAM_CHAT_ID = String(chat.id); save(); console.log(`  ✓ found your chat id (${chat.first_name ?? 'you'})`); break; }
      if (!j.ok) console.log(`  ✗ Telegram says: ${j.description}`);
    } catch { /* retry */ }
    await ask('  Send any message to your bot in Telegram, then press Enter to retry ');
  }
}

console.log('\n3/4  WhatsApp via CallMeBot is OPTIONAL. If callmebot.com says "the bot is currently full" (as it did on 2026-11-13),');
console.log('     press Enter twice: everything is delivered on Telegram until you add WhatsApp later (just re-run this script).');
console.log('     When slots open: save the bot number shown on callmebot.com, WhatsApp it "I allow callmebot to send me messages",');
console.log('     then paste your number and the API key it replies with.');
await need('CALLMEBOT_PHONE', 'Your WhatsApp number, e.g. +91XXXXXXXXXX', { optional: true, validate: (v) => (/^\+\d{8,15}$/.test(v) ? null : 'use the form +91XXXXXXXXXX') });
if (cur.CALLMEBOT_PHONE) await need('CALLMEBOT_APIKEY', 'The CallMeBot API key', { optional: true });
if (!cur.CALLMEBOT_PHONE || !cur.CALLMEBOT_APIKEY) console.log('  -> Telegram-only mode (WhatsApp skipped).');

console.log('\n4/4  Optional extras (press Enter to skip; the agent works without them)');
console.log('     Groq key (console.groq.com/keys) = better news scoring. Without it Cloudflare Workers AI + keywords are used.');
await need('GROQ_API_KEY', 'Groq API key', { optional: true });
console.log('     GitHub token for the Worker safeguards (fine-grained PAT, this repo only, Actions: read+write).');
await need('GITHUB_TOKEN', 'GitHub fine-grained token', { optional: true });
rl.close();

// ---- distribute: Cloudflare + GitHub + (already) .dev.vars
const SECRETS = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'CALLMEBOT_PHONE', 'CALLMEBOT_APIKEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'GROQ_API_KEY', 'GITHUB_TOKEN', 'GITHUB_REPO', 'ADMIN_TOKEN'];
const GH_SECRETS = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'CALLMEBOT_PHONE', 'CALLMEBOT_APIKEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
const sh = process.platform === 'win32';
const run = (cmd: string, args: string[], input: string) => spawnSync(cmd, args, { input, shell: sh, encoding: 'utf8' });

// ---- make sure THIS terminal is logged in to Cloudflare and GitHub (logins made in another shell/profile are not shared)
console.log('\nChecking Cloudflare and GitHub logins in this terminal...');
const probe = (cmd: string, args: string[]) => { const r = spawnSync(cmd, args, { shell: sh, encoding: 'utf8' }); return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }; };
const cf = probe('npx', ['wrangler', 'whoami']);
if (!/logged in/i.test(cf.out) || /not authenticated/i.test(cf.out)) {
  console.log('  Cloudflare: not logged in here. A browser will open: sign in with the account that hosts the Worker, then click Allow.');
  spawnSync('npx', ['wrangler', 'login'], { shell: sh, stdio: 'inherit' });
} else console.log('  ✓ Cloudflare logged in');
const ghs = probe('gh', ['auth', 'status']);
if (ghs.status !== 0) {
  console.log('  GitHub: not logged in here. Follow the prompts (browser, one-time code).');
  spawnSync('gh', ['auth', 'login', '-h', 'github.com', '-p', 'https', '-s', 'repo,workflow', '-w'], { shell: sh, stdio: 'inherit' });
} else if (!/workflow/.test(ghs.out)) {
  console.log('  GitHub: adding the "workflow" permission (browser, one-time code).');
  spawnSync('gh', ['auth', 'refresh', '-h', 'github.com', '-s', 'workflow'], { shell: sh, stdio: 'inherit' });
} else console.log('  ✓ GitHub logged in');
const hasWorker = probe('npx', ['wrangler', 'secret', 'list', '--name', 'market-alert-agent']);
if (hasWorker.status !== 0) {
  console.error('\n✗ The Worker "market-alert-agent" was not found on the Cloudflare account you are logged in to.\n  Run `npx wrangler logout`, then `npm run setup` again and sign in with admin.lumira@gmail.com (the account that hosts it).');
  process.exit(1);
}

console.log('\nStoring secrets in Cloudflare (Worker)...');
for (const k of SECRETS) {
  if (!cur[k]) continue;
  const r = run('npx', ['wrangler', 'secret', 'put', k], cur[k]);
  console.log(`  ${r.status === 0 ? '✓' : '✗'} ${k}${r.status === 0 ? '' : '  (' + (r.stderr || r.stdout).split('\n').find((l) => /error/i.test(l)) + ')'}`);
}
console.log('\nStoring secrets in GitHub Actions...');
for (const k of GH_SECRETS) {
  if (!cur[k]) { console.log(`  - ${k} not set, skipped`); continue; }
  const r = run('gh', ['secret', 'set', k, '--repo', cur.GITHUB_REPO], cur[k]);
  console.log(`  ${r.status === 0 ? '✓' : '✗'} ${k}${r.status === 0 ? '' : '  (' + (r.stderr || '').trim().split('\n')[0] + ')'}`);
}

console.log('\nEnabling the GitHub workflows (paused until now so they would not fail before your secrets existed)...');
for (const w of ['heartbeat.yml', 'digest.yml', 'calendar.yml', 'weekly-review.yml']) {
  const r = run('gh', ['workflow', 'enable', w, '--repo', cur.GITHUB_REPO], '');
  console.log(`  ${r.status === 0 ? '✓' : '✗'} ${w}`);
}
run('gh', ['workflow', 'run', 'calendar.yml', '--repo', cur.GITHUB_REPO], ''); // fill the macro calendar right away

console.log('\nSending one test alert of each severity to your phone...');
const t = spawnSync('npm', ['run', 'test:alerts'], { shell: sh, stdio: 'inherit' });
console.log(t.status === 0 ? `\nAll done. Expect ${cur.CALLMEBOT_APIKEY ? '4 WhatsApp messages and 2 Telegram messages (HIGH and WORLD-ENDING go to both)' : '4 Telegram messages (WhatsApp is not configured)'}.\n` : '\nSome test messages did not arrive: see the table above and the README troubleshooting section.\n');

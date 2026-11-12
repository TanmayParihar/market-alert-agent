// npm run test:alerts        -> sends one sample alert of each severity through the REAL channels
// npm run test:alerts:dry    -> prints them instead of sending
import { config } from '../agent.config';
import { sendSamples } from '../src/notify/samples';
import { hasFlag, loadEnv, requireEnv } from './_env';

const env = loadEnv();
const dry = hasFlag('--dry');
if (!dry) requireEnv(env, ['CALLMEBOT_PHONE', 'CALLMEBOT_APIKEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);

const res = await sendSamples(env, config, { dryRun: dry });
console.table(res);
const failed = res.filter((r) => r.whatsapp === false && r.telegram !== true);
if (!dry && failed.length) {
  console.error('Some samples reached NO channel. Check CallMeBot activation / Telegram chat id (see README).');
  process.exit(1);
}

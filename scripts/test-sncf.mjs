// Test du flux SNCF sans Cloudflare : node scripts/test-sncf.mjs
import { archive } from '../src/providers/sncf.js';

const rows = [];
const db = {
  prepare: () => ({ bind: (...a) => a }),
  batch: async list => { rows.push(...list); },
};

const n = await archive({ MOCK: '0' }, db);
console.log(`${n} lignes a archiver (retard >= 25 min ou train supprime)`);
for (const r of rows.slice(0, 10)) console.log(`train ${r[0]} du ${r[1]} a ${r[2]} : ${r[6] ? 'supprime' : r[5] + ' min de retard'}`);

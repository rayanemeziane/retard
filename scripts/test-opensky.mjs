// Test OpenSky sans Cloudflare : node scripts/test-opensky.mjs
// Demande les identifiants OpenSky (non affiches), puis cherche l'atterrissage du vol XK751 du 22/09/2026 a Figari.
import { openskyArrival } from '../src/providers/flights.js';
import { createInterface } from 'node:readline';

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl._writeToOutput = s => { if (s.includes(question)) rl.output.write(s); }; // masque la saisie
  return new Promise(r => rl.question(question, a => { rl.close(); console.log(); r(a.trim()); }));
}

const env = { OPENSKY_CLIENT_ID: await ask('client_id : '), OPENSKY_CLIENT_SECRET: await ask('client_secret : ') };
const flight = {
  number: 'XK751', airlineIcao: 'CCM', arrSchedUtc: '2026-09-22T09:15Z',
  dep: { icao: 'LFPO' }, arr: { icao: 'LFKF' },
};
const landed = await openskyArrival(env, flight);
if (!landed) console.log('OpenSky n\'a pas trouve ce vol.');
else console.log(`Derniere detection radar : ${new Date(landed).toISOString()} (UTC), soit un retard d'environ ${Math.round((landed + 300000 - Date.parse(flight.arrSchedUtc)) / 60000)} min`);

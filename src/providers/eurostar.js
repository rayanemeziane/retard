// Eurostar : pas d'API publique. On archive les arrivees Eurostar vues par
// les reseaux belge (iRail, gratuit, sans cle) et neerlandais (NS, cle gratuite).
// Couverture partielle : Paris-Nord, Lille et Londres ne sont pas couverts.

import { upsert } from './sncf.js';

const IRAIL_STATIONS = { 'BE.NMBS.008814001': 'Bruxelles-Midi' };
const NS_STATIONS = { ASD: 'Amsterdam Centraal', RTD: 'Rotterdam Centraal' };

export async function archive(env, db) {
  if (env.MOCK === '1') return 0;
  const now = new Date().toISOString();
  let count = 0;

  for (const [id, name] of Object.entries(IRAIL_STATIONS)) {
    try {
      const res = await fetch(`https://api.irail.be/liveboard/?id=${id}&arrdep=arrival&format=json&alerts=false`, {
        headers: { 'User-Agent': 'retards-indemnites/0.1 (projet personnel)' },
      });
      const data = await res.json();
      for (const a of data.arrivals?.arrival || []) {
        const type = (a.vehicleinfo?.type || '').toUpperCase();
        if (!['EUR', 'EST', 'THA'].includes(type)) continue;
        const planned = new Date(Number(a.time) * 1000);
        const delay = Math.round(Number(a.delay || 0) / 60);
        await upsert(db, 'eurostar', a.vehicleinfo.number, planned.toISOString().slice(0, 10), name,
          planned.toISOString(), new Date(planned.getTime() + delay * 60000).toISOString(), delay, a.canceled === '1', now);
        count++;
      }
    } catch { /* source suivante */ }
  }

  if (env.NS_KEY) {
    for (const [code, name] of Object.entries(NS_STATIONS)) {
      try {
        const res = await fetch(`https://gateway.apiportal.ns.nl/reisinformatie-api/api/v2/arrivals?station=${code}&maxJourneys=60`, {
          headers: { 'Ocp-Apim-Subscription-Key': env.NS_KEY },
        });
        const data = await res.json();
        for (const a of data.payload?.arrivals || []) {
          if (!/eurostar/i.test(a.product?.operatorName || '')) continue;
          const planned = a.plannedDateTime, actual = a.actualDateTime || planned;
          const delay = Math.round((Date.parse(actual) - Date.parse(planned)) / 60000);
          await upsert(db, 'eurostar', a.product.number, planned.slice(0, 10), name, planned, actual, delay, !!a.cancelled, now);
          count++;
        }
      } catch { /* gare suivante */ }
    }
  }
  return count;
}

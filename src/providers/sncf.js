// SNCF : flux temps reel open data (GTFS-RT, sans cle), TGV INOUI, OUIGO, Intercites et TER
// https://transport.data.gouv.fr/datasets (jeu "Reseau SNCF TGV, Intercites et TER")
// Le flux ne donne que les trains du jour : l'historique vient de l'archive (tache toutes les 10 minutes).

import GARES from './gares.js';

const FEED = 'https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-trip-updates';
const MIN_DELAY = 25; // en dessous, aucune indemnite : inutile d'archiver

export async function searchStations() {
  return [];
}

export async function findTrainsByRoute() {
  throw new Error('Recherche par trajet indisponible pour la SNCF : saisissez le numero du train (il figure sur votre billet).');
}

// --- Lecture minimale du format protobuf (GTFS-RT) ---
function varint(b, p) {
  let r = 0, s = 0, c;
  // on ne garde que les 35 premiers bits : suffisant pour les longueurs, horaires et retards
  do { c = b[p.i++]; if (s < 35) r += (c & 0x7f) * 2 ** s; s += 7; } while (c >= 0x80);
  return r;
}

// Appelle fn(numero de champ, valeur) ; valeur = nombre ou sous-tableau d'octets
function each(b, fn) {
  const p = { i: 0 };
  while (p.i < b.length) {
    const key = varint(b, p), f = Math.floor(key / 8), w = key & 7;
    if (w === 0) fn(f, varint(b, p));
    else if (w === 2) { const n = varint(b, p); fn(f, b.subarray(p.i, p.i + n)); p.i += n; }
    else if (w === 1) p.i += 8;
    else if (w === 5) p.i += 4;
    else throw new Error('protobuf invalide');
  }
}

const text = new TextDecoder();
// int32 negatif (avance) encode sur 10 octets : on relit les 32 bits de poids faible
const toInt = v => { const x = v % 2 ** 32; return x >= 2 ** 31 ? x - 2 ** 32 : x; };

// TripUpdate -> { number, date, cancelled, stops: [{ uic, delay, time, skipped }] }
function readTrip(b) {
  const t = { stops: [] };
  each(b, (f, v) => {
    if (f === 1) each(v, (g, w) => {
      if (g === 1) t.tripId = text.decode(w);
      else if (g === 3) t.startDate = text.decode(w);
      else if (g === 4) t.cancelled = w === 3;
    });
    else if (f === 2) {
      const s = {};
      each(v, (g, w) => {
        if (g === 4) s.stopId = text.decode(w);
        else if (g === 5) s.skipped = w === 1;
        else if (g === 2) each(w, (h, x) => { if (h === 1) s.delay = toInt(x); else if (h === 2) s.time = x; });
      });
      if (s.stopId) t.stops.push(s);
    }
  });
  return t;
}

const uicOf = stopId => (stopId.match(/(\d{8})$/) || [])[1];
const stationName = uic => GARES[uic] || `gare ${uic}`;
const iso = sec => (sec ? new Date(sec * 1000).toISOString() : null);

// --- Archive : appelee toutes les 10 minutes ---
// On n'enregistre que les gares ou le train a au moins MIN_DELAY minutes de retard,
// est supprime ou ne s'arrete pas. Un train absent de l'archive = pas de retard indemnisable.
export async function archive(env, db) {
  if (env.MOCK === '1') return 0;
  const res = await fetch(FEED);
  if (!res.ok) throw new Error(`flux SNCF ${res.status}`);
  const feed = new Uint8Array(await res.arrayBuffer());
  const now = new Date().toISOString();
  const rows = [];

  each(feed, (f, entity) => {
    if (f !== 2) return;
    each(entity, (g, tu) => {
      if (g !== 3) return;
      const t = readTrip(tu);
      const number = (t.tripId?.match(/^OCESN(\d+)/) || [])[1];
      if (!number || !t.startDate) return;
      const date = `${t.startDate.slice(0, 4)}-${t.startDate.slice(4, 6)}-${t.startDate.slice(6, 8)}`;
      const last = t.stops[t.stops.length - 1];
      for (const s of t.stops) {
        const cancelled = t.cancelled || s.skipped;
        const delayMin = s.delay == null ? null : Math.round(s.delay / 60);
        if (!cancelled && !(delayMin >= MIN_DELAY)) continue;
        if (t.cancelled && s !== last) continue; // train supprime : une seule ligne suffit
        const uic = uicOf(s.stopId);
        rows.push([number, date, stationName(uic), iso(s.time && s.time - (s.delay || 0)), iso(s.time), cancelled ? null : delayMin, cancelled]);
      }
    });
  });

  // Ecriture par paquets ; une ligne deja a jour n'est pas reecrite (quota d'ecritures D1)
  const sql = db.prepare(
    `INSERT INTO train_delays (operator, train_number, service_date, station, planned_arr, actual_arr, delay_min, cancelled, updated_at)
     VALUES ('sncf', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT (operator, train_number, service_date, station) DO UPDATE SET
       actual_arr = excluded.actual_arr, delay_min = excluded.delay_min, cancelled = excluded.cancelled, updated_at = excluded.updated_at
     WHERE delay_min IS NOT excluded.delay_min OR cancelled IS NOT excluded.cancelled`
  );
  for (let i = 0; i < rows.length; i += 100) {
    await db.batch(rows.slice(i, i + 100).map(r => sql.bind(r[0], r[1], r[2], r[3], r[4], r[5], r[6] ? 1 : 0, now)));
  }
  return rows.length;
}

export async function upsert(db, operator, number, date, station, planned, actual, delay, cancelled, now) {
  await db.prepare(
    `INSERT INTO train_delays (operator, train_number, service_date, station, planned_arr, actual_arr, delay_min, cancelled, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT (operator, train_number, service_date, station) DO UPDATE SET
       actual_arr = excluded.actual_arr, delay_min = excluded.delay_min, cancelled = excluded.cancelled, updated_at = excluded.updated_at`
  ).bind(operator, String(number), date, station || '?', planned, actual, delay, cancelled ? 1 : 0, now).run();
}

// Trenitalia : API non officielle de ViaggiaTreno (peut changer sans preavis).
// - andamentoTreno : retard gare par gare d'un train (jours recents uniquement)
// - arrivi : tableau des arrivees d'une gare, archive par la tache planifiee

import { upsert } from './sncf.js';

const BASE = 'http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno';
// Grandes gares archivees (code ViaggiaTreno). Ajouter des gares ici si besoin.
const STATIONS = {
  S01700: 'Milano Centrale', S08409: 'Roma Termini', S00219: 'Torino Porta Nuova',
  S09218: 'Napoli Centrale', S06421: 'Firenze S.M.N.', S02593: 'Venezia S. Lucia', S05043: 'Bologna Centrale',
};

async function vt(path, asText = false) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`ViaggiaTreno ${res.status}`);
  return asText ? res.text() : res.json();
}

// Trouve l'origine d'un train (necessaire pour andamentoTreno) a une date donnee
async function locate(number, date) {
  const txt = await vt(`/cercaNumeroTrenoTrenoAutocomplete/${number}`, true);
  const found = txt.trim().split('\n').filter(Boolean).map(l => {
    const [, origin, ms] = l.split('|')[1].split('-');
    return { origin, ms, date: new Date(Number(ms)).toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }) };
  });
  return found.find(f => f.date === date) || found[0] || null;
}

// Retard d'un train : on tente l'API en direct (jours recents), sinon l'archive
export async function trainStatus(env, db, number, date) {
  if (env.MOCK === '1') return mock(number, date);
  try {
    const loc = await locate(number, date);
    if (loc) {
      const t = await vt(`/andamentoTreno/${loc.origin}/${number}/${loc.ms}`);
      if (t?.fermate?.length) {
        const stops = t.fermate.filter(f => f.arrivo_teorico).map(f => ({
          station: f.stazione,
          delayMin: f.arrivoReale ? Math.round((f.arrivoReale - f.arrivo_teorico) / 60000) : null,
          cancelled: f.actualFermataType === 3,
        }));
        return { operator: 'trenitalia', number: String(number), product: t.categoria, cancelled: t.provvedimento === 1, stops, source: 'live' };
      }
    }
  } catch { /* on bascule sur l'archive */ }
  return fromArchive(db, 'trenitalia', number, date);
}

export async function fromArchive(db, operator, number, date) {
  const { results } = await db.prepare(
    'SELECT station, delay_min, cancelled FROM train_delays WHERE operator = ?1 AND train_number = ?2 AND service_date = ?3 ORDER BY planned_arr'
  ).bind(operator, String(number), date).all();
  if (!results.length) return null;
  return {
    operator, number: String(number), cancelled: results.every(r => r.cancelled),
    stops: results.map(r => ({ station: r.station, delayMin: r.delay_min, cancelled: !!r.cancelled })), source: 'archive',
  };
}

export async function searchStations(env, q) {
  if (env.MOCK === '1') return Object.entries(STATIONS).map(([id, name]) => ({ id, name })).filter(s => s.name.toLowerCase().includes(q.toLowerCase()));
  const txt = await vt(`/autocompletaStazione/${encodeURIComponent(q)}`, true);
  return txt.trim().split('\n').filter(Boolean).slice(0, 8).map(l => { const [name, id] = l.split('|'); return { id, name }; });
}

// Trains d'un trajet a une date (API de recherche d'itineraires de ViaggiaTreno)
export async function findTrainsByRoute(env, fromId, toId, date) {
  if (env.MOCK === '1') return [{ operator: 'trenitalia', number: '9541', product: 'FR', depLocal: `${date} 09:00`, arrLocal: `${date} 12:10` }];
  const strip = id => id.replace(/^S0*/, '');
  const data = await vt(`/soluzioniViaggioNew/${strip(fromId)}/${strip(toId)}/${date}T00:00:00`);
  const out = [];
  for (const s of data?.soluzioni || []) {
    if (s.vehicles?.length !== 1) continue;
    const v = s.vehicles[0];
    out.push({ operator: 'trenitalia', number: v.numeroTreno, product: v.categoriaDescrizione, depLocal: v.orarioPartenza.replace('T', ' ').slice(0, 16), arrLocal: v.orarioArrivo.replace('T', ' ').slice(0, 16) });
  }
  return out;
}

// --- Archive : tableau des arrivees des grandes gares ---
export async function archive(env, db) {
  if (env.MOCK === '1') return 0;
  const now = new Date();
  const stamp = encodeURIComponent(now.toString());
  let count = 0;
  for (const [code, name] of Object.entries(STATIONS)) {
    try {
      const list = await vt(`/arrivi/${code}/${stamp}`);
      for (const a of list || []) {
        if (!a.numeroTreno || !a.millisDataArrivo) continue;
        const date = new Date(a.dataPartenzaTreno || a.millisDataArrivo).toISOString().slice(0, 10);
        const planned = new Date(a.millisDataArrivo).toISOString();
        await upsert(db, 'trenitalia', a.numeroTreno, date, name, planned, null, a.ritardo ?? null, !!a.nonPartito, now.toISOString());
        count++;
      }
    } catch { /* une gare en erreur ne bloque pas les autres */ }
  }
  return count;
}

function mock(number, date) {
  return { operator: 'trenitalia', number: String(number), product: 'FR', cancelled: false, source: 'demo',
    stops: [{ station: 'Milano Centrale', delayMin: 5 }, { station: 'Roma Termini', delayMin: 72 }] };
}

import { evaluateFlight, evaluateTrain, fmtDelay } from './rules.js';
import * as flights from './providers/flights.js';
import * as sncf from './providers/sncf.js';
import * as trenitalia from './providers/trenitalia.js';
import * as eurostar from './providers/eurostar.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = Object.fromEntries(url.searchParams);
    try {
      if (url.pathname === '/api/places') return json(await places(env, p));
      if (url.pathname === '/api/route') return json(await route(env, p));
      if (url.pathname === '/api/check') return json(await check(env, p));
      if (url.pathname === '/api/health') return json(await health(env));
    } catch (e) {
      return json({ error: e.message }, 502);
    }
    return env.ASSETS.fetch(req); // page web (dossier public/)
  },

  // Tache planifiee : archive des retards train + purge
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runArchive(env));
  },
};

async function runArchive(env) {
  const counts = {};
  for (const [name, mod] of Object.entries({ sncf, trenitalia, eurostar })) {
    try { counts[name] = await mod.archive(env, env.DB); } catch (e) { counts[name] = 'erreur: ' + e.message; }
  }
  const days = Number(env.ARCHIVE_DAYS || 400);
  await env.DB.prepare(`DELETE FROM train_delays WHERE service_date < date('now', ?1)`).bind(`-${days} days`).run();
  console.log('archive', JSON.stringify(counts));
}

// --- Autocompletion des gares / aeroports ---
async function places(env, { mode, q = '' }) {
  if (q.length < 2) return [];
  if (mode === 'flight') return flights.searchAirports(env, q);
  if (mode === 'sncf') return sncf.searchStations(env, q);
  if (mode === 'trenitalia') return trenitalia.searchStations(env, q);
  return [];
}

// --- Liste des vols / trains d'un trajet ---
async function route(env, { mode, from, to, date }) {
  if (!from || !to || !date) throw new Error('Depart, arrivee et date requis');
  if (mode === 'flight') return flights.findFlightsByRoute(env, from, to, date);
  if (mode === 'sncf') return sncf.findTrainsByRoute(env, from, to, date);
  if (mode === 'trenitalia') return trenitalia.findTrainsByRoute(env, from, to, date);
  throw new Error('Recherche par trajet indisponible pour ce transporteur : saisissez le numero du train.');
}

// --- Verification d'eligibilite ---
async function check(env, p) {
  const { mode, number, date } = p;
  if (!number || !date) throw new Error('Numero et date requis');

  if (mode === 'flight') {
    const list = await flights.findFlightByNumber(env, number, date);
    if (!list.length) return { found: false, message: 'Vol introuvable a cette date. Verifiez le numero (ex. AF1234) et la date de depart.' };
    const f = list[0];
    const answers = p.notice14 ? { noticeOver14Days: p.notice14 === 'yes' } : {};
    const ev = evaluateFlight(f, answers);
    return { found: true, trip: f, evaluation: ev, letter: ev.verdict === 'yes' || ev.verdict === 'maybe' ? flightLetter(f, ev) : null };
  }

  if (['sncf', 'trenitalia', 'eurostar'].includes(mode)) {
    const status = await trainStatus(env, mode, number, date);
    if (!status) return { found: false, message: noTrainData(mode) };
    const stop = pickStop(status, p.dest);
    const trip = { operator: mode, number, product: p.product || status.product, delayMin: stop?.delayMin ?? null, cancelled: status.cancelled || stop?.cancelled, station: stop?.station, stops: status.stops, source: status.source };
    const ev = evaluateTrain(trip, p.price ? Number(p.price) : null);
    return { found: true, trip, evaluation: ev, letter: ev.verdict === 'yes' ? trainLetter(trip, ev, date) : null };
  }
  throw new Error('Mode inconnu');
}

async function trainStatus(env, mode, number, date) {
  if (env.MOCK === '1' && mode !== 'trenitalia') return {
    operator: mode, number, product: mode === 'sncf' ? 'INOUI' : 'EUR', cancelled: false, source: 'demo',
    stops: [{ station: 'Gare intermediaire', delayMin: 40 }, { station: 'Gare terminus', delayMin: 95 }],
  };
  if (mode === 'trenitalia') return trenitalia.trainStatus(env, env.DB, number, date);
  const archived = await trenitalia.fromArchive(env.DB, mode, number, date);
  if (archived) return archived;
  // SNCF : un train absent de l'archive n'avait aucune perturbation signalee,
  // a condition que l'archive tournait deja ce jour-la.
  if (mode === 'sncf') {
    const row = await env.DB.prepare(`SELECT MIN(service_date) AS start FROM train_delays WHERE operator = 'sncf'`).first();
    if (row?.start && date >= row.start) return { operator: 'sncf', number, cancelled: false, source: 'archive', stops: [{ station: 'terminus', delayMin: 0 }] };
  }
  return null;
}

// Retard retenu : celui de la gare de destination de l'usager, sinon le dernier arret connu
function pickStop(status, dest) {
  const stops = status.stops || [];
  if (dest) {
    const d = dest.toLowerCase();
    const hit = stops.find(s => (s.station || '').toLowerCase().includes(d) || d.includes((s.station || '').toLowerCase()));
    if (hit) return hit;
  }
  return stops[stops.length - 1];
}

function noTrainData(mode) {
  if (mode === 'eurostar') return 'Aucune donnee pour ce train Eurostar. Notre suivi ne couvre que les arrivees a Bruxelles, Rotterdam et Amsterdam : faites votre demande directement sur eurostar.com, Eurostar verifie le retard de son cote.';
  return 'Aucune donnee de retard pour ce train a cette date. Notre archive ne couvre que les trajets depuis son lancement.';
}

async function health(env) {
  const row = await env.DB.prepare(`SELECT operator, COUNT(*) AS n, MIN(service_date) AS since, MAX(updated_at) AS last FROM train_delays GROUP BY operator`).all();
  return { mock: env.MOCK === '1', archive: row.results };
}

// --- Lettres de reclamation ---
const CLAIM_LINKS = {
  sncf: 'https://www.sncf-connect.com/aide/garantie-g30',
  trenitalia: 'https://www.trenitalia.com/fr/informations/indemnites.html',
  eurostar: 'https://www.eurostar.com/fr-fr/service-clientele/compensation',
};

function flightLetter(f, ev) {
  return {
    to: `Service clientele / reclamations de ${f.airline || 'la compagnie'}`,
    body:
`Objet : Demande d'indemnisation - vol ${f.number} du ${f.dep.scheduledLocal?.slice(0, 10)} (reglement CE 261/2004)

Madame, Monsieur,

J'etais passager du vol ${f.number} de ${f.dep.name} (${f.dep.iata}) a ${f.arr.name} (${f.arr.iata}), prevu a l'arrivee le ${f.arr.scheduledLocal}.
${f.cancelled ? 'Ce vol a ete annule.' : `Ce vol est arrive avec un retard de ${fmtDelay(f.delayMin)}.`}

Conformement aux articles 5 et 7 du reglement (CE) n° 261/2004 et a la jurisprudence de la CJUE (arret Sturgeon, C-402/07), je vous demande le versement de l'indemnite forfaitaire de ${ev.amount ?? '[montant]'} €, la distance du vol etant d'environ ${ev.distanceKm ?? '[distance]'} km.

Je vous remercie de proceder au virement sous 30 jours sur le compte suivant : [IBAN].
A defaut de reponse, je saisirai le Mediateur Tourisme et Voyage.

Nom : [Nom Prenom]
Reference de reservation : [PNR]
Pieces jointes : carte d'embarquement, confirmation de reservation.

Cordialement,
[Signature]`,
  };
}

function trainLetter(t, ev, date) {
  return {
    to: `Service clientele ${t.operator.toUpperCase()}`,
    link: CLAIM_LINKS[t.operator],
    body:
`Objet : Demande d'indemnisation - train ${t.number} du ${date}

Madame, Monsieur,

J'etais voyageur du train ${t.number} du ${date}, arrive a ${t.station || '[gare d\'arrivee]'} avec un retard de ${fmtDelay(t.delayMin)}.

Conformement a ${ev.scale === 'Reglement UE 2021/782' ? 'l\'article 19 du reglement (UE) 2021/782' : 'vos conditions de compensation (' + ev.scale + ')'}, je vous demande le versement d'une indemnite de ${ev.pct} % du prix de mon billet${ev.amount ? `, soit ${ev.amount} €` : ''}.

Nom : [Nom Prenom]
Reference de reservation : [Reference]
Piece jointe : billet.

Cordialement,
[Signature]`,
  };
}

// Regles d'indemnisation. Tous les baremes sont centralises ici.
// Les baremes propres aux compagnies (G30 SNCF, Eurostar) sont a revalider
// regulierement sur leurs sites : ils changent sans prevenir.

// Pays ou s'applique le reglement CE 261/2004 (UE + EEE + Suisse)
const EU261_COUNTRIES = new Set([
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU',
  'MT','NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO','CH',
  // Regions ultraperipheriques rattachees (codes ISO propres)
  'GP','MQ','GF','RE','YT','MF',
]);

// Principales compagnies europeennes (code IATA) : utile pour un vol
// au depart d'un pays tiers vers l'UE, couvert seulement si la compagnie est europeenne.
const EU_CARRIERS = new Set([
  'AF','KL','LH','LX','OS','SN','IB','VY','I2','UX','TP','AZ','EI','FR','U2','EC','EJ','W6','W4',
  'SK','AY','LO','A3','OA','BT','TO','HV','DY','D8','EW','4U','DE','XQ','SS','TX','BF','HF',
  'V7','2W','UX','NT','FB','RO','OU','JU','JP','EN','WK','ZB',
]);

const R = 6371;
export function distanceKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

// ---------- AVION : reglement CE 261/2004 ----------
// flight = { airlineIata, dep:{country, location}, arr:{country, location},
//            delayMin, cancelled, diverted }
// answers = { noticeOver14Days?: boolean }
export function evaluateFlight(flight, answers = {}) {
  const depEU = EU261_COUNTRIES.has(flight.dep.country);
  const arrEU = EU261_COUNTRIES.has(flight.arr.country);
  const euCarrier = EU_CARRIERS.has(flight.airlineIata);

  if (!depEU && !(arrEU && euCarrier)) {
    if (arrEU) return result('maybe', 0, 'Vol vers l\'UE au depart d\'un pays tiers : couvert seulement si la compagnie est europeenne. Nous n\'avons pas pu le confirmer.');
    return result('no', 0, 'Ce vol n\'est pas couvert par le reglement europeen (ni depart de l\'UE, ni compagnie europeenne a destination de l\'UE).');
  }

  const km = distanceKm(flight.dep.location, flight.arr.location);
  const intraEU = depEU && arrEU;
  let amount;
  if (km == null) amount = null;
  else if (km <= 1500) amount = 250;
  else if (intraEU || km <= 3500) amount = 400;
  else amount = 600;

  const base = { distanceKm: km };

  if (flight.cancelled) {
    if (answers.noticeOver14Days === true)
      return result('no', 0, 'Vol annule mais vous avez ete prevenu plus de 14 jours avant : pas d\'indemnite (remboursement ou reacheminement seulement).', base);
    if (answers.noticeOver14Days === undefined)
      return result('question', amount, 'Vol annule. Avez-vous ete prevenu plus de 14 jours avant le depart ?', { ...base, ask: 'noticeOver14Days' });
    return result('yes', amount, 'Vol annule moins de 14 jours avant le depart.', base);
  }

  if (flight.delayMin == null)
    return result('unknown', 0, 'Nous n\'avons pas pu determiner l\'heure d\'arrivee reelle de ce vol.', base);

  if (flight.delayMin >= 180)
    return result('yes', amount, `Arrivee avec ${fmtDelay(flight.delayMin)} de retard (seuil : 3 h).`, {
      ...base,
      caveat: 'Sauf circonstances extraordinaires (meteo, greve du controle aerien, risque securite) : la compagnie devra le prouver.',
    });

  if (flight.delayMin >= 165)
    return result('maybe', amount, `Arrivee avec ${fmtDelay(flight.delayMin)} de retard, juste sous le seuil de 3 h. Le retard legal se mesure a l'ouverture des portes, souvent quelques minutes apres : reclamez quand meme.`, base);

  return result('no', 0, `Arrivee avec ${fmtDelay(flight.delayMin)} de retard : sous le seuil de 3 h.`, base);
}

// ---------- TRAIN ----------
// trip = { operator: 'sncf'|'trenitalia'|'eurostar', product?: 'INOUI'|'OUIGO'|'INTERCITES'|'TER'|...,
//          delayMin, cancelled }
// price = prix du billet (optionnel)
export function evaluateTrain(trip, price) {
  if (trip.cancelled)
    return result('yes', null, 'Train supprime : vous avez droit au remboursement integral ou a un reacheminement, et a une indemnite si vous arrivez en retard par le train de remplacement.', {});

  if (trip.delayMin == null)
    return result('unknown', 0, 'Nous n\'avons pas de donnee de retard pour ce train a cette date.', {});

  const scale = trainScale(trip);
  const tier = scale.tiers.find(t => trip.delayMin >= t.min && trip.delayMin <= t.max);
  if (!tier)
    return result('no', 0, `Retard de ${fmtDelay(trip.delayMin)} : sous le seuil d'indemnisation (${scale.minLabel}).`, { scale: scale.name });

  const amount = price ? Math.round(price * tier.pct) / 100 : null;
  if (amount != null && amount < 4 && scale.eu)
    return result('no', 0, 'Indemnite inferieure a 4 € : non versee selon le reglement europeen.', { scale: scale.name });

  return result('yes', amount, `Retard de ${fmtDelay(trip.delayMin)} : ${tier.pct} % du prix du billet${tier.note ? ' (' + tier.note + ')' : ''}.`, {
    pct: tier.pct, scale: scale.name, needsPrice: price == null,
  });
}

function trainScale(trip) {
  const EU = { name: 'Reglement UE 2021/782', eu: true, minLabel: '60 min', tiers: [
    { min: 60, max: 119, pct: 25 },
    { min: 120, max: Infinity, pct: 50 },
  ] };
  if (trip.operator === 'sncf' && ['INOUI', 'INTERCITES', 'OUIGO'].includes(trip.product)) {
    // Garantie G30 / G60 SNCF Voyageurs (a revalider)
    return { name: 'Garantie SNCF ' + trip.product, eu: false, minLabel: trip.product === 'OUIGO' ? '60 min' : '30 min', tiers: [
      ...(trip.product === 'OUIGO' ? [] : [{ min: 30, max: 59, pct: 25, note: 'en bon d\'achat' }]),
      { min: 60, max: 119, pct: 25 },
      { min: 120, max: 179, pct: 50 },
      { min: 180, max: Infinity, pct: 75 },
    ] };
  }
  if (trip.operator === 'eurostar') {
    // Bareme Eurostar (a revalider) : remboursement en especes, bon d'achat plus genereux
    return { name: 'Bareme Eurostar', eu: true, minLabel: '60 min', tiers: [
      { min: 60, max: 119, pct: 25, note: 'ou 50 % en e-voucher' },
      { min: 120, max: 179, pct: 50, note: 'ou 60 % en e-voucher' },
      { min: 180, max: Infinity, pct: 50, note: 'ou 75 % en e-voucher' },
    ] };
  }
  return EU;
}

function result(verdict, amount, reason, extra = {}) {
  return { verdict, amount, reason, ...extra };
}

export function fmtDelay(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

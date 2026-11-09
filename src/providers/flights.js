// Vols : AeroDataBox via RapidAPI. Toute la dependance a l'API est ici :
// pour passer a FlightAware plus tard, il suffit de reecrire ce fichier
// en gardant les memes fonctions et le meme format de sortie.

const HOST = 'aerodatabox.p.rapidapi.com';

async function adb(env, path) {
  const res = await fetch(`https://${HOST}${path}`, {
    headers: { 'X-RapidAPI-Key': env.RAPIDAPI_KEY, 'X-RapidAPI-Host': HOST },
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`AeroDataBox ${res.status}`);
  return res.json();
}

// Format commun renvoye au reste de l'appli
function normalize(f) {
  const dep = f.departure || {}, arr = f.arrival || {};
  const sched = arr.scheduledTime?.utc;
  const actual = arr.actualTime?.utc || arr.revisedTime?.utc || arr.runwayTime?.utc || null;
  const status = (f.status || '').toLowerCase();
  return {
    number: (f.number || '').replace(/\s/g, ''),
    airline: f.airline?.name,
    airlineIata: f.airline?.iata,
    airlineIcao: f.airline?.icao,
    arrSchedUtc: sched ? sched.replace(' ', 'T') : null,
    // retard au depart (secours si l'arrivee reelle manque)
    depDelayMin: dep.scheduledTime?.utc && (dep.actualTime || dep.revisedTime || dep.runwayTime)?.utc
      ? Math.round((Date.parse((dep.actualTime || dep.revisedTime || dep.runwayTime).utc.replace(' ', 'T')) - Date.parse(dep.scheduledTime.utc.replace(' ', 'T'))) / 60000)
      : null,
    delaySource: actual ? 'aerodatabox' : null,
    dep: airport(dep.airport, dep.scheduledTime?.local),
    arr: { ...airport(arr.airport, arr.scheduledTime?.local), actualLocal: (arr.actualTime || arr.revisedTime || arr.runwayTime)?.local },
    status,
    cancelled: status.includes('cancel'),
    diverted: status.includes('divert'),
    delayMin: sched && actual ? Math.round((Date.parse(actual) - Date.parse(sched.replace(' ', 'T'))) / 60000) : null,
  };
}

function airport(a = {}, scheduledLocal) {
  return {
    iata: a.iata, icao: a.icao, name: a.name || a.shortName, country: a.countryCode,
    location: a.location ? { lat: a.location.lat, lon: a.location.lon } : null,
    scheduledLocal,
  };
}

async function withLocations(env, flight) {
  for (const side of ['dep', 'arr']) {
    if (!flight[side].location && flight[side].iata) {
      const a = await adb(env, `/airports/iata/${flight[side].iata}`).catch(() => null);
      if (a?.location) flight[side].location = { lat: a.location.lat, lon: a.location.lon };
      if (!flight[side].country && a?.country?.code) flight[side].country = a.country.code;
    }
  }
  return flight;
}

// Recherche par numero de vol + date (YYYY-MM-DD)
export async function findFlightByNumber(env, number, date) {
  if (env.MOCK === '1') return [mockFlight(number, date)];
  const data = await adb(env, `/flights/number/${encodeURIComponent(number.replace(/\s/g, ''))}/${date}?withLocation=false&withAircraftImage=false`);
  const list = Array.isArray(data) ? data : data ? [data] : [];
  return Promise.all(list.map(async f => withOpenSky(env, await withLocations(env, normalize(f)))));
}

// --- Secours OpenSky : heure d'atterrissage vue par le reseau radar ---
// Utilise seulement si AeroDataBox n'a pas l'heure d'arrivee reelle et si les cles OpenSky sont configurees.
const OPENSKY_TOKEN = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

async function openskyToken(env) {
  const res = await fetch(OPENSKY_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.OPENSKY_CLIENT_ID, client_secret: env.OPENSKY_CLIENT_SECRET }),
  });
  if (!res.ok) throw new Error(`OpenSky connexion ${res.status}`);
  return (await res.json()).access_token;
}

// Atterrissages a l'aeroport d'arrivee, de 2 h avant a 8 h apres l'heure prevue
export async function openskyArrival(env, flight) {
  const icao = flight.arr.icao, sched = flight.arrSchedUtc && Date.parse(flight.arrSchedUtc);
  if (!icao || !sched) return null;
  const begin = Math.floor(sched / 1000) - 2 * 3600, end = Math.floor(sched / 1000) + 8 * 3600;
  const token = await openskyToken(env);
  const res = await fetch(`https://opensky-network.org/api/flights/arrival?airport=${icao}&begin=${begin}&end=${end}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`OpenSky ${res.status}`);
  const list = await res.json();
  // Indicatif radio = code OACI de la compagnie + numero (XK751 -> CCM751)
  const num = flight.number.replace(/^[A-Z0-9]{2}/, '').replace(/^0+/, '');
  const callsign = (flight.airlineIcao || '') + num;
  const hit = list.find(a => (a.callsign || '').trim() === callsign)
    || list.find(a => (a.callsign || '').trim().endsWith(num) && a.estDepartureAirport === flight.dep.icao);
  return hit?.lastSeen ? hit.lastSeen * 1000 : null;
}

// Secours dans l'ordre : OpenSky (atterrissage radar), puis retard au depart.
// flight.fallbackNote explique ce qui a ete tente (affiche dans les details du resultat).
async function withOpenSky(env, flight) {
  if (flight.delayMin != null || flight.cancelled) return flight;
  if (!env.OPENSKY_CLIENT_ID || !env.OPENSKY_CLIENT_SECRET) flight.fallbackNote = 'OpenSky : identifiants absents';
  else {
    try {
      const landed = await openskyArrival(env, flight);
      if (landed) {
        // derniere detection radar ~ atterrissage : on ajoute 5 min de roulage jusqu'a la porte
        flight.delayMin = Math.round((landed + 5 * 60000 - Date.parse(flight.arrSchedUtc)) / 60000);
        flight.delaySource = 'opensky';
        return flight;
      }
      flight.fallbackNote = 'OpenSky : vol non trouve';
    } catch (e) {
      flight.fallbackNote = 'OpenSky : ' + e.message;
    }
  }
  if (flight.depDelayMin != null) {
    flight.delayMin = flight.depDelayMin;
    flight.delaySource = 'departure';
  }
  return flight;
}

// Recherche par trajet : vols au depart de depIata vers arrIata, a la date donnee.
// AeroDataBox limite la fenetre a 12 h : on fait deux appels pour couvrir la journee.
export async function findFlightsByRoute(env, depIata, arrIata, date) {
  if (env.MOCK === '1') return [mockFlight('AF1234', date, depIata, arrIata), mockFlight('AF1236', date, depIata, arrIata, 40)];
  const windows = [[`${date}T00:00`, `${date}T11:59`], [`${date}T12:00`, `${date}T23:59`]];
  const out = [];
  for (const [from, to] of windows) {
    const data = await adb(env, `/flights/airports/iata/${depIata}/${from}/${to}?direction=Departure&withCancelled=true&withCodeshared=false&withCargo=false&withPrivate=false`);
    for (const f of data?.departures || []) {
      if (f.arrival?.airport?.iata === arrIata.toUpperCase())
        out.push({ number: f.number.replace(/\s/g, ''), airline: f.airline?.name, depLocal: f.departure?.scheduledTime?.local, arrIata });
    }
  }
  return out;
}

// Recherche d'aeroports par nom de ville
export async function searchAirports(env, q) {
  if (env.MOCK === '1') return [{ iata: 'CDG', name: 'Paris Charles de Gaulle' }, { iata: 'ORY', name: 'Paris Orly' }].filter(a => a.name.toLowerCase().includes(q.toLowerCase()) || a.iata === q.toUpperCase());
  const data = await adb(env, `/airports/search/term?q=${encodeURIComponent(q)}&limit=8`);
  return (data?.items || []).filter(a => a.iata).map(a => ({ iata: a.iata, name: a.name, city: a.municipalityName, country: a.countryCode }));
}

function mockFlight(number, date, dep = 'CDG', arr = 'FCO', delay = 205) {
  return {
    number, airline: 'Air France (demo)', airlineIata: number.slice(0, 2),
    dep: { iata: dep, name: 'Aeroport depart (demo)', country: 'FR', location: { lat: 49.0097, lon: 2.5479 }, scheduledLocal: `${date} 07:10` },
    arr: { iata: arr, name: 'Aeroport arrivee (demo)', country: 'IT', location: { lat: 41.8003, lon: 12.2389 }, scheduledLocal: `${date} 09:20` },
    status: 'arrived', cancelled: false, diverted: false, delayMin: delay,
  };
}

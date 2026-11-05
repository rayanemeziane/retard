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
    iata: a.iata, name: a.name || a.shortName, country: a.countryCode,
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
  return Promise.all(list.map(f => withLocations(env, normalize(f))));
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

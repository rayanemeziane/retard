// SNCF : API officielle (Navitia), https://api.sncf.com/v1/coverage/sncf
// - recherche de gares et de trains d'un trajet (horaires theoriques)
// - archive des perturbations (retards / suppressions), appelee par la tache planifiee

const BASE = 'https://api.sncf.com/v1/coverage/sncf';

async function nav(env, path) {
  const res = await fetch(BASE + path, { headers: { Authorization: 'Basic ' + btoa(env.SNCF_KEY + ':') } });
  if (!res.ok) throw new Error(`API SNCF ${res.status}`);
  return res.json();
}

// "20261105T143000" -> Date (heure de Paris interpretee telle quelle)
const navDate = s => s && `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const navTime = s => s && `${s.slice(9, 11)}:${s.slice(11, 13)}`;
const ymd = d => d.replaceAll('-', '');

export async function searchStations(env, q) {
  if (env.MOCK === '1') return [{ id: 'stop_area:SNCF:87686006', name: 'Paris Gare de Lyon' }, { id: 'stop_area:SNCF:87751008', name: 'Marseille Saint-Charles' }].filter(s => s.name.toLowerCase().includes(q.toLowerCase()));
  const data = await nav(env, `/places?q=${encodeURIComponent(q)}&type[]=stop_area&count=8`);
  return (data.places || []).map(p => ({ id: p.id, name: p.name }));
}

// Trains d'un trajet a une date : on enchaine des recherches d'itineraires sur la journee
export async function findTrainsByRoute(env, fromId, toId, date) {
  if (env.MOCK === '1') return [
    { operator: 'sncf', number: '6109', product: 'INOUI', depLocal: `${date} 08:00`, arrLocal: `${date} 11:20` },
    { operator: 'sncf', number: '6113', product: 'INOUI', depLocal: `${date} 10:00`, arrLocal: `${date} 13:20` },
  ];
  const out = new Map();
  let dt = `${ymd(date)}T000000`;
  for (let i = 0; i < 6; i++) {
    const data = await nav(env, `/journeys?from=${fromId}&to=${toId}&datetime=${dt}&count=10&max_nb_transfers=0&data_freshness=base_schedule`);
    const journeys = data.journeys || [];
    if (!journeys.length) break;
    for (const j of journeys) {
      const s = (j.sections || []).find(x => x.type === 'public_transport');
      if (!s || navDate(s.departure_date_time) !== date) continue;
      const info = s.display_informations || {};
      out.set(info.headsign, {
        operator: 'sncf', number: info.headsign, product: product(info.commercial_mode),
        depLocal: `${date} ${navTime(s.departure_date_time)}`, arrLocal: `${navDate(s.arrival_date_time)} ${navTime(s.arrival_date_time)}`,
        arrStation: s.to?.name,
      });
    }
    const last = journeys[journeys.length - 1].departure_date_time;
    if (navDate(last) !== date) break;
    dt = last.slice(0, 13) + String(Number(last.slice(13, 15)) + 1).padStart(2, '0');
  }
  return [...out.values()].sort((a, b) => a.depLocal.localeCompare(b.depLocal));
}

function product(mode = '') {
  const m = mode.toUpperCase();
  if (m.includes('OUIGO')) return 'OUIGO';
  if (m.includes('INOUI') || m === 'TGV') return 'INOUI';
  if (m.includes('INTERCIT')) return 'INTERCITES';
  if (m.includes('TER')) return 'TER';
  return m || null;
}

// --- Archive : appelee toutes les 10 minutes ---
// On lit toutes les perturbations actives et on enregistre, pour chaque gare
// impactee, le dernier retard connu. Un train absent de l'archive = aucun retard signale.
export async function archive(env, db) {
  if (env.MOCK === '1' || !env.SNCF_KEY) return 0;
  const now = new Date().toISOString();
  let page = 0, count = 0;
  while (page < 10) {
    const data = await nav(env, `/disruptions?count=200&start_page=${page}`);
    for (const d of data.disruptions || []) {
      if (d.status !== 'active') continue;
      const serviceDate = navDate(d.application_periods?.[0]?.begin);
      for (const o of d.impacted_objects || []) {
        const number = o.pt_object?.trip?.name;
        if (!number || !serviceDate) continue;
        for (const st of o.impacted_stops || []) {
          if (!st.base_arrival_time) continue;
          const cancelled = st.arrival_status === 'deleted' || st.stop_time_effect === 'deleted';
          const delay = cancelled || !st.amended_arrival_time ? null : diffMin(st.base_arrival_time, st.amended_arrival_time);
          await upsert(db, 'sncf', number, serviceDate, st.stop_point?.name, st.base_arrival_time, st.amended_arrival_time, delay, cancelled, now);
          count++;
        }
      }
    }
    const pg = data.pagination;
    if (!pg || (pg.start_page + 1) * pg.items_per_page >= pg.total_result) break;
    page++;
  }
  return count;
}

// "HHMMSS" -> minutes d'ecart, en gerant le passage de minuit
function diffMin(base, amended) {
  const m = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(2, 4));
  let d = m(amended) - m(base);
  if (d < -720) d += 1440;
  return d;
}

export async function upsert(db, operator, number, date, station, planned, actual, delay, cancelled, now) {
  await db.prepare(
    `INSERT INTO train_delays (operator, train_number, service_date, station, planned_arr, actual_arr, delay_min, cancelled, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT (operator, train_number, service_date, station) DO UPDATE SET
       actual_arr = excluded.actual_arr, delay_min = excluded.delay_min, cancelled = excluded.cancelled, updated_at = excluded.updated_at`
  ).bind(operator, String(number), date, station || '?', planned, actual, delay, cancelled ? 1 : 0, now).run();
}

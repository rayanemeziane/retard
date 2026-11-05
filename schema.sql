-- Archive des retards train (une ligne par train, par jour, par gare d'arrivee observee)
CREATE TABLE IF NOT EXISTS train_delays (
  operator     TEXT NOT NULL,     -- sncf | trenitalia | eurostar
  train_number TEXT NOT NULL,
  service_date TEXT NOT NULL,     -- YYYY-MM-DD (date de depart)
  station      TEXT NOT NULL,     -- nom ou code de la gare
  planned_arr  TEXT,              -- ISO
  actual_arr   TEXT,              -- ISO (derniere valeur connue)
  delay_min    INTEGER,           -- retard a l'arrivee dans cette gare
  cancelled    INTEGER DEFAULT 0,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (operator, train_number, service_date, station)
);

CREATE INDEX IF NOT EXISTS idx_train_lookup ON train_delays (train_number, service_date);
CREATE INDEX IF NOT EXISTS idx_train_date   ON train_delays (service_date);

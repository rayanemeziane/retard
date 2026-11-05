# Retards : ai-je droit a une indemnite ?

Site web qui dit, a partir d'un numero de vol/train (ou d'un trajet) et d'une date,
si le voyageur a droit a une indemnite, et prepare la reclamation.

## Structure

```
public/index.html          page web (formulaire + resultat)
src/index.js               API (/api/check, /api/route, /api/places, /api/health) + tache planifiee
src/rules.js               regles d'indemnisation (CE 261/2004, UE 2021/782, G30 SNCF, Eurostar)
src/providers/flights.js   AeroDataBox (vols)
src/providers/sncf.js      API SNCF (recherche + archive des retards)
src/providers/trenitalia.js ViaggiaTreno (API non officielle)
src/providers/eurostar.js  iRail (Belgique) + NS (Pays-Bas)
schema.sql                 table d'archive des retards train
wrangler.toml              configuration Cloudflare
```

## Comptes a creer (tous gratuits)

| Quoi | Lien | Sert a |
|---|---|---|
| Node.js (version LTS) | https://nodejs.org/fr/download | outils de deploiement |
| Cloudflare | https://dash.cloudflare.com/sign-up | heberger le site et l'archive |
| AeroDataBox (RapidAPI) | https://rapidapi.com/aedbx-aedbx/api/aerodatabox | retards des vols (choisir l'offre "Basic" gratuite) |
| API SNCF | https://numerique.sncf.com/startup/api/token-developpeur/ | trains SNCF (cle recue par mail) |
| API NS | https://apiportal.ns.nl/ | arrivees Eurostar a Amsterdam/Rotterdam (s'abonner au produit "Ns-App") |

iRail (Belgique) et ViaggiaTreno (Italie) ne demandent pas de compte.

## Installation (une seule fois)

```powershell
cd C:\Users\rayane.meziane\Projets\retards
npm install
npx wrangler login
npx wrangler d1 create retards        # copier le database_id affiche dans wrangler.toml
npm run db:init
npx wrangler secret put RAPIDAPI_KEY
npx wrangler secret put SNCF_KEY
npx wrangler secret put NS_KEY
```

Puis passer `MOCK = "0"` dans `wrangler.toml` et deployer :

```powershell
npm run deploy
```

## Tester en local (sans cles, donnees factices)

```powershell
npm install
npm run db:init:local
npm run dev        # puis ouvrir http://localhost:8787
```

## Etat de l'archive

`/api/health` indique, par transporteur, le nombre de lignes archivees et la date de debut.

## Limites connues

- Trains : l'historique commence au lancement de l'archive. Plus tot elle tourne, mieux c'est.
- Eurostar : seules les arrivees a Bruxelles, Rotterdam et Amsterdam sont suivies.
- ViaggiaTreno n'est pas une API officielle : elle peut changer sans preavis.
- Baremes G30 SNCF et Eurostar : a revalider regulierement (src/rules.js).
- Circonstances extraordinaires (meteo, greve du controle aerien) : non detectables, le verdict reste "probablement oui".

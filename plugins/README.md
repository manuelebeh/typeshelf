# Plugins Typeshelf

Panneaux qui, à l'ouverture d'un document, listent les polices utilisées et demandent à Typeshelf
d'activer celles qui manquent : depuis la bibliothèque, ou téléchargées sur Google Fonts quand la
famille y existe. Typeshelf doit être ouvert.

| Dossier        | Application | Technologie           |
| -------------- | ----------- | --------------------- |
| `photoshop/`   | Photoshop 2023 (24.2) et plus | UXP (manifest v5) |
| `illustrator/` | Illustrator 2021 (25) et plus | CEP + ExtendScript |
| `after-effects/` | After Effects 2024 (24) et plus | CEP + ExtendScript |
| `sketch/`      | Sketch (essayé dans 2026.1) | Plugin Sketch (JavaScript) |
| `shared/`      | Panneau commun (`panel-core.js`, `panel.css`), plomberie CEP (`cep.js`) et page d'aperçu | - |

`panel-core.js` et `panel.css` (et `cep.js` pour les plugins CEP) sont copiés dans chaque dossier (chaque plugin doit être
autonome) : après une modification dans `shared/`, lancer `npm run plugins:sync`.
`npm run dev` puis `/plugins/shared/preview.html` affiche le panneau avec des données fictives.

## Installation pour le développement

### Photoshop

1. Installer **UXP Developer Tool** depuis l'app Creative Cloud.
2. *Add Plugin* → choisir `plugins/photoshop/manifest.json` → *Load*.
3. Le panneau est dans **Plugins ▸ Typeshelf**.

Pour le distribuer : *Package* dans UXP Developer Tool produit un `.ccx` installable par double-clic.

### Illustrator et After Effects

Les extensions CEP non signées ne se chargent qu'en mode débogage :

```bash
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
```

```bash
ln -s "$PWD/plugins/illustrator" ~/Library/Application\ Support/Adobe/CEP/extensions/typeshelf
```

```bash
ln -s "$PWD/plugins/after-effects" ~/Library/Application\ Support/Adobe/CEP/extensions/typeshelf-aftereffects
```

Relancer l'application : **Fenêtre ▸ Extensions ▸ Typeshelf**. L'extension se charge aussi en
arrière-plan au démarrage, pour vérifier les documents même panneau fermé.
Pour la distribuer sans mode débogage, il faut la signer avec `ZXPSignCmd`.

En mode débogage, le fichier `.debug` ouvre les outils de développement du panneau sur
`http://localhost:8088` (Illustrator) ou `http://localhost:8089` (After Effects). Il ne sert
qu'au développement.

### Sketch

```bash
ln -s "$PWD/plugins/sketch/Typeshelf.sketchplugin" ~/Library/Application\ Support/com.bohemiancoding.sketch3/Plugins/
```

(ou double-cliquer sur `Typeshelf.sketchplugin`, qui le copie). Sketch n'a pas de panneau
permanent sans bibliothèque de webview : le plugin agit seul à l'ouverture d'un document et
répond par un message en bas de la fenêtre. **Plugins ▸ Typeshelf** propose *Activer les polices
manquantes* et *Réglages…* (activation automatique, Google Fonts, durée).

## API locale

Typeshelf écoute sur `http://localhost:47391` (désactivable dans Réglages ▸ Plugins).

```http
GET  /v1/status
POST /v1/fonts/status      { "fonts": [...] }  → disponibles ? dans la bibliothèque ? (lecture seule)
POST /v1/fonts/activate
X-Typeshelf-Client: Photoshop
Content-Type: application/json

{ "fonts": ["Lora-Bold", "ClientBrand-Black"], "scope": "temporary", "google": true }
```

Réponse : `{ "results": [{ "name", "status", "family?", "source?", "message?" }] }` avec `status`
parmi `system` (installée sur le système), `active` (déjà active), `activated` (activée par cette
requête, `source` = `library` ou `google`), `missing`, `error`. `scope` vaut `temporary` (jusqu'à la
fermeture de Typeshelf, par défaut) ou `persistent`.

Garde-fous : écoute sur la boucle locale seulement (`127.0.0.1` et `[::1]`) ; l'en-tête `Host`
doit être `127.0.0.1:47391`, `localhost:47391` ou `[::1]:47391` (contre le DNS rebinding) ; toute requête portant un `Origin` web est refusée ;
l'activation exige l'en-tête `X-Typeshelf-Client`, qu'un navigateur n'envoie qu'après une requête
préalable CORS que Typeshelf refuse toujours.

## Limites connues

- Illustrator (essayé dans Illustrator 2026) : son API de script lève une erreur (`GFKU`) quand on
  lit la police d'un texte dont la police manque, et ajoute à `app.textFonts` un faux
  enregistrement portant son nom. Le panneau lit donc la liste des polices dans les métadonnées XMP
  du fichier (`xmpTPg:Fonts`), complétée par la police de chaque bloc de texte lisible, et
  demande à Typeshelf (`/v1/fonts/status`, CoreText sur macOS) lesquelles sont vraiment
  disponibles. Les métadonnées datent du dernier enregistrement : c'est le bon moment, puisque les
  polices manquent à l'ouverture d'un fichier.
- Photoshop (essayé dans Photoshop 2026) : l'autorisation réseau du manifest ne fonctionne qu'avec
  un nom d'hôte sans port (`http://localhost`), pas avec `127.0.0.1` ; Typeshelf écoute donc aussi
  sur `[::1]`. `loadEvent: "startup"` charge le plugin au lancement de Photoshop, panneau fermé.
  Photoshop garde dans `app.fonts` une police désactivée : le panneau laisse Typeshelf trancher.
- Photoshop sans UXP Developer Tool : le plugin peut être inscrit dans
  `~/Library/Application Support/Adobe/UXP/PluginsInfo/v1/PS.json` (Photoshop fermé), avec un lien
  vers ce dossier dans `…/UXP/Plugins/External/`. Photoshop ne le recharge qu'au redémarrage.
- Une police absente de la bibliothèque n'est retrouvée sur Google Fonts que si le début de son
  nom PostScript correspond au nom de la famille (`PlayfairDisplay-Bold` → « Playfair Display »).
- After Effects (essayé dans After Effects 2026) : il n'envoie à CEP aucun événement à
  l'ouverture d'un projet ; le panneau surveille donc le fichier du projet toutes les 2 s.
  `project.usedFonts` (24.5 et plus) donne les polices et `isSubstitute` celles qui manquent ;
  avant 24.5, le panneau lit la police de chaque calque texte et Typeshelf tranche. Une fois la
  police activée, After Effects remet de lui-même la vraie à la place de son remplacement (en
  quelques secondes) et marque le projet comme modifié.
- Sketch (essayé dans Sketch 2026.1) : une police manquante qui n'est pas incorporée au fichier
  est remplacée en mémoire par une police système, et seules les données du document gardent
  son nom (`fontNames`, hors de l'API documentée ; à défaut, le plugin lit les polices du
  texte). Les polices incorporées au fichier sont chargées par Sketch et ne manquent pas.
  Sketch ne redessine pas un texte avec une police activée après l'ouverture : le plugin rouvre
  donc le document, seulement s'il n'a pas de modifications non enregistrées (Sketch enregistre
  en fermant), au plus une fois par minute. Sinon il demande de le rouvrir. Ne jamais appeler
  `replaceMissingFontsIfNecessary` : il remplace définitivement la police manquante.
- InDesign n'est pas encore couvert.

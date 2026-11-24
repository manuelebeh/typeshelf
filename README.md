# Typeshelf

Gestionnaire de polices multiplateforme (macOS, Windows, Linux) construit avec Tauri 2.

- Bibliothèque : import de fichiers ou de dossiers (`.ttf`, `.otf`, `.ttc`, `.otc`) par bouton ou
  glisser-déposer, dédoublonnage par nom PostScript, copie optionnelle dans la bibliothèque.
- Activation **permanente** ou **temporaire** (jusqu'à la fermeture de l'app), par famille ou par collection.
- Aperçu de chaque famille avec un texte et une taille réglables, recherche, classement automatique
  (sans serif, serif, slab, mono, script, display, symboles).
- **Polices système** : toutes les polices installées sur l'OS (dossiers système et utilisateur)
  apparaissent dans « Toutes les polices ». Elles restent toujours actives ; les mettre en favori,
  les taguer ou les ranger dans une collection les enregistre dans la bibliothèque par simple
  référence (le fichier ne bouge pas).
- **Google Fonts** : le catalogue public (≈ 1 900 familles libres) dans la section « En ligne », avec
  aperçu en direct, filtres par catégorie, variables, italique, recherche par nom ou créateur, tri par
  popularité. « Installer » télécharge tous les styles en TrueType dans la bibliothèque (dossier
  `Google Fonts`) et les active ; elles fonctionnent ensuite hors ligne comme n'importe quelle police.
  Le catalogue est mis en cache une semaine ; les polices chinoises, japonaises et coréennes sont
  masquées par défaut (Réglages → Google Fonts). Aucune clé ni compte ; les aperçus sont chargés
  depuis les serveurs de Google.
- **Plugins Adobe et Sketch** : un panneau Typeshelf pour Photoshop (UXP), Illustrator et After Effects (CEP), et un plugin Sketch, listent les
  polices du document et activent celles qui manquent dès son ouverture (bibliothèque, puis Google
  Fonts). Ils passent par une API locale (127.0.0.1:47391, fermée aux pages web), réglable dans
  Réglages ▸ Plugins. Installation et détails : [plugins/README.md](plugins/README.md).
- **Filtres et tri** : état (actives, temporaires, inactives), source (système, importées),
  classification, variables, chasse fixe, italique ; tri par nom, date d'ajout ou nombre de styles.
- **Grille ou tableau** : le tableau affiche format et date, et se déplie famille par famille.
- **Détail** : spécimen (plusieurs corps, sur fond clair ou coloré), styles et cascade, glyphes
  par catégorie avec recherche (caractère ou U+XXXX), langues prises en charge (26 langues,
  vérifiées sur la table cmap), OpenType, axes variables, infos du fichier.
- Collections et tags proposés au premier lancement (supprimables) : Projets, Identité de marque,
  Web & écrans, À l'essai ; Titrage, Texte courant, Manuscrite, Fantaisie, et les tags intelligents
  Variables, Chasse fixe, Script & calligraphie.
- Favoris et collections (glisser une famille sur une collection, ou clic droit).
- Tags de couleur : **manuels** (glisser une famille sur le tag, clic droit, ou « ＋ Tag » dans le
  détail) et **intelligents**, qui se remplissent seuls selon des règles (famille, style, créateur,
  fonderie, classification, graisse, nombre de glyphes, italique, chasse fixe, variable, favori,
  active, date d'ajout), combinées par « toutes » ou « au moins une ». Activation possible de toutes
  les polices d'un tag.
- Détail d'une famille : styles et cascade de tailles, table des caractères, métadonnées,
  fonctionnalités OpenType activables, curseurs pour les axes des polices variables.

## Développement

Prérequis : Node 20+, Rust stable, et les [prérequis Tauri](https://tauri.app/start/prerequisites/) de votre OS.

```bash
npm install
npm run tauri dev
```

`npm run dev` seul ouvre l'interface dans un navigateur ordinaire avec des données de démonstration
(`src/dev/mock.ts`, polices fournies avec macOS) ; ce mode n'est jamais inclus dans un build.

## Build

```bash
npm run tauri build
```

## Tests

```bash
cd src-tauri && cargo test
```

Le test de bout en bout (import, dédoublonnage, activation réelle, collections, tags) s'exécute si
`TYPESHELF_TEST_FONTS` pointe vers un dossier contenant au moins une police variable, une
collection `.ttc` et `Feather.ttf` (police non installée sur le système) :

```bash
TYPESHELF_TEST_FONTS=/chemin/vers/polices cargo test
```

## Activation selon l'OS

| OS | Permanente | Temporaire |
|---|---|---|
| macOS | CoreText, portée utilisateur | CoreText, portée session, retirée à la fermeture |
| Windows | `AddFontResourceEx` + valeur dans `HKCU\…\Fonts` (Windows 10 1809+) | `AddFontResourceEx` seul, retirée à la fermeture |
| Linux | lien dans `~/.local/share/fonts/typeshelf` + `fc-cache` | lien dans `…/fonts/typeshelf-temporary`, supprimé à la fermeture |

Les modules Windows et Linux sont vérifiés à la compilation, pas encore testés sur ces systèmes.

## Données

Bibliothèque SQLite et polices copiées dans le dossier de données de l'app
(`~/Library/Application Support/dev.typeshelf.app` sur macOS). Le catalogue Google Fonts y est
mis en cache (`google-fonts.json`).

# Génération automatique de codes-barres Loyverse

## Ce que fait ce projet
Quand un nouveau produit est créé dans Loyverse **sans code-barre**, ce projet :
1. Génère un code au format `PREFIXE-NNN` selon la catégorie du produit
   (préfixe défini dans `category-prefix-map.json`, numéro séquentiel suivant).
2. Écrit ce code directement dans la fiche Loyverse (`barcode` et `sku` de la variante).
3. Génère l'image du code-barres (vraies barres verticales + texte) et l'ajoute
   à **deux pages HTML** prêtes à imprimer (voir ci-dessous).

Ce projet est **100% Loyverse** : il n'y a plus de dépendance à Notion.

## Comment ça tourne

`generate-missing-barcodes.js` parcourt tous les articles Loyverse et traite
ceux sans code-barre en une fois. C'est ce script que le workflow GitHub
Actions exécute automatiquement toutes les 5 minutes (voir plus bas) — pas
besoin d'un serveur ni d'un ordinateur allumé en continu.

## Deux branches Git : `main` (code) et `data` (données auto-générées)

**`main`** contient uniquement le code (scripts, workflows, README, config
npm). Tu es le seul à y committer/pousser, et **rien n'y écrit jamais
automatiquement**.

**`data`** contient uniquement les fichiers que le bot écrit tout seul :
`category-prefix-map.json`, `generated-labels.json`, `catalogue-complet.html`,
`nouveaux.html`, `dernier-vidage.json`. Les deux workflows GitHub Actions
committent et poussent **uniquement sur cette branche**, jamais sur `main`.
Tu n'as normalement jamais besoin de la checkout ou d'y toucher toi-même.

**Pourquoi cette séparation ?** Avant, tout (code + données auto-générées)
vivait sur `main`. Le workflow tournant toutes les 5 minutes committait
automatiquement dessus, ce qui rentrait régulièrement en conflit avec tes
propres push de code (erreurs "non-fast-forward" / branches divergées).
En isolant les données auto-générées sur une branche séparée que tu ne touches
jamais en local, ce type de conflit ne peut structurellement plus se produire :
`main` n'est modifiée que par toi, `data` que par le bot.

### `DATA_DIR` : comment les scripts savent où lire/écrire

`label-generator.js` et `barcode-generator.js` lisent la variable
d'environnement `DATA_DIR` pour savoir où se trouvent leurs fichiers :
- **En local** (`DATA_DIR` non défini) : racine du projet, comme avant —
  pratique pour tester rapidement, mais **ne committe jamais ces fichiers sur
  main** si tu testes en local (ils sont censés vivre sur `data`).
- **En CI** : les workflows checkoutent la branche `data` dans un sous-dossier
  `./data` et lancent les scripts avec `DATA_DIR=data`.

## Les deux pages d'étiquettes

- **`catalogue-complet.html`** : TOUTES les étiquettes jamais générées, pour
  toujours, triées par catégorie puis par nom de produit. Elle ne se vide
  jamais.
- **`nouveaux.html`** : uniquement les étiquettes générées depuis le dernier
  "vidage" (voir workflow 2 ci-dessous). C'est la page à ouvrir au quotidien
  pour imprimer seulement les nouveaux produits.

Chaque page a un lien vers l'autre en haut. Les deux sont regénérées à partir
d'un registre persistant, **`generated-labels.json`**, qui n'est lui-même
jamais vidé — c'est la source de vérité de tout ce qui a été généré.
`dernier-vidage.json` retient juste la date du dernier vidage de `nouveaux.html`.

Ces fichiers vivent sur la branche `data` (voir plus haut), pas sur `main`.

### Le bug de persistance corrigé

À l'origine, le fichier d'étiquettes n'était jamais commité (même exclu via
`.gitignore`) : chaque exécution GitHub Actions partait d'un `checkout` propre
du dépôt, générait le fichier dans l'environnement temporaire du run, le
publiait sur GitHub Pages, puis **tout était perdu** à la fin du run. Résultat :
un produit généré à une exécution disparaissait à la suivante.

Le workflow committe et pousse désormais `generated-labels.json`,
`catalogue-complet.html`, `nouveaux.html`, `dernier-vidage.json` et
`category-prefix-map.json` sur la branche `data` après chaque génération (via
`stefanzweifel/git-auto-commit-action`, avec le `GITHUB_TOKEN` automatique de
l'action — pas besoin de configurer un token supplémentaire). Le run suivant
part donc bien de l'état réel de `data`, jamais d'une page vide — et comme
c'est sur une branche séparée, ça ne rentre plus en conflit avec `main`.

## Dimensions des étiquettes (à ajuster selon l'imprimante)

En haut de `label-generator.js` :

```js
const LABEL_WIDTH_MM = 40;
const LABEL_HEIGHT_MM = 30;
const LABEL_FONT_SIZE_PT = 10;
```

Le modèle d'imprimante Xprinter et le rouleau thermique ne sont pas encore
confirmés : ces valeurs sont un point de départ (40×30mm). **Pour changer la
taille**, modifie juste ces 3 constantes — tout le reste (mise en page,
impression) s'adapte automatiquement.

Chaque étiquette est un bloc indépendant avec un repère pointillé net, imprimé
**une étiquette par page** (taille de page = taille de l'étiquette, via
`@page { size: ... }` + saut de page après chaque étiquette). Ça fonctionne
aussi bien :
- avec l'imprimante actuelle (papier continu, découpe manuelle aux ciseaux :
  le pointillé indique où couper) ;
- qu'avec une future imprimante à étiquettes autocollantes à capteur
  automatique (le saut de page régulier tombe exactement à la frontière de
  chaque étiquette physique).

À l'écran (hors impression), les étiquettes s'affichent en grille compacte
pour naviguer/vérifier facilement ; c'est uniquement à l'impression que la
mise en page bascule en "une étiquette par page".

## Fichiers du projet

### Sur `main` (code, tu es le seul à y toucher)
- `loyverse.js` : client API Loyverse (articles, catégories, écriture de code-barre)
- `barcode-generator.js` : génère le prochain code selon la catégorie
- `label-generator.js` : génération des 2 pages HTML d'étiquettes
- `generate-missing-barcodes.js` : script principal, exécuté par le cron GitHub Actions
- `reset-nouveaux.js` : vide `nouveaux.html` (voir workflow 2)
- `.github/workflows/*.yml` : les 2 workflows

### Sur `data` (générées automatiquement, ne jamais éditer à la main)
- `category-prefix-map.json` : mapping catégorie Loyverse → préfixe de code-barre à 3 lettres
- `generated-labels.json` : registre persistant de toutes les étiquettes jamais générées
- `dernier-vidage.json` : date du dernier vidage de `nouveaux.html`
- `catalogue-complet.html` / `nouveaux.html` : les 2 pages d'étiquettes

## Automatisation : deux workflows GitHub Actions

### 1. `generate-barcodes.yml` — génération automatique (toutes les 5 min)
Checkout `main` (code) + `data` (données) dans un sous-dossier, récupère les
articles Loyverse sans code-barre, génère les codes, les écrit dans Loyverse,
met à jour le registre et les 2 pages HTML **sur la branche `data`**, puis
publie `nouveaux.html` (page d'accueil) et `catalogue-complet.html` sur
GitHub Pages.

### 2. `mark-as-printed.yml` — "Marquer les nouveautés comme imprimées"
Déclenchement **manuel uniquement** (`workflow_dispatch`, pas de cron) :
à lancer depuis l'onglet **Actions** du repo une fois que les étiquettes de
`nouveaux.html` ont été imprimées. Il vide `nouveaux.html` et met à jour
`dernier-vidage.json` **sur `data`**, sans toucher à `catalogue-complet.html`,
puis republie immédiatement GitHub Pages pour que la page reflète le vidage
tout de suite (pas besoin d'attendre le prochain cron).

## GitHub Pages : aucune config à changer avec la séparation main/data

La publication ne lit jamais directement une branche : les deux workflows
utilisent `actions/upload-pages-artifact` (qui empaquette le contenu du
dossier `site/` généré pendant le run) puis `actions/deploy-pages` pour le
publier. Ce mécanisme est indépendant des branches Git — que les fichiers
sources viennent de `main` ou de `data` ne change rien à la configuration
GitHub Pages. Tant que **Settings → Pages → Source = "GitHub Actions"** est
actif (voir ci-dessous), tout continue de fonctionner sans rien retoucher.

## Configuration à faire une fois (dans GitHub, pas ici)

1. **Ajouter le secret du token Loyverse** :
   Repo GitHub → **Settings** → **Secrets and variables** → **Actions** →
   **New repository secret** → nom `LOYVERSE_ACCESS_TOKEN`, valeur = ton token Loyverse.

2. **Activer GitHub Pages avec la source "GitHub Actions"** :
   Repo GitHub → **Settings** → **Pages** → section **Build and deployment** →
   **Source** → choisir **GitHub Actions** (pas "Deploy from a branch").

3. **Pousser le code sur GitHub** (tu t'en occupes toi-même, sur `main`
   uniquement — ne pousse jamais sur `data`, c'est réservé au bot) :
   ```bash
   git add .
   git commit -m "..."
   git push
   ```

Une fois ces 2 réglages faits et le code poussé, le workflow 1 tourne
automatiquement toutes les 5 minutes. Tu peux aussi déclencher chaque
workflow manuellement depuis l'onglet **Actions** du repo (bouton "Run
workflow"), et retrouver le lien de la page publiée dans **Settings → Pages**
une fois le premier déploiement terminé.

## Tester en local

```bash
npm install
npm run generate-barcodes   # génère les codes-barres manquants + les 2 pages HTML
npm run reset-nouveaux      # vide nouveaux.html (équivalent local du workflow 2)
```

Sans `DATA_DIR` défini, `catalogue-complet.html` et `nouveaux.html` sont
créés/mis à jour à la racine du projet (pratique pour tester). Ouvre-les dans
un navigateur puis Ctrl+P pour imprimer. **Ne les committe pas sur `main`** —
ce sont des fichiers de test locaux, la vraie donnée vit sur `data`.

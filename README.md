# Génération automatique de codes-barres Loyverse

## Ce que fait ce projet
Quand un nouveau produit est créé dans Loyverse **sans code-barre**, ce projet :
1. Génère un code au format `PREFIXE-NNN` selon la catégorie du produit
   (préfixe défini dans `category-prefix-map.json`, numéro séquentiel suivant).
2. Écrit ce code directement dans la fiche Loyverse (`barcode` et `sku` de la variante).
3. Génère UNE SEULE image (nom du produit + vraies barres verticales) et
   l'ajoute aux pages HTML prêtes à imprimer, triées gros/détail/nouveaux
   (voir ci-dessous).

Ce projet est **100% Loyverse** : il n'y a plus de dépendance à Notion.

## Comment ça tourne

`generate-missing-barcodes.js` parcourt tous les articles Loyverse et traite
ceux sans code-barre en une fois. C'est ce script que le workflow GitHub
Actions exécute, déclenché toutes les 5 minutes par un **cron externe**
(voir "Déclenchement fiable" plus bas) — pas besoin d'un serveur ni d'un
ordinateur allumé en continu.

### Déclenchement fiable : pourquoi un cron externe, pas le `schedule` GitHub natif

Le déclencheur `schedule` natif de GitHub Actions a été testé en conditions
réelles (produit ajouté dans Loyverse, surveillance de l'API GitHub sur
plusieurs heures) : réglé sur `*/5 * * * *`, il ne s'est déclenché que 2 fois
en ~7h, avec des écarts réels observés de 4h, 10h, et une fois plus de 6h45
sans aucun déclenchement. GitHub documente que ce déclencheur "peut être
retardé en période de forte charge" et n'est "pas recommandé pour les
scénarios nécessitant une précision élevée" — nos mesures montrent que
c'est largement en dessous de ce que ce projet nécessite (un nouveau produit
en boutique doit avoir son code-barre en quelques minutes, pas en heures).

**Solution retenue** : le workflow n'a plus de déclencheur `schedule` du
tout — uniquement `workflow_dispatch`. Un service de cron externe (ex:
[cron-job.org](https://cron-job.org), gratuit) appelle toutes les 5 minutes
l'API GitHub pour déclencher ce `workflow_dispatch`, ce qui est bien plus
fiable qu'un cron interne à GitHub Actions.

**Configuration (à faire une fois, dans cron-job.org — pas ici) :**
1. Crée un **Personal Access Token GitHub** (Settings → Developer settings →
   Personal access tokens → Fine-grained tokens) avec la permission
   **Actions: Read and write** sur ce dépôt uniquement. Copie le token
   (il ne sera plus affichable ensuite).
2. Crée un compte gratuit sur [cron-job.org](https://cron-job.org) (ou un
   service équivalent).
3. Crée une nouvelle tâche ("cronjob") avec :
   - **URL** : `https://api.github.com/repos/Sedowhite/Automatisation/actions/workflows/generate-barcodes.yml/dispatches`
   - **Méthode** : `POST`
   - **En-têtes (headers)** :
     - `Authorization: Bearer <ton_token_PAT>`
     - `Accept: application/vnd.github+json`
     - `Content-Type: application/json`
   - **Corps (body)** : `{"ref":"main"}`
   - **Fréquence** : toutes les 5 minutes
4. Le token PAT reste uniquement dans la configuration de cron-job.org — il
   n'est jamais mis dans ce dépôt.

## Deux branches Git : `main` (code) et `data` (données auto-générées)

**`main`** contient uniquement le code (scripts, workflows, README, config
npm). Tu es le seul à y committer/pousser, et **rien n'y écrit jamais
automatiquement**.

**`data`** contient uniquement les fichiers que le bot écrit tout seul :
`category-prefix-map.json`, `generated-labels.json`, `catalogue-complet.html`,
`nouveaux.html`, `catalogue-gros.html`, `catalogue-detail.html`, `styles.css`,
`search.js`, `dernier-vidage.json`. Les deux workflows GitHub Actions committent et
poussent **uniquement sur cette branche**, jamais sur `main`. Tu n'as
normalement jamais besoin de la checkout ou d'y toucher toi-même.

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

## Les pages d'étiquettes

Trois pages "nouveau design" (bandeau de navigation, badge de couleur,
produits regroupés par catégorie, feuille de style partagée `styles.css`,
barre de recherche partagée `search.js`) :

- **`catalogue-gros.html`** (badge orange) : uniquement les produits dont le
  nom contient `(gros)` (insensible à la casse). **C'est la seule page qui
  compte vraiment pour l'impression des étiquettes cartons.**
- **`catalogue-detail.html`** (badge bleu) : produits dont le nom contient
  `(détail)`, ou sans aucun suffixe du tout (anciens produits créés avant
  cette distinction). Page de référence uniquement, pas destinée à
  l'impression de codes-barres.

### Barre de recherche (sur les 3 pages)

Chaque page a sa propre barre de recherche, juste sous le titre — filtrage en
temps réel (aucun bouton, aucun rechargement), sur le nom du produit,
insensible à la casse et aux accents ("ete" trouve "Été"). 100% JS navigateur
(`search.js`, partagé par les 3 pages), aucun appel réseau. La recherche
est strictement limitée à la page où elle est tapée — pas de recherche
croisée entre gros/détail/nouveaux. Un message "Aucun produit trouvé"
s'affiche si rien ne correspond. La barre de recherche et ce message ont la
classe `no-print` : ils n'apparaissent jamais à l'impression, comme le
bandeau de navigation.
- **`nouveaux.html`** (badge neutre) : uniquement les étiquettes générées
  depuis le dernier "vidage" (voir workflow 2 ci-dessous), tous suffixes
  confondus — comportement inchangé par rapport à avant. C'est la page
  d'accueil (`index.html`).

Plus une page héritée, **conservée pour l'instant, pas encore supprimée** :
- **`catalogue-complet.html`** (ancien design, sans nav/badge) : TOUTES les
  étiquettes jamais générées, sans filtrage par `(gros)`/`(détail)`. À
  supprimer une fois les 3 pages ci-dessus validées — demander confirmation
  avant.

### URLs une fois publié sur GitHub Pages

- Nouveautés (page d'accueil) : `https://sedowhite.github.io/Automatisation/`
  — accessible aussi sur `https://sedowhite.github.io/Automatisation/nouveaux.html`.
- Gros : `https://sedowhite.github.io/Automatisation/catalogue-gros.html`
- Détail : `https://sedowhite.github.io/Automatisation/catalogue-detail.html`
- Catalogue complet (héritée) : `https://sedowhite.github.io/Automatisation/catalogue-complet.html`

Les 3 pages "nouveau design" partagent un bandeau de navigation entre elles.
Toutes sont regénérées à partir d'un registre persistant,
**`generated-labels.json`**, qui n'est lui-même jamais vidé — c'est la source
de vérité de tout ce qui a été généré. `dernier-vidage.json` retient juste la
date du dernier vidage de `nouveaux.html`.

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
const LABEL_WIDTH_MM = 50;
const LABEL_HEIGHT_MM = 25;
const LABEL_FONT_SIZE_PT = 10;
```

Format physique confirmé : 50×25mm. **Pour changer la taille**, modifie juste
ces 3 constantes — tout le reste (mise en page, impression, taille de l'aperçu
écran) s'adapte automatiquement.

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
- `label-generator.js` : génération des pages HTML d'étiquettes (gros/détail/nouveaux + page héritée)
- `generate-missing-barcodes.js` : script principal, exécuté par le cron GitHub Actions
- `reset-nouveaux.js` : vide `nouveaux.html` (voir workflow 2)
- `.github/workflows/*.yml` : les 2 workflows

### Sur `data` (générées automatiquement, ne jamais éditer à la main)
- `category-prefix-map.json` : mapping catégorie Loyverse → préfixe de code-barre à 3 lettres
- `generated-labels.json` : registre persistant de toutes les étiquettes jamais générées
- `dernier-vidage.json` : date du dernier vidage de `nouveaux.html`
- `styles.css` : feuille de style partagée par `nouveaux.html` / `catalogue-gros.html` / `catalogue-detail.html`
- `search.js` : script de recherche partagé par les 3 mêmes pages (filtrage en temps réel, par page)
- `nouveaux.html` / `catalogue-gros.html` / `catalogue-detail.html` : les 3 pages "nouveau design"
- `catalogue-complet.html` : page héritée (ancien design), conservée temporairement

## Automatisation : deux workflows GitHub Actions

### 1. `generate-barcodes.yml` — génération automatique
Déclenché par `workflow_dispatch`, appelé toutes les 5 minutes par le cron
externe (voir "Déclenchement fiable" plus haut) — plus de `schedule` GitHub
natif, jugé trop peu fiable. Checkout `main` (code) + `data` (données) dans
un sous-dossier, récupère les articles Loyverse sans code-barre, génère les
codes, les écrit dans Loyverse, met à jour le registre et toutes les pages HTML
**sur la branche `data`**, puis publie `nouveaux.html` (page d'accueil),
`catalogue-gros.html`, `catalogue-detail.html`, `styles.css`, `search.js`
et `catalogue-complet.html` (héritée) sur GitHub Pages.

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

3bis. **Configurer le cron externe** : voir la section "Déclenchement fiable"
   plus haut (token GitHub + cron-job.org). Sans ça, le workflow 1 ne se
   déclenche plus tout seul (il n'a plus de `schedule` GitHub).

Tu peux toujours déclencher chaque workflow manuellement depuis l'onglet
**Actions** du repo (bouton "Run workflow") en attendant d'avoir configuré le
cron externe, et retrouver le lien de la page publiée dans **Settings → Pages**
une fois le premier déploiement terminé.

## Tester en local

```bash
npm install
npm run generate-barcodes   # génère les codes-barres manquants + toutes les pages HTML
npm run reset-nouveaux      # vide nouveaux.html (équivalent local du workflow 2)
```

Sans `DATA_DIR` défini, toutes les pages (`catalogue-complet.html`,
`nouveaux.html`, `catalogue-gros.html`, `catalogue-detail.html`, `styles.css`,
`search.js`) sont créées/mises à jour à la racine du projet (pratique pour tester).
Ouvre-les dans un navigateur puis Ctrl+P pour imprimer. **Ne les committe pas
sur `main`** — ce sont des fichiers de test locaux, la vraie donnée vit sur
`data`.

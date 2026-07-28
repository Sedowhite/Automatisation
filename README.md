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
Actions exécute automatiquement toutes les 15 minutes (voir plus bas) — pas
besoin d'un serveur ni d'un ordinateur allumé en continu.

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

### Le bug corrigé : pourquoi ces fichiers doivent être committés

Avant, `labels-a-imprimer.html` n'était jamais commité dans le dépôt (il était
même dans `.gitignore`) : chaque exécution GitHub Actions partait d'un
`checkout` propre du dépôt, générait le fichier dans l'environnement
temporaire du run, le publiait sur GitHub Pages, puis **tout était perdu** à
la fin du run. Résultat : un produit généré à une exécution disparaissait à
la suivante, puisque rien ne persistait entre deux runs.

Le workflow committe et pousse désormais `generated-labels.json`,
`catalogue-complet.html`, `nouveaux.html`, `dernier-vidage.json` et
`category-prefix-map.json` après chaque génération (via
`stefanzweifel/git-auto-commit-action`, avec le `GITHUB_TOKEN` automatique de
l'action — pas besoin de configurer un token supplémentaire). Le run suivant
part donc bien de l'état réel du dépôt, jamais d'une page vide.

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
- `loyverse.js` : client API Loyverse (articles, catégories, écriture de code-barre)
- `barcode-generator.js` : génère le prochain code selon la catégorie (`category-prefix-map.json`)
- `label-generator.js` : registre persistant + génération des 2 pages HTML d'étiquettes
- `generate-missing-barcodes.js` : script principal, exécuté par le cron GitHub Actions
- `reset-nouveaux.js` : vide `nouveaux.html` (voir workflow 2)
- `category-prefix-map.json` : mapping catégorie Loyverse → préfixe de code-barre à 3 lettres
- `generated-labels.json` : registre persistant de toutes les étiquettes jamais générées
- `dernier-vidage.json` : date du dernier vidage de `nouveaux.html`
- `catalogue-complet.html` / `nouveaux.html` : générés automatiquement, ne pas éditer à la main

## Automatisation : deux workflows GitHub Actions

### 1. `generate-barcodes.yml` — génération automatique (toutes les 15 min)
Récupère les articles Loyverse sans code-barre, génère les codes, les écrit
dans Loyverse, met à jour le registre et les 2 pages HTML, committe le tout,
puis publie `nouveaux.html` (page d'accueil) et `catalogue-complet.html` sur
GitHub Pages.

### 2. `mark-as-printed.yml` — "Marquer les nouveautés comme imprimées"
Déclenchement **manuel uniquement** (`workflow_dispatch`, pas de cron) :
à lancer depuis l'onglet **Actions** du repo une fois que les étiquettes de
`nouveaux.html` ont été imprimées. Il vide `nouveaux.html` et met à jour
`dernier-vidage.json`, sans toucher à `catalogue-complet.html`, puis republie
immédiatement GitHub Pages pour que la page reflète le vidage tout de suite
(pas besoin d'attendre le prochain cron).

## Configuration à faire une fois (dans GitHub, pas ici)

1. **Ajouter le secret du token Loyverse** :
   Repo GitHub → **Settings** → **Secrets and variables** → **Actions** →
   **New repository secret** → nom `LOYVERSE_ACCESS_TOKEN`, valeur = ton token Loyverse.

2. **Activer GitHub Pages avec la source "GitHub Actions"** :
   Repo GitHub → **Settings** → **Pages** → section **Build and deployment** →
   **Source** → choisir **GitHub Actions** (pas "Deploy from a branch").

3. **Pousser le code sur GitHub** (tu t'en occupes toi-même) :
   ```bash
   git add .
   git commit -m "Génération automatique de codes-barres Loyverse"
   git push
   ```

Une fois ces 2 réglages faits et le code poussé, le workflow 1 tourne
automatiquement toutes les 15 minutes. Tu peux aussi déclencher chaque
workflow manuellement depuis l'onglet **Actions** du repo (bouton "Run
workflow"), et retrouver le lien de la page publiée dans **Settings → Pages**
une fois le premier déploiement terminé.

## Tester en local

```bash
npm install
npm run generate-barcodes   # génère les codes-barres manquants + les 2 pages HTML
npm run reset-nouveaux      # vide nouveaux.html (équivalent local du workflow 2)
```

`catalogue-complet.html` et `nouveaux.html` sont créés/mis à jour à la racine
du projet. Ouvre-les dans un navigateur puis Ctrl+P pour imprimer.

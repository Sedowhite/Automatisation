# Génération automatique de codes-barres Loyverse

## Ce que fait ce projet
Quand un nouveau produit est créé dans Loyverse **sans code-barre**, ce projet :
1. Génère un code au format `PREFIXE-NNN` selon la catégorie du produit
   (préfixe défini dans `category-prefix-map.json`, numéro séquentiel suivant).
2. Écrit ce code directement dans la fiche Loyverse (`barcode` et `sku` de la variante).
3. Génère l'image du code-barres (vraies barres verticales + texte) et l'ajoute
   à une feuille d'étiquettes HTML (`labels-a-imprimer.html`), prête à imprimer.

Ce projet est **100% Loyverse** : il n'y a plus de dépendance à Notion.

## Comment ça tourne

`generate-missing-barcodes.js` parcourt tous les articles Loyverse et traite
ceux sans code-barre en une fois. C'est ce script que le workflow GitHub
Actions exécute automatiquement toutes les 15 minutes (voir plus bas) — pas
besoin d'un serveur allumé en continu.

## Fichiers du projet
- `loyverse.js` : client API Loyverse (articles, catégories, stock, écriture de code-barre)
- `barcode-generator.js` : génère le prochain code selon la catégorie (`category-prefix-map.json`)
- `label-generator.js` : génère l'image du code-barres et l'ajoute à `labels-a-imprimer.html`
- `generate-missing-barcodes.js` : script principal, exécuté par le cron GitHub Actions
- `category-prefix-map.json` : mapping catégorie Loyverse → préfixe de code-barre à 3 lettres

## Automatisation avec GitHub Actions + GitHub Pages

Le fichier `.github/workflows/generate-barcodes.yml` fait tourner
`generate-missing-barcodes.js` toutes les 15 minutes, puis publie
`labels-a-imprimer.html` sur GitHub Pages (accessible depuis un lien fixe,
consultable et imprimable depuis n'importe quel navigateur, sans avoir besoin
d'allumer un ordinateur).

**Pourquoi GitHub Pages via `actions/upload-pages-artifact` plutôt qu'un commit ?**
Publier directement un artefact de déploiement (au lieu de commiter le fichier HTML
généré dans une branche) évite de polluer l'historique Git avec un commit automatique
toutes les 15 minutes — l'historique du dépôt reste propre et ne contient que tes
propres commits.

### Configuration à faire une fois (dans GitHub, pas ici)

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

Une fois ces 2 réglages faits et le code poussé, le workflow tourne automatiquement
toutes les 15 minutes. Tu peux aussi le déclencher manuellement depuis l'onglet
**Actions** du repo (bouton "Run workflow"), et retrouver le lien de la page publiée
dans **Settings → Pages** une fois le premier déploiement terminé.

## Tester en local

```bash
npm install
npm run generate-barcodes
```

Le fichier `labels-a-imprimer.html` est créé/complété à la racine du projet.
Ouvre-le dans un navigateur puis Ctrl+P pour imprimer.

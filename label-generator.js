import bwipjs from "bwip-js";
import { createCanvas, loadImage } from "canvas";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dossier où lire/écrire les fichiers persistants (registre + pages HTML).
// En local (DATA_DIR non défini) : racine du projet, comme avant.
// En CI : pointe vers le checkout séparé de la branche "data" (voir les
// workflows .github/workflows/*.yml), pour ne jamais committer sur "main".
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;

// ==================================================================
// DIMENSIONS DE L'ÉTIQUETTE — format physique confirmé : 50x25mm.
// ==================================================================
const LABEL_WIDTH_MM = 50;
const LABEL_HEIGHT_MM = 25;
const LABEL_FONT_SIZE_PT = 10;

// Grossissement de l'aperçu à L'ÉCRAN (px par mm). Sans ça, un aperçu qui
// respecte les vraies dimensions mm (50x25mm) tient dans ~190x94px sur un
// écran classique — minuscule et illisible. Purement cosmétique : n'affecte
// jamais l'impression (@media print garde les vraies dimensions en mm).
const SCREEN_PREVIEW_SCALE_PX_PER_MM = 6;

// MODE_PAPIER_CONTINU = true  -> Xprinter XP-80T actuelle : rouleau thermique
//   CONTINU, pas de découpe auto ni de capteur de gap. Toutes les étiquettes
//   s'enchaînent sur UNE seule "page" d'impression (sans saut de page), avec
//   juste un repère pointillé entre chaque pour guider la découpe aux ciseaux.
// MODE_PAPIER_CONTINU = false -> future Xprinter XP-365B : vraies étiquettes
//   autocollantes PRÉ-DÉCOUPÉES (taille LABEL_WIDTH_MM x LABEL_HEIGHT_MM) +
//   capteur de gap automatique. Chaque
//   étiquette DOIT correspondre à une "page" d'impression distincte (saut de
//   page après chaque étiquette), pour que le capteur retrouve la frontière
//   physique de chaque étiquette.
// À bascule le jour où l'imprimante change : aucune autre valeur à toucher.
const MODE_PAPIER_CONTINU = true;
// ==================================================================

// Registre persistant : TOUTES les étiquettes jamais générées (jamais vidé).
// Committé sur la branche "data" pour survivre entre deux exécutions séparées
// de GitHub Actions (chaque run repart d'un checkout propre du dépôt).
const RECORDS_PATH = path.join(DATA_DIR, "generated-labels.json");

// Horodatage du dernier "vidage" de la liste des nouveautés.
const RESET_STATE_PATH = path.join(DATA_DIR, "dernier-vidage.json");

// Page héritée, conservée telle quelle (ancien design) le temps de valider
// les 3 nouvelles pages ci-dessous — PAS encore supprimée, à confirmer avec
// l'utilisateur avant suppression définitive.
const CATALOGUE_PATH = path.join(DATA_DIR, "catalogue-complet.html");

const NOUVEAUX_PATH = path.join(DATA_DIR, "nouveaux.html");
const GROS_PATH = path.join(DATA_DIR, "catalogue-gros.html");
const DETAIL_PATH = path.join(DATA_DIR, "catalogue-detail.html");
const STYLES_PATH = path.join(DATA_DIR, "styles.css");
const SEARCH_SCRIPT_PATH = path.join(DATA_DIR, "search.js");

// Un produit va sur catalogue-gros.html si son nom contient "(gros)"
// (insensible à la casse). Tout le reste (suffixe "(détail)" explicite OU
// aucun suffixe du tout — anciens produits créés avant cette distinction)
// va sur catalogue-detail.html.
function isGros(name) {
  return /\(gros\)/i.test(name);
}

const PAGES = [
  { key: "nouveaux", label: "Nouveautés", href: "nouveaux.html", bg: "#e5e7eb", fg: "#374151" },
  { key: "gros", label: "Gros", href: "catalogue-gros.html", bg: "#fef3c7", fg: "#92400e" },
  { key: "detail", label: "Détail", href: "catalogue-detail.html", bg: "#dbeafe", fg: "#1e40af" },
];

function loadRecords() {
  if (!fs.existsSync(RECORDS_PATH)) return [];
  return JSON.parse(fs.readFileSync(RECORDS_PATH, "utf-8"));
}

function saveRecords(records) {
  fs.writeFileSync(RECORDS_PATH, JSON.stringify(records, null, 2), "utf-8");
}

function loadResetState() {
  if (!fs.existsSync(RESET_STATE_PATH)) {
    return { lastReset: "1970-01-01T00:00:00.000Z" };
  }
  return JSON.parse(fs.readFileSync(RESET_STATE_PATH, "utf-8"));
}

function saveResetState(state) {
  fs.writeFileSync(RESET_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Génère UNE SEULE image (nom du produit + code-barres) au format PNG, encodée
 * en base64. Fusionnés dans le même visuel (via un canvas) plutôt que deux
 * éléments HTML séparés : sur mobile, un "enregistrer l'image" en appui long
 * ne capture qu'un seul élément — s'ils étaient séparés, le nom du produit
 * disparaissait de l'image sauvegardée.
 */
async function generateLabelImageBase64({ name, code }) {
  const barcodePng = await bwipjs.toBuffer({
    bcid: "code128",
    text: code,
    // Résolution plus élevée (5 au lieu de 3) : agrandit le code-barre tout
    // en gardant un bon rendu net, à l'écran comme à l'impression.
    scale: 5,
    // Hauteur des barres proportionnelle à l'étiquette (laisse la place au nom
    // du produit au-dessus) plutôt qu'une valeur fixe qui peut être trop
    // petite (ou trop grande) selon LABEL_HEIGHT_MM.
    height: Math.round(LABEL_HEIGHT_MM * 0.55),
    includetext: true,
    textxalign: "center",
    textsize: 11,
    // Marge de silence (quiet zone) généreuse autour des barres : indispensable
    // pour que les lecteurs de code-barres (scanner ou appli mobile) accrochent
    // le code de façon fiable. Gardée intacte malgré l'agrandissement.
    paddingwidth: 12,
    paddingheight: 8,
  });
  const barcodeImg = await loadImage(barcodePng);

  const PADDING = 18;
  const FONT_SIZE = 38;
  const LINE_HEIGHT = Math.round(FONT_SIZE * 1.15);
  const MAX_NAME_LINES = 3;
  const canvasWidth = Math.max(barcodeImg.width + PADDING * 2, 260);
  const maxTextWidth = canvasWidth - PADDING * 2;

  const measureCtx = createCanvas(1, 1).getContext("2d");
  measureCtx.font = `bold ${FONT_SIZE}px sans-serif`;
  const nameLines = wrapText(measureCtx, name, maxTextWidth, MAX_NAME_LINES);

  const textBlockHeight = nameLines.length * LINE_HEIGHT;
  const canvasHeight = PADDING + textBlockHeight + Math.round(PADDING / 2) + barcodeImg.height + PADDING;

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  ctx.fillStyle = "#000000";
  ctx.font = `bold ${FONT_SIZE}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  nameLines.forEach((line, i) => {
    ctx.fillText(line, canvasWidth / 2, PADDING + i * LINE_HEIGHT, maxTextWidth);
  });

  const barcodeX = Math.round((canvasWidth - barcodeImg.width) / 2);
  const barcodeY = PADDING + textBlockHeight + Math.round(PADDING / 2);
  ctx.drawImage(barcodeImg, barcodeX, barcodeY);

  return `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`;
}

/**
 * Découpe un texte en lignes qui tiennent dans maxWidth (mesure réelle via
 * le contexte canvas, pas une estimation au nombre de caractères). Si le
 * texte dépasse maxLines, la dernière ligne gardée est tronquée avec "…".
 */
function wrapText(ctx, text, maxWidth, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);

  if (lines.length <= maxLines) return lines;

  const kept = lines.slice(0, maxLines);
  let lastLine = kept[maxLines - 1];
  while (lastLine.length > 1 && ctx.measureText(`${lastLine}…`).width > maxWidth) {
    lastLine = lastLine.slice(0, -1);
  }
  kept[maxLines - 1] = `${lastLine}…`;
  return kept;
}

/**
 * Enregistre une étiquette (nom + catégorie + code-barres) dans le registre
 * persistant, puis régénère les deux pages HTML (catalogue complet + nouveaux).
 */
export async function addLabelToPrintSheet({ name, category, code }) {
  const records = loadRecords();
  records.push({
    name,
    category: category || "Divers",
    code,
    generatedAt: new Date().toISOString(),
  });
  saveRecords(records);

  await regenerateSheets();
  console.log(`Étiquette ajoutée au registre : ${name} (${code})`);
}

/**
 * Vide la liste des "nouveaux" (marque tout ce qui existe actuellement comme
 * déjà imprimé) sans toucher au catalogue complet ni au registre persistant.
 */
export async function resetNouveaux() {
  saveResetState({ lastReset: new Date().toISOString() });
  await regenerateSheets();
  console.log("Liste des nouveautés vidée.");
}

async function regenerateSheets() {
  const records = loadRecords();
  const { lastReset } = loadResetState();

  const sorted = [...records].sort((a, b) => {
    const catCompare = a.category.localeCompare(b.category, "fr");
    if (catCompare !== 0) return catCompare;
    return a.name.localeCompare(b.name, "fr");
  });

  const nouveaux = sorted.filter((r) => new Date(r.generatedAt) > new Date(lastReset));
  const gros = sorted.filter((r) => isGros(r.name));
  const detail = sorted.filter((r) => !isGros(r.name));

  // Page héritée, ancien design, conservée le temps de valider les 3 nouvelles.
  await writeLegacySheet({
    filePath: CATALOGUE_PATH,
    title: "Catalogue complet des codes-barres",
    records: sorted,
    navLinkHref: "nouveaux.html",
    navLinkText: "→ Voir les nouveaux codes-barres à imprimer",
  });

  await writeStylesheet();
  await writeSearchScript();

  await writeCategorizedSheet({
    filePath: NOUVEAUX_PATH,
    pageKey: "nouveaux",
    title: "Nouveaux codes-barres à imprimer",
    intro: "Codes générés depuis le dernier vidage (voir le workflow \"Marquer les nouveautés comme imprimées\").",
    printInstructions: `Ouvre cette page puis fais Ctrl+P (ou Cmd+P) pour imprimer. Chaque étiquette (${LABEL_WIDTH_MM}mm x ${LABEL_HEIGHT_MM}mm) sortira l'une après l'autre, avec un repère pointillé net entre chaque pour guider la découpe.`,
    records: nouveaux,
  });

  await writeCategorizedSheet({
    filePath: GROS_PATH,
    pageKey: "gros",
    title: "Catalogue Gros",
    intro: "Uniquement les produits dont le nom contient « (gros) ». Page de référence pour l'impression des étiquettes cartons.",
    printInstructions: "Télécharge l'image du produit concerné, puis imprime-la via l'app sur la tablette.",
    records: gros,
  });

  await writeCategorizedSheet({
    filePath: DETAIL_PATH,
    pageKey: "detail",
    title: "Catalogue Détail",
    intro: "Produits « (détail) » ou sans suffixe (anciens produits). Page de référence, pas destinée à l'impression.",
    printInstructions: null,
    warningBanner: "CES CODES NE SONT PAS À IMPRIMER POUR LE MOMENT",
    records: detail,
  });
}

async function writeLegacySheet({ filePath, title, records, navLinkHref, navLinkText }) {
  const labelsHtml = [];
  for (const r of records) {
    const imageDataUri = await generateLabelImageBase64({ name: r.name, code: r.code });
    labelsHtml.push(`
    <div class="label">
      <img src="${imageDataUri}" alt="${escapeHtml(r.name)} (${escapeHtml(r.code)})" />
    </div>`);
  }

  // Taille de la "page" d'impression et gestion des sauts de page : dépend de
  // MODE_PAPIER_CONTINU (voir la constante en haut du fichier).
  const labelCount = Math.max(records.length, 1);
  const pageWidthMm = LABEL_WIDTH_MM;
  const pageHeightMm = MODE_PAPIER_CONTINU ? labelCount * LABEL_HEIGHT_MM : LABEL_HEIGHT_MM;

  const printBreakCss = MODE_PAPIER_CONTINU
    ? `
    .label {
      page-break-inside: avoid;
      break-inside: avoid;
    }`
    : `
    .label {
      page-break-after: always;
      break-after: page;
    }
    .label:last-child {
      page-break-after: auto;
      break-after: auto;
    }`;

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: Arial, sans-serif; margin: 20px; }
  .no-print { }

  /* Aperçu à l'écran : grille compacte pour naviguer/vérifier les étiquettes.
     Volontairement agrandie (SCREEN_PREVIEW_SCALE_PX_PER_MM) par rapport aux
     vraies dimensions mm, pour rester lisible sur un écran classique — ça
     n'affecte jamais l'impression, qui garde les vraies dimensions physiques
     (voir @media print plus bas). */
  .sheet { display: flex; flex-wrap: wrap; gap: 14px; }
  .label {
    border: 1px dashed #999;
    padding: 8px 12px;
    text-align: center;
    width: ${LABEL_WIDTH_MM * SCREEN_PREVIEW_SCALE_PX_PER_MM}px;
    height: ${LABEL_HEIGHT_MM * SCREEN_PREVIEW_SCALE_PX_PER_MM}px;
    font-size: ${LABEL_FONT_SIZE_PT}pt;
    box-sizing: border-box;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  .label img { width: 96%; height: auto; max-height: 94%; object-fit: contain; }

  /* Taille de "page" forcée à celle de l'étiquette (ou du lot entier en mode
     papier continu) — sans ça, Chrome imprime en A4 par défaut avec le
     code-barre isolé dans un coin. Cette règle @page est volontairement HORS
     de @media print : @page n'a de toute façon aucun effet à l'écran, et
     l'imbriquer dans @media print peut empêcher Chrome de l'appliquer. */
  @page {
    size: ${pageWidthMm}mm ${pageHeightMm}mm;
    margin: 0;
  }

  @media print {
    .no-print { display: none; }
    body { margin: 0; }
    .sheet { display: block; }
    .label {
      width: ${LABEL_WIDTH_MM}mm;
      height: ${LABEL_HEIGHT_MM}mm;
      border: 1px dashed #999;
    }${printBreakCss}
  }
</style>
</head>
<body>
  <div class="no-print">
    <h2>${escapeHtml(title)}</h2>
    <p>Ouvre ce fichier dans ton navigateur puis fais Ctrl+P (ou Cmd+P) pour imprimer.
    Chaque étiquette (${LABEL_WIDTH_MM}mm x ${LABEL_HEIGHT_MM}mm) sortira l'une après
    l'autre, avec un repère pointillé net entre chaque pour guider la découpe.</p>
    <p><a href="${navLinkHref}">${escapeHtml(navLinkText)}</a></p>
  </div>
  <div class="sheet">
${labelsHtml.join("\n")}
  </div>
</body>
</html>`;

  fs.writeFileSync(filePath, html, "utf-8");
}

/**
 * Feuille de style partagée par les 3 pages "nouveau design" (nouveaux,
 * gros, detail) : nav, badges, regroupement par catégorie, responsive.
 * Ne contient AUCUNE règle d'impression — le CSS d'impression (@page +
 * @media print) reste spécifique à chaque page (voir writeCategorizedSheet),
 * car la hauteur de page dépend du nombre d'étiquettes de CETTE page.
 */
async function writeStylesheet() {
  const css = `
* { box-sizing: border-box; }
body { font-family: Arial, sans-serif; margin: 20px; background: #fafafa; color: #111827; }

.topnav {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 2px solid #e5e7eb;
}
.nav-link {
  padding: 6px 14px;
  border-radius: 999px;
  text-decoration: none;
  font-weight: bold;
  font-size: 14px;
  color: #374151;
  background: #f3f4f6;
  border: 1px solid #d1d5db;
}
.nav-link.active { background: #111827; color: #fff; border-color: #111827; }

.page-header { margin-bottom: 20px; }
.badge {
  display: inline-block;
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: bold;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  margin-bottom: 8px;
}
${PAGES.map((p) => `.badge-${p.key} { background: ${p.bg}; color: ${p.fg}; }`).join("\n")}

.page-header h1 { margin: 4px 0 8px; font-size: 22px; }
.page-header p { margin: 0 0 6px; color: #4b5563; font-size: 14px; }
.page-header a { color: #2563eb; }

.search-box {
  display: block;
  width: 100%;
  max-width: 420px;
  box-sizing: border-box;
  margin: 4px 0 12px;
  padding: 8px 14px;
  font-size: 14px;
  font-family: inherit;
  color: #111827;
  background: #fff;
  border: 1px solid #d1d5db;
  border-radius: 999px;
  outline: none;
}
.search-box:focus { border-color: #111827; box-shadow: 0 0 0 2px rgba(17, 24, 39, 0.1); }
.search-box::placeholder { color: #9ca3af; }

.warning-banner {
  display: block;
  background: #fee2e2;
  color: #b91c1c;
  border: 2px solid #b91c1c;
  border-radius: 8px;
  padding: 10px 16px;
  margin: 6px 0 12px;
  font-size: 16px;
  font-weight: bold;
  text-align: center;
}

.category-section { margin-bottom: 28px; }
.category-heading {
  font-size: 15px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #6b7280;
  border-bottom: 1px solid #e5e7eb;
  padding-bottom: 6px;
  margin-bottom: 12px;
}

.empty-state { color: #6b7280; font-style: italic; }

.sheet { display: flex; flex-wrap: wrap; gap: 14px; }
.label {
  border: 1px dashed #999;
  padding: 8px 12px;
  text-align: center;
  width: ${LABEL_WIDTH_MM * SCREEN_PREVIEW_SCALE_PX_PER_MM}px;
  height: ${LABEL_HEIGHT_MM * SCREEN_PREVIEW_SCALE_PX_PER_MM}px;
  box-sizing: border-box;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: #fff;
  border-radius: 6px;
}
.label img { width: 96%; height: auto; max-height: 94%; object-fit: contain; }

@media (max-width: 480px) {
  body { margin: 12px; }
  .nav-link { font-size: 13px; padding: 5px 10px; }
  .page-header h1 { font-size: 19px; }
  .label {
    width: ${Math.round(LABEL_WIDTH_MM * SCREEN_PREVIEW_SCALE_PX_PER_MM * 0.8)}px;
    height: ${Math.round(LABEL_HEIGHT_MM * SCREEN_PREVIEW_SCALE_PX_PER_MM * 0.8)}px;
  }
}
`;

  fs.writeFileSync(STYLES_PATH, css, "utf-8");
}

/**
 * Script partagé par les 3 pages "nouveau design" : filtre en temps réel les
 * étiquettes de LA PAGE COURANTE UNIQUEMENT (chaque page charge ce même
 * fichier mais ne touche qu'à son propre DOM — pas de recherche croisée
 * entre pages). Pur JS navigateur, aucun appel réseau. Insensible à la
 * casse et aux accents (normalisation NFD + retrait des diacritiques).
 */
async function writeSearchScript() {
  const js = `
document.addEventListener("DOMContentLoaded", () => {
  const input = document.querySelector(".search-box");
  if (!input) return;

  const labels = Array.from(document.querySelectorAll(".label"));
  const sections = Array.from(document.querySelectorAll(".category-section"));
  const noResults = document.querySelector(".search-no-results");

  function normalize(s) {
    return (s || "")
      .normalize("NFD")
      .replace(/[\\u0300-\\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  input.addEventListener("input", () => {
    const query = normalize(input.value);
    let visibleCount = 0;

    labels.forEach((label) => {
      const match = query === "" || normalize(label.dataset.name).includes(query);
      label.style.display = match ? "" : "none";
      if (match) visibleCount++;
    });

    sections.forEach((section) => {
      const anyVisible = Array.from(section.querySelectorAll(".label")).some(
        (l) => l.style.display !== "none"
      );
      section.style.display = anyVisible ? "" : "none";
    });

    if (noResults) noResults.style.display = visibleCount === 0 ? "" : "none";
  });
});
`;

  fs.writeFileSync(SEARCH_SCRIPT_PATH, js, "utf-8");
}

/**
 * Génère une page "nouveau design" (nouveaux / gros / detail) : bandeau de
 * navigation, badge de couleur, produits regroupés par catégorie. Utilise la
 * feuille de style partagée (styles.css) pour tout ce qui est écran.
 *
 * Le CSS d'impression (@page + @media print) reste inline, page par page,
 * IDENTIQUE dans sa logique à avant (même sélecteurs, mêmes propriétés) :
 * seule la hauteur de page calculée change, car elle dépend du nombre
 * d'étiquettes de CETTE page précise. Deux règles sont ajoutées (pas
 * modifiées) pour que les nouveaux éléments (nav, titres de catégorie)
 * n'apparaissent jamais à l'impression et ne décalent pas le calcul de
 * hauteur de page.
 */
async function writeCategorizedSheet({ filePath, pageKey, title, intro, printInstructions = null, warningBanner = null, records }) {
  const groups = new Map();
  for (const r of records) {
    if (!groups.has(r.category)) groups.set(r.category, []);
    groups.get(r.category).push(r);
  }

  const sectionsHtml = [];
  for (const [category, categoryRecords] of groups) {
    const labelsHtml = [];
    for (const r of categoryRecords) {
      const imageDataUri = await generateLabelImageBase64({ name: r.name, code: r.code });
      labelsHtml.push(`
      <div class="label" data-name="${escapeHtml(r.name)}">
        <img src="${imageDataUri}" alt="${escapeHtml(r.name)} (${escapeHtml(r.code)})" />
      </div>`);
    }
    sectionsHtml.push(`
    <section class="category-section">
      <h2 class="category-heading">${escapeHtml(category)}</h2>
      <div class="sheet">
${labelsHtml.join("\n")}
      </div>
    </section>`);
  }

  // Taille de la "page" d'impression et gestion des sauts de page : dépend de
  // MODE_PAPIER_CONTINU (voir la constante en haut du fichier). Logique
  // strictement identique à avant.
  const labelCount = Math.max(records.length, 1);
  const pageWidthMm = LABEL_WIDTH_MM;
  const pageHeightMm = MODE_PAPIER_CONTINU ? labelCount * LABEL_HEIGHT_MM : LABEL_HEIGHT_MM;

  const printBreakCss = MODE_PAPIER_CONTINU
    ? `
    .label {
      page-break-inside: avoid;
      break-inside: avoid;
    }`
    : `
    .label {
      page-break-after: always;
      break-after: page;
    }
    .label:last-child {
      page-break-after: auto;
      break-after: auto;
    }`;

  const theme = PAGES.find((p) => p.key === pageKey);
  const navHtml = PAGES.map(
    (p) => `<a class="nav-link${p.key === pageKey ? " active" : ""}" href="${p.href}">${escapeHtml(p.label)}</a>`
  ).join("\n    ");

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="styles.css">
<script src="search.js" defer></script>
<style>
  /* Impression : taille de page = celle de l'étiquette (ou du lot entier en
     mode papier continu). Logique inchangée par rapport à avant. */
  @page {
    size: ${pageWidthMm}mm ${pageHeightMm}mm;
    margin: 0;
  }

  @media print {
    .no-print { display: none; }
    body { margin: 0; }
    .sheet { display: block; }
    .label {
      width: ${LABEL_WIDTH_MM}mm;
      height: ${LABEL_HEIGHT_MM}mm;
      border: 1px dashed #999;
    }${printBreakCss}
    /* Nouveau par rapport à avant : le nom de catégorie et l'espacement de
       section n'existaient pas dans l'ancien design. Sans ces 2 règles, ils
       s'imprimeraient et décaleraient le calcul de hauteur de page ci-dessus. */
    .category-heading { display: none; }
    .category-section { margin: 0; padding: 0; }
  }
</style>
</head>
<body>
  <nav class="topnav no-print">
    ${navHtml}
  </nav>
  <div class="page-header no-print">
    <span class="badge badge-${pageKey}">${escapeHtml(theme.label)}</span>
    <h1>${escapeHtml(title)}</h1>
    ${warningBanner ? `<div class="warning-banner">${escapeHtml(warningBanner)}</div>` : ""}
    <input type="search" class="search-box no-print" placeholder="Rechercher un produit..." aria-label="Rechercher un produit sur cette page">
    <p>${escapeHtml(intro)}</p>
    ${printInstructions ? `<p>${escapeHtml(printInstructions)}</p>` : ""}
  </div>
  <p class="no-print empty-state search-no-results" style="display: none;">Aucun produit trouvé.</p>
  ${sectionsHtml.join("\n") || `<p class="no-print empty-state">Aucune étiquette pour le moment.</p>`}
</body>
</html>`;

  fs.writeFileSync(filePath, html, "utf-8");
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

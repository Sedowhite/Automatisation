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
//   autocollantes PRÉ-DÉCOUPÉES 40x30mm + capteur de gap automatique. Chaque
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

const CATALOGUE_PATH = path.join(DATA_DIR, "catalogue-complet.html");
const NOUVEAUX_PATH = path.join(DATA_DIR, "nouveaux.html");

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

  await writeSheet({
    filePath: CATALOGUE_PATH,
    title: "Catalogue complet des codes-barres",
    records: sorted,
    navLinkHref: "nouveaux.html",
    navLinkText: "→ Voir les nouveaux codes-barres à imprimer",
  });

  await writeSheet({
    filePath: NOUVEAUX_PATH,
    title: "Nouveaux codes-barres à imprimer",
    records: nouveaux,
    navLinkHref: "catalogue-complet.html",
    navLinkText: "→ Voir le catalogue complet",
  });
}

async function writeSheet({ filePath, title, records, navLinkHref, navLinkText }) {
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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

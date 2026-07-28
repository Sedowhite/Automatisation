import bwipjs from "bwip-js";
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
// DIMENSIONS DE L'ÉTIQUETTE — à ajuster une fois le modèle d'imprimante
// Xprinter et le rouleau thermique confirmés. Valeurs de départ : 40x30mm.
// ==================================================================
const LABEL_WIDTH_MM = 40;
const LABEL_HEIGHT_MM = 30;
const LABEL_FONT_SIZE_PT = 10;
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
 * Génère l'image du code-barres (les vraies barres verticales + le texte),
 * au format Code-128, encodée en base64 pour être intégrée directement dans une page HTML.
 */
async function generateBarcodeImageBase64(code) {
  const png = await bwipjs.toBuffer({
    bcid: "code128",
    text: code,
    scale: 3,
    height: 12,
    includetext: true,
    textxalign: "center",
  });
  return `data:image/png;base64,${png.toString("base64")}`;
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
    const imageDataUri = await generateBarcodeImageBase64(r.code);
    labelsHtml.push(`
    <div class="label">
      <div class="label-name">${escapeHtml(r.name)}</div>
      <img src="${imageDataUri}" alt="${escapeHtml(r.code)}" />
    </div>`);
  }

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: Arial, sans-serif; margin: 20px; }
  .no-print { }

  /* Aperçu à l'écran : grille compacte pour naviguer/vérifier les étiquettes */
  .sheet { display: flex; flex-wrap: wrap; gap: 10px; }
  .label {
    border: 1px dashed #999;
    padding: 8px 12px;
    text-align: center;
    width: ${LABEL_WIDTH_MM}mm;
    height: ${LABEL_HEIGHT_MM}mm;
    font-size: ${LABEL_FONT_SIZE_PT}pt;
    box-sizing: border-box;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  .label-name { margin-bottom: 4px; font-weight: bold; }
  .label img { max-width: 100%; }

  /* Impression : UNE étiquette par page, taille exacte du rouleau/de l'étiquette
     (${LABEL_WIDTH_MM}mm x ${LABEL_HEIGHT_MM}mm). Le repère pointillé reste visible
     à l'impression (découpe ciseaux sur papier continu) et le saut de page à chaque
     étiquette donne un point net et régulier, repérable aussi par le capteur
     automatique d'une future imprimante à étiquettes autocollantes. */
  @media print {
    .no-print { display: none; }
    @page {
      size: ${LABEL_WIDTH_MM}mm ${LABEL_HEIGHT_MM}mm;
      margin: 0;
    }
    body { margin: 0; }
    .sheet { display: block; }
    .label {
      width: ${LABEL_WIDTH_MM}mm;
      height: ${LABEL_HEIGHT_MM}mm;
      border: 1px dashed #999;
      page-break-after: always;
      break-after: page;
    }
    .label:last-child {
      page-break-after: auto;
      break-after: auto;
    }
  }
</style>
</head>
<body>
  <div class="no-print">
    <h2>${escapeHtml(title)}</h2>
    <p>Ouvre ce fichier dans ton navigateur puis fais Ctrl+P (ou Cmd+P) pour imprimer.
    Chaque étiquette (${LABEL_WIDTH_MM}mm x ${LABEL_HEIGHT_MM}mm) sortira sur son propre
    repère de découpe, l'une après l'autre.</p>
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

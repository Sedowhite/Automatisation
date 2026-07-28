import bwipjs from "bwip-js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHEET_PATH = path.join(__dirname, "labels-a-imprimer.html");

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
 * Ajoute une étiquette (nom + code-barres) à la feuille d'étiquettes à imprimer.
 * Chaque nouveau produit s'accumule dans le même fichier, que ta patronne peut
 * ouvrir et imprimer quand elle veut (pas besoin de le faire produit par produit).
 */
export async function addLabelToPrintSheet({ name, code }) {
  const imageDataUri = await generateBarcodeImageBase64(code);

  const labelHtml = `
    <div class="label">
      <div class="label-name">${escapeHtml(name)}</div>
      <img src="${imageDataUri}" alt="${code}" />
    </div>`;

  if (!fs.existsSync(SHEET_PATH)) {
    fs.writeFileSync(SHEET_PATH, buildSheetSkeleton(), "utf-8");
  }

  let content = fs.readFileSync(SHEET_PATH, "utf-8");
  content = content.replace("<!-- LABELS -->", `${labelHtml}\n<!-- LABELS -->`);
  fs.writeFileSync(SHEET_PATH, content, "utf-8");

  console.log(`Étiquette ajoutée à la feuille d'impression : ${name} (${code})`);
}

function buildSheetSkeleton() {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Étiquettes à imprimer</title>
<style>
  body { font-family: Arial, sans-serif; margin: 20px; }
  .sheet { display: flex; flex-wrap: wrap; gap: 10px; }
  .label {
    border: 1px dashed #999;
    padding: 8px 12px;
    text-align: center;
    width: 220px;
  }
  .label-name { font-size: 13px; margin-bottom: 4px; font-weight: bold; }
  .label img { max-width: 100%; }
  @media print {
    .label { border: none; }
  }
</style>
</head>
<body>
  <h2>Étiquettes à imprimer (code-barres)</h2>
  <p>Ouvre ce fichier dans ton navigateur puis fais Ctrl+P (ou Cmd+P) pour imprimer.</p>
  <div class="sheet">
<!-- LABELS -->
  </div>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

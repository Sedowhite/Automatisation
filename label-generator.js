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
// DIMENSIONS DE L'ÉTIQUETTE — format physique réel confirmé : 40x20mm
// (corrigé le 2026-09-12 : l'ancien 50x25mm ne correspondait pas au vrai
// rouleau, ce qui causait un décalage progressif à l'impression physique —
// le logiciel déclarait une page/étiquette plus grande que la vraie bande,
// donc le contenu d'une étiquette finissait par déborder sur la suivante).
// ==================================================================
const LABEL_WIDTH_MM = 40;
const LABEL_HEIGHT_MM = 20;
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

const NOUVEAUX_PATH = path.join(DATA_DIR, "nouveaux.html");
const DETAIL_PATH = path.join(DATA_DIR, "catalogue-detail.html");
const LEGEND_PATH = path.join(DATA_DIR, "legende.html");
const LEGEND_DATA_PATH = path.join(DATA_DIR, "legend-data.json");
const STYLES_PATH = path.join(DATA_DIR, "styles.css");
const SEARCH_SCRIPT_PATH = path.join(DATA_DIR, "search.js");

const PAGES = [
  { key: "nouveaux", label: "Nouveautés", href: "nouveaux.html", bg: "#e5e7eb", fg: "#374151" },
  { key: "detail", label: "Catalogue", href: "catalogue-detail.html", bg: "#dbeafe", fg: "#1e40af" },
  { key: "legende", label: "Légende", href: "legende.html", bg: "#fef3c7", fg: "#92400e" },
];

function loadRecords() {
  if (!fs.existsSync(RECORDS_PATH)) return [];
  return JSON.parse(fs.readFileSync(RECORDS_PATH, "utf-8"));
}

function saveRecords(records) {
  fs.writeFileSync(RECORDS_PATH, JSON.stringify(records, null, 2), "utf-8");
}

function loadLegendData() {
  if (!fs.existsSync(LEGEND_DATA_PATH)) return [];
  return JSON.parse(fs.readFileSync(LEGEND_DATA_PATH, "utf-8"));
}

/**
 * Enregistre les données de la page légende (SKU / nom actuel Loyverse / nom
 * complet d'origine) puis régénère les pages. Séparé du registre principal
 * (generated-labels.json) car "nom actuel" vient de l'état LIVE Loyverse
 * (peut diverger du nom stocké localement, ex. après un renommage manuel) —
 * à fournir par un script qui interroge l'API avant d'appeler cette fonction
 * (voir generate-missing-barcodes.js pour le même genre de séparation
 * API/fichiers).
 */
export async function updateLegendData(rows) {
  fs.writeFileSync(LEGEND_DATA_PATH, JSON.stringify(rows, null, 2), "utf-8");
  await regenerateSheets();
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
 * Génère UNE SEULE image (nom du produit + prix + code-barres) au format PNG,
 * encodée en base64. Fusionnés dans le même visuel (via un canvas) plutôt que
 * des éléments HTML séparés : sur mobile, un "enregistrer l'image" en appui
 * long ne capture qu'un seul élément — s'ils étaient séparés, le nom du
 * produit disparaissait de l'image sauvegardée.
 */
// Pour les FUTURS produits uniquement (voir generate-missing-barcodes.js) :
// si le nom Loyverse se termine par un motif "NombreF" (ex. "Collier perle
// 1500F"), c'est un prix encodé dans le nom faute de prix Loyverse (catalogue
// en pricing_type VARIABLE, sans prix stocké). Dans ce cas, le prix vient de
// ce suffixe et le nom affiché sur l'étiquette est le nom SANS ce suffixe.
// Retourne null si le nom ne correspond pas à ce motif.
const PRICE_SUFFIX_RE = /\s*(\d+)\s*F\s*$/i;

export function extractPriceFromName(rawName) {
  const match = rawName.match(PRICE_SUFFIX_RE);
  if (!match) return null;
  return {
    price: Number(match[1]),
    cleanName: rawName.slice(0, match.index).trim(),
  };
}

/**
 * Réduit la taille de police jusqu'à ce que `text` tienne dans maxWidth (sans
 * jamais descendre sous MIN_PRICE_FONT_SIZE). Utilisé UNIQUEMENT pour la
 * ligne de prix : si le texte est trop long, c'est cette police qui rétrécit,
 * jamais le code-barre (le bloc réservé pour cette ligne garde toujours la
 * même hauteur, calculée sur la taille de police maximale — donc la position
 * du code-barre en dessous ne bouge jamais, quelle que soit la taille réelle
 * choisie ici).
 */
function fitPriceFontSize(ctx, text, maxWidth, maxSize, minSize) {
  let size = maxSize;
  while (size > minSize) {
    ctx.font = `bold ${size}px sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
  return size;
}

// ==================================================================
// ABRÉVIATION DES NOMS : uniquement les mots courants listés ci-dessous —
// tout mot rare/marque/nom propre non listé reste intact (ex. "Boucle Jewly"
// -> "Bouc Jewly", "Jewly" inchangé). Locutions traitées AVANT les mots seuls
// (ex. "Pince à cheveux" en entier, pas juste "cheveux" isolé), sinon l'ordre
// de la liste n'a pas d'importance. Choix d'interprétation à valider : les
// formes plurielles des mots listés
// (ex. "Boucles", "Ongles") sont abrégées aussi (même mot, pas une extension
// à un mot non listé) ; l'accent circonflexe optionnel est toléré
// (Chaine/Chaîne, Boite/Boîte) car il s'agit clairement du même mot.
// ==================================================================
const ABBREVIATION_PHRASES = [
  [/\b2\s*Pi[eè]ces\b/gi, "2P"],
  [/\b3\s*Pi[eè]ces\b/gi, "3P"],
  [/\bSerre[\s-]?t[eê]tes?\b/gi, "Ser Tet"],
  [/\bPince\s+(?:à|a)?\s*cheveux\b/gi, "Pince Chev"],
  [/\b[EÉé]lastique\s+(?:à|a)?\s*cheveux\b/gi, "Elas Chev"],
];

const ABBREVIATION_WORDS = [
  [/\bEnsembles?\b/gi, "Ens"],
  [/\bBoucles?\b/gi, "Bouc"],
  [/\bBracelets?\b/gi, "Brac"],
  [/\bBagues?\b/gi, "Bag"],
  [/\bCha[iî]nes?\b/gi, "Chai"],
  [/\bColliers?\b/gi, "Col"],
  [/\bMontres?\b/gi, "Montr"],
  [/\bCoffrets?\b/gi, "Cofr"],
  [/\bBo[iî]tes?\b/gi, "Boit"],
  [/\bMaquillage\b/gi, "Maq"],
  [/\bOnglerie\b/gi, "Ongl"],
  [/\bOngles?\b/gi, "Ongl"],
  [/\bPiercing\b/gi, "Pierc"],
  [/\bFemme\b/gi, "F"],
  [/\bHomme\b/gi, "H"],
  [/\bEnfant\b/gi, "Enf"],
];

/**
 * Applique la table d'abréviation ci-dessus à un nom. N'abrège QUE les mots
 * reconnus : tout le reste (marques, noms propres, mots non listés) reste
 * strictement inchangé.
 */
export function abbreviateName(name) {
  // Normalisation NFC indispensable : certains noms Loyverse stockent les
  // accents en forme décomposée (ex. "à" = "a" + accent combinant séparé,
  // U+0061 U+0300) au lieu de la forme composée usuelle (U+00E0) — sans ça,
  // les regex ci-dessus (écrites en forme composée) ne matchent pas, en
  // silence, sur ces noms précis (repéré sur "Pince à cheveux" en donnée réelle).
  let result = name.normalize("NFC");
  for (const [re, repl] of ABBREVIATION_PHRASES) result = result.replace(re, repl);
  for (const [re, repl] of ABBREVIATION_WORDS) result = result.replace(re, repl);
  return result.replace(/\s+/g, " ").trim();
}

// ==================================================================
// GÉNÉRATION DE L'ÉTIQUETTE : nom / prix unitaire / prix gros / code-barre,
// même police pour tout le texte, fusionnés sur une seule ligne quand ça
// tient (mesure réelle largeur, pas un gabarit à lignes fixes).
// ==================================================================

/**
 * Un des deux prix (unitaire OU gros) : retourne le nombre arrondi, ou null
 * si inconnu (null/0) — jamais de texte de substitution pour un prix
 * précis manquant.
 */
function formatSinglePriceValue(price) {
  if (price === null || price === undefined || Number(price) <= 0) return null;
  return Math.round(Number(price));
}

/**
 * Prix combiné "{unitaire}F/{gros}F" (ex. "1300F/12000F") si les deux sont
 * connus ; juste "{prix}F" (sans slash ni 2e valeur) si un seul est connu ;
 * null si aucun des deux n'est connu (pas de ligne de prix du tout dans ce cas).
 */
function formatCombinedPriceText(priceUnit, priceWholesale) {
  const u = formatSinglePriceValue(priceUnit);
  const w = formatSinglePriceValue(priceWholesale);
  if (u !== null && w !== null) return `${u}F/${w}F`;
  if (u !== null) return `${u}F`;
  if (w !== null) return `${w}F`;
  return null;
}

export async function generateLabelImageBase64({ name: rawName, code, priceUnit, priceWholesale }) {
  const name = abbreviateName(rawName);
  const barcodePng = await bwipjs.toBuffer({
    bcid: "code128",
    text: code,
    scale: 5,
    // Ratio réduit (0.65 -> 0.60) : légère concession délibérée pour absorber
    // une petite part de la pression d'espace créée par la police du nom plus
    // grande ci-dessous — UNIQUEMENT la hauteur des barres (~8% de moins),
    // jamais leur largeur/résolution (scale reste à 5, donc la largeur d'un
    // module ne change pas). Toute réduction touchant le code-barre, même
    // minime, est revérifiée par décodage réel (voir le test dédié).
    height: Math.round(LABEL_HEIGHT_MM * 0.60),
    includetext: true,
    textxalign: "center",
    textsize: 11,
    paddingwidth: 12,
    paddingheight: 8,
  });
  const barcodeImg = await loadImage(barcodePng);

  const PADDING = 12;
  // Resserré (12 -> 7) pour réduire la marge de risque de débordement à
  // l'impression — reste une marge non nulle explicite (le code-barre ne
  // touche jamais le bloc de texte), dimensions globales et code-barre
  // inchangés par ailleurs.
  const BARCODE_TOP_GAP = 7;
  // Une seule fourchette de police pour TOUT le texte (nom + prix combiné).
  // Augmentée d'un cran (26/14 -> 30/16) : un nom qui ne tient plus sur une
  // seule ligne passe simplement sur 2 lignes (accepté), le code-barre absorbe
  // une petite part de la pression d'espace (voir le ratio de hauteur ci-dessus).
  const FONT_SIZE_MAX = 30;
  const FONT_SIZE_MIN = 16;

  const priceText = formatCombinedPriceText(priceUnit, priceWholesale);

  const canvasWidth = Math.max(barcodeImg.width + PADDING * 2, 200);
  const maxTextWidth = canvasWidth - PADDING * 2;
  const measureCtx = createCanvas(1, 1).getContext("2d");

  // La police commune est dimensionnée pour que le prix (qui ne peut jamais
  // s'enrouler sur plusieurs lignes) tienne sur une seule ligne ; le nom
  // utilise cette même taille.
  const fontSize = priceText
    ? fitPriceFontSize(measureCtx, priceText, maxTextWidth, FONT_SIZE_MAX, FONT_SIZE_MIN)
    : FONT_SIZE_MAX;
  measureCtx.font = `bold ${fontSize}px sans-serif`;

  // Logique dynamique (pas un gabarit à nombre de lignes fixe) : priorité au
  // MINIMUM de lignes. On mesure d'abord si "nom + prix" tient sur une seule
  // ligne (measureText réel, pas une estimation) ; seulement si ça déborde
  // vraiment, le nom passe sur sa/ses propre(s) ligne(s) et le prix (qui, lui,
  // tient toujours sur une ligne par construction ci-dessus) redescend seul
  // en dessous.
  const combinedLine = priceText ? `${name} ${priceText}` : name;
  const combinedFits = measureCtx.measureText(combinedLine).width <= maxTextWidth;

  let textLines;
  if (combinedFits) {
    textLines = [combinedLine];
  } else {
    const nameLines = wrapText(measureCtx, name, maxTextWidth, 3);
    textLines = priceText ? [...nameLines, priceText] : nameLines;
  }

  const LINE_HEIGHT = Math.round(fontSize * 1.15);
  const textBlockHeight = textLines.length * LINE_HEIGHT;
  const canvasHeight = PADDING + textBlockHeight + BARCODE_TOP_GAP + barcodeImg.height + PADDING;

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  ctx.fillStyle = "#000000";
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  textLines.forEach((line, i) => {
    ctx.fillText(line, canvasWidth / 2, PADDING + i * LINE_HEIGHT, maxTextWidth);
  });

  const barcodeX = Math.round((canvasWidth - barcodeImg.width) / 2);
  const barcodeY = PADDING + textBlockHeight + BARCODE_TOP_GAP;
  // drawImage sans redimensionnement : le code-barre est posé à sa taille
  // native, jamais compressé ou redimensionné pour faire de la place au texte.
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
export async function addLabelToPrintSheet({ name, category, code, priceUnit, priceWholesale }) {
  const records = loadRecords();
  records.push({
    name,
    category: category || "Divers",
    code,
    priceUnit,
    priceWholesale,
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

export async function regenerateSheets() {
  const records = loadRecords();
  const { lastReset } = loadResetState();

  const sorted = [...records].sort((a, b) => {
    const catCompare = a.category.localeCompare(b.category, "fr");
    if (catCompare !== 0) return catCompare;
    return a.name.localeCompare(b.name, "fr");
  });

  const nouveaux = sorted.filter((r) => new Date(r.generatedAt) > new Date(lastReset));

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
    filePath: DETAIL_PATH,
    pageKey: "detail",
    title: "Catalogue",
    intro: "Un seul article par produit (plus de distinction gros/détail). Page de référence pour l'impression des étiquettes.",
    printInstructions: `Ouvre cette page puis fais Ctrl+P (ou Cmd+P) pour imprimer. Chaque étiquette (${LABEL_WIDTH_MM}mm x ${LABEL_HEIGHT_MM}mm) sortira l'une après l'autre, avec un repère pointillé net entre chaque pour guider la découpe.`,
    records: sorted,
  });

  await writeLegendPage(loadLegendData());
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

.legend-table {
  width: 100%;
  max-width: 900px;
  border-collapse: collapse;
  background: #fff;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}
.legend-table th, .legend-table td {
  text-align: left;
  padding: 10px 14px;
  font-size: 14px;
  border-bottom: 1px solid #e5e7eb;
}
.legend-table th {
  background: #f9fafb;
  color: #6b7280;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.legend-table tbody tr:hover { background: #fafafa; }
.legend-table .legend-sku { font-family: ui-monospace, Consolas, monospace; font-weight: bold; color: #92400e; white-space: nowrap; }
.legend-table .legend-muted { color: #6b7280; }

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
 * entre pages). Recherche sur le nom OU le SKU/code produit (les deux
 * fonctionnent simultanément, pas l'un ou l'autre). Pur JS navigateur, aucun
 * appel réseau. Insensible à la casse et aux accents (normalisation NFD +
 * retrait des diacritiques).
 */
async function writeSearchScript() {
  const js = `
document.addEventListener("DOMContentLoaded", () => {
  const input = document.querySelector(".search-box");
  if (!input) return;

  // [data-name] plutôt que ".label" : cible aussi bien les étiquettes
  // (nouveaux/detail) que les lignes du tableau de la page légende, sans
  // dupliquer la logique de recherche pour cette 3e page.
  const labels = Array.from(document.querySelectorAll("[data-name]"));
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
      const match = query === ""
        || normalize(label.dataset.name).includes(query)
        || normalize(label.dataset.code).includes(query);
      label.style.display = match ? "" : "none";
      if (match) visibleCount++;
    });

    sections.forEach((section) => {
      const anyVisible = Array.from(section.querySelectorAll("[data-name]")).some(
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
      const imageDataUri = await generateLabelImageBase64({ name: r.name, code: r.code, priceUnit: r.priceUnit, priceWholesale: r.priceWholesale });
      labelsHtml.push(`
      <div class="label" data-name="${escapeHtml(r.name)}" data-code="${escapeHtml(r.code)}">
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
    <input type="search" class="search-box no-print" placeholder="Rechercher par nom ou par SKU..." aria-label="Rechercher un produit par nom ou par SKU sur cette page">
    <p>${escapeHtml(intro)}</p>
    ${printInstructions ? `<p>${escapeHtml(printInstructions)}</p>` : ""}
  </div>
  <p class="no-print empty-state search-no-results" style="display: none;">Aucun produit trouvé.</p>
  ${sectionsHtml.join("\n") || `<p class="no-print empty-state">Aucune étiquette pour le moment.</p>`}
</body>
</html>`;

  fs.writeFileSync(filePath, html, "utf-8");
}

/**
 * Page de référence "Légende" (SKU / nom actuel Loyverse / nom complet
 * d'origine) — pas des étiquettes à imprimer, juste un tableau consultable.
 * Réutilise le même bandeau de navigation, la même feuille de style et le
 * même script de recherche (search.js) que les 2 autres pages : chaque ligne
 * porte data-name/data-code, exactement comme un `.label`, donc la recherche
 * déjà en place (nom OU SKU) fonctionne ici sans aucun code de recherche
 * supplémentaire.
 */
async function writeLegendPage(records) {
  const sorted = [...records].sort((a, b) => a.sku.localeCompare(b.sku));

  const rowsHtml = sorted.map((r) => `
      <tr data-name="${escapeHtml(r.currentName)}" data-code="${escapeHtml(r.sku)}">
        <td class="legend-sku">${escapeHtml(r.sku)}</td>
        <td>${escapeHtml(r.currentName)}</td>
        <td class="legend-muted">${escapeHtml(r.fullName)}</td>
      </tr>`).join("\n");

  const navHtml = PAGES.map(
    (p) => `<a class="nav-link${p.key === "legende" ? " active" : ""}" href="${p.href}">${escapeHtml(p.label)}</a>`
  ).join("\n    ");

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Légende</title>
<link rel="stylesheet" href="styles.css">
<script src="search.js" defer></script>
</head>
<body>
  <nav class="topnav no-print">
    ${navHtml}
  </nav>
  <div class="page-header no-print">
    <span class="badge badge-legende">Légende</span>
    <h1>Légende des noms abrégés</h1>
    <input type="search" class="search-box no-print" placeholder="Rechercher par nom ou par SKU..." aria-label="Rechercher un produit par nom ou par SKU sur cette page">
    <p>SKU, nom actuel (tel qu'affiché dans Loyverse et sur les étiquettes) et nom complet d'origine — référence pour l'équipe.</p>
  </div>
  <p class="no-print empty-state search-no-results" style="display: none;">Aucun produit trouvé.</p>
  ${sorted.length
    ? `<table class="legend-table">
    <thead>
      <tr><th>SKU</th><th>Nom actuel</th><th>Nom complet d'origine</th></tr>
    </thead>
    <tbody>${rowsHtml}
    </tbody>
  </table>`
    : `<p class="no-print empty-state">Aucune donnée de légende pour le moment.</p>`}
</body>
</html>`;

  fs.writeFileSync(LEGEND_PATH, html, "utf-8");
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

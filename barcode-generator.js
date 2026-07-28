import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAP_PATH = path.join(__dirname, "category-prefix-map.json");

function loadMap() {
  if (!fs.existsSync(MAP_PATH)) return {};
  return JSON.parse(fs.readFileSync(MAP_PATH, "utf-8"));
}

function saveMap(map) {
  fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2), "utf-8");
}

function stripAccents(str) {
  return str.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function derivePrefix(categoryName) {
  const lastSegment = categoryName.split(">").pop().trim();
  const lettersOnly = stripAccents(lastSegment).replace(/[^a-zA-Z]/g, "");
  return lettersOnly.slice(0, 3).toUpperCase();
}

/**
 * Génère le prochain code-barre disponible pour une catégorie donnée,
 * au format PREFIXE-NNN. Le préfixe vient de category-prefix-map.json ;
 * s'il n'existe pas encore pour cette catégorie, il est dérivé des 3
 * premières lettres du dernier segment du nom de catégorie puis ajouté
 * au fichier. Le numéro = plus grand numéro déjà utilisé pour ce préfixe
 * parmi tous les codes existants, +1.
 */
export function generateNextCode(categoryName, existingCodes) {
  const map = loadMap();

  let prefix = map[categoryName];
  if (!prefix) {
    prefix = derivePrefix(categoryName);
    map[categoryName] = prefix;
    saveMap(map);
  }

  const codePattern = new RegExp(`^${prefix}-(\\d+)$`, "i");
  let maxNumber = 0;
  for (const code of existingCodes) {
    if (!code) continue;
    const match = code.match(codePattern);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNumber) maxNumber = num;
    }
  }

  const nextNumber = String(maxNumber + 1).padStart(3, "0");
  return `${prefix}-${nextNumber}`;
}

import "dotenv/config";
import { getAllItems, getCategories, assignBarcodeToVariant } from "./loyverse.js";
import { generateNextCode } from "./barcode-generator.js";
import { addLabelToPrintSheet, extractPriceFromName, abbreviateName, loadRecords, saveRecords, regenerateSheets } from "./label-generator.js";

// Reconnaît le format "{nom abrégé} {unitaire}F[/{gros}F]" utilisé depuis le
// renommage Loyverse (ex. "Brac F DCS JEWELRY 1500F/12500F") pour resynchroniser
// un produit EXISTANT si son nom/prix a été modifié à la main dans Loyverse.
// Le nom sans le suffixe prix redevient le "name" du registre (jamais le nom
// complet d'origine, perdu dès qu'on édite directement dans Loyverse) ; le(s)
// prix extrait(s) redeviennent priceUnit/priceWholesale. Un nom sans ce motif
// (ex. les produits sans aucun prix connu) donne priceUnit/priceWholesale null.
const PRICE_TAIL_RE = /^(.*?)\s+(\d+)F(?:\/(\d+)F)?\s*$/;
function parseNameWithPrice(liveName) {
  const m = liveName.match(PRICE_TAIL_RE);
  if (!m) return { name: liveName.trim(), priceUnit: null, priceWholesale: null };
  return { name: m[1].trim(), priceUnit: Number(m[2]), priceWholesale: m[3] ? Number(m[3]) : null };
}

async function run() {
  console.log(`[${new Date().toISOString()}] Recherche des produits sans code-barre...`);

  const items = await getAllItems();
  const categories = await getCategories();
  const categoryNameById = Object.fromEntries(categories.map((c) => [c.id, c.name]));

  const existingCodes = items.flatMap((item) =>
    (item.variants || []).map((v) => v.barcode || v.sku)
  );

  const generated = [];

  for (const item of items) {
    for (const variant of item.variants || []) {
      // Ne pas se fier à variant.sku : Loyverse assigne automatiquement un SKU
      // numérique par défaut aux nouvelles variantes, même sans code-barre saisi.
      if (variant.barcode) continue;

      const categoryName = categoryNameById[item.category_id] || "Divers";
      const barcode = generateNextCode(categoryName, existingCodes);
      existingCodes.push(barcode);

      await assignBarcodeToVariant(item.id, variant.variant_id, barcode);

      // Prix unitaire : priorité au suffixe "NombreF" en fin de nom (ex.
      // "Collier perle 1500F"), sinon le prix Loyverse (default_price, non
      // vide en pricing_type FIXED). Le prix de gros n'est pas connu pour un
      // produit détecté automatiquement ici — fourni séparément plus tard si
      // besoin (voir formatCombinedPriceText dans label-generator.js, qui
      // n'affiche que le prix réellement connu).
      const priceFromName = extractPriceFromName(item.item_name);
      const name = priceFromName ? priceFromName.cleanName : item.item_name;
      const priceUnit = priceFromName ? priceFromName.price : variant.default_price;

      await addLabelToPrintSheet({ name, category: categoryName, code: barcode, priceUnit, priceWholesale: null });

      generated.push({ name, barcode });
      console.log(`  ➕ ${name} -> ${barcode}`);
    }
  }

  console.log(`\n✅ Terminé : ${generated.length} produit(s) traité(s).`);
  if (generated.length > 0) {
    console.log("Codes générés :");
    for (const g of generated) {
      console.log(`  - ${g.name} : ${g.barcode}`);
    }
  }

  // Resynchronisation des produits EXISTANTS (déjà barcodés) : si le nom/prix
  // a été modifié à la main dans Loyverse depuis le dernier run, met à jour le
  // registre en conséquence. Le code-barre/SKU n'est JAMAIS touché ici — cette
  // boucle ne fait que lire variant.barcode pour retrouver l'enregistrement,
  // jamais l'écrire.
  console.log(`\n[${new Date().toISOString()}] Vérification des noms/prix des produits existants...`);
  const records = loadRecords();
  const recordByCode = new Map(records.map((r) => [r.code, r]));
  let syncedCount = 0;
  for (const item of items) {
    for (const variant of item.variants || []) {
      if (!variant.barcode) continue; // déjà traité ci-dessus (nouveau produit)
      const record = recordByCode.get(variant.barcode);
      if (!record) continue; // ne devrait pas arriver ; on ne devine rien

      const liveName = item.item_name;
      const parsed = parseNameWithPrice(liveName);
      // record.name est le nom COMPLET d'origine (jamais abrégé en stockage).
      // Le nom Loyverse live peut être dans DEUX états légitimes, pas un seul :
      // (a) jamais renommé en masse (les SKU sans aucun prix connu ont été
      //     exclus du renommage) -> liveName === record.name tel quel ;
      // (b) renommé en masse -> liveName === abréviation(record.name) + prix.
      // Un FAUX positif perpétuel apparaissait sur le cas (a) : comparer
      // aveuglément à l'abréviation attendue déclenchait un "changement" à
      // chaque run sur ces SKU, alors que rien n'avait bougé.
      const nameMatchesOriginal = liveName === record.name;
      const nameMatchesAbbrevConvention = parsed.name === abbreviateName(record.name);
      const nameActuallyChanged = !nameMatchesOriginal && !nameMatchesAbbrevConvention;
      const priceChanged =
        record.priceUnit !== parsed.priceUnit || record.priceWholesale !== parsed.priceWholesale;

      if (nameActuallyChanged || priceChanged) {
        console.log(
          `  🔄 ${record.code} : "${record.name}" (${record.priceUnit}/${record.priceWholesale}) -> ${
            nameActuallyChanged ? `"${parsed.name}" (nom édité directement dans Loyverse)` : `"${record.name}"`
          } (${parsed.priceUnit}/${parsed.priceWholesale})`
        );
        // Si seul le prix a changé, on garde le nom complet d'origine (pour la
        // légende) — abbreviateName() le ré-abrègera pareil au rendu. Si le nom
        // abrégé lui-même a été édité dans Loyverse, on ne peut plus retrouver
        // de nom complet distinct : on adopte le nom live tel quel.
        if (nameActuallyChanged) record.name = parsed.name;
        record.priceUnit = parsed.priceUnit;
        record.priceWholesale = parsed.priceWholesale;
        syncedCount++;
      }
    }
  }

  if (syncedCount > 0) {
    saveRecords(records);
    await regenerateSheets();
    console.log(`\n🔄 ${syncedCount} produit(s) existant(s) resynchronisé(s) (nom/prix uniquement, code-barre inchangé).`);
  } else {
    console.log("Aucun changement de nom/prix détecté sur les produits existants.");
  }
}

run().catch((err) => {
  console.error("❌ Erreur pendant la génération des codes-barres");
  console.error("URL appelée :", err.method?.toUpperCase(), err.url);
  console.error("Code HTTP :", err.status);
  console.error("Réponse :", typeof err.data === "string" ? err.data.slice(0, 300) : err.data);
  process.exit(1);
});

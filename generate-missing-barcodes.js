import "dotenv/config";
import { getAllItems, getCategories, assignBarcodeToVariant } from "./loyverse.js";
import { generateNextCode } from "./barcode-generator.js";
import { addLabelToPrintSheet } from "./label-generator.js";

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
      await addLabelToPrintSheet({ name: item.item_name, category: categoryName, code: barcode });

      generated.push({ name: item.item_name, barcode });
      console.log(`  ➕ ${item.item_name} -> ${barcode}`);
    }
  }

  console.log(`\n✅ Terminé : ${generated.length} produit(s) traité(s).`);
  if (generated.length > 0) {
    console.log("Codes générés :");
    for (const g of generated) {
      console.log(`  - ${g.name} : ${g.barcode}`);
    }
  }
}

run().catch((err) => {
  console.error("❌ Erreur pendant la génération des codes-barres");
  console.error("URL appelée :", err.config?.method?.toUpperCase(), err.config?.url);
  console.error("Code HTTP :", err.response?.status);
  console.error("Réponse :", typeof err.response?.data === "string" ? err.response.data.slice(0, 300) : err.response?.data);
  process.exit(1);
});

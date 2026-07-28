import axios from "axios";

const BASE_URL = "https://api.loyverse.com/v1.0";

function client() {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Bearer ${process.env.LOYVERSE_ACCESS_TOKEN}`,
    },
  });
}

/**
 * Récupère TOUS les articles (avec leurs variantes : sku, barcode, id)
 * Gère la pagination automatiquement (Loyverse renvoie par pages de 250 max)
 */
export async function getAllItems() {
  const api = client();
  let items = [];
  let cursor = null;

  do {
    const { data } = await api.get("/items", {
      params: { limit: 250, cursor: cursor || undefined },
    });
    items = items.concat(data.items || []);
    cursor = data.cursor || null;
  } while (cursor);

  return items;
}

/**
 * Récupère les niveaux de stock (quantité restante) pour une liste de variant_ids.
 * L'API accepte 100 variant_ids max par appel -> on découpe en lots (chunks).
 */
export async function getInventoryLevels(variantIds) {
  const api = client();
  const chunks = [];
  for (let i = 0; i < variantIds.length; i += 25) {
    chunks.push(variantIds.slice(i, i + 25));
  }

  let levels = [];
  for (const chunk of chunks) {
    let cursor = null;
    do {
      const { data } = await api.get("/inventory", {
        params: {
          variant_ids: chunk.join(","),
          limit: 250,
          cursor: cursor || undefined,
        },
      });
      levels = levels.concat(data.inventory_levels || []);
      cursor = data.cursor || null;
    } while (cursor);
  }

  return levels; // [{ variant_id, store_id, in_stock, ... }]
}

/**
 * Récupère le niveau de stock d'UNE seule variante (utile pour le webhook temps réel)
 */
export async function getInventoryForVariant(variantId) {
  const api = client();
  const { data } = await api.get("/inventory", {
    params: { variant_ids: variantId },
  });
  return data.inventory_levels?.[0] || null;
}

/**
 * Récupère le détail complet d'un article Loyverse par son ID
 * (utile quand le webhook "item créé" ne donne que l'ID)
 */
export async function getItemById(itemId) {
  const api = client();
  const { data } = await api.get(`/items/${itemId}`);
  return data;
}

/**
 * Récupère la liste des catégories (id + nom).
 * Utile car les articles Loyverse (getItemById/getAllItems) ne renvoient
 * que category_id, jamais le nom de la catégorie directement.
 */
export async function getCategories() {
  const api = client();
  const { data } = await api.get("/categories", { params: { limit: 250 } });
  return data.categories || [];
}

/**
 * Met à jour le barcode et le sku d'UNE variante d'un article Loyverse.
 * L'API Loyverse n'a pas de PUT /items/{id} : la mise à jour se fait via
 * POST /items en renvoyant l'article complet (avec son id existant = upsert),
 * pour ne pas perdre les autres variantes/champs de l'article.
 */
export async function assignBarcodeToVariant(itemId, variantId, newCode) {
  const api = client();
  const item = await getItemById(itemId);

  const { created_at, updated_at, deleted_at, ...itemFields } = item;
  const variants = item.variants.map((v) =>
    v.variant_id === variantId ? { ...v, barcode: newCode, sku: newCode } : v
  );

  await api.post("/items", { ...itemFields, variants });

  return newCode;
}

/**
 * Ajoute une quantité (réapprovisionnement) au stock actuel d'une variante.
 * L'API Loyverse fixe une valeur ABSOLUE, donc on lit le stock actuel puis on ajoute.
 * store_id : l'ID du magasin/point de vente Loyverse concerné (voir .env LOYVERSE_STORE_ID)
 */
export async function addStock(variantId, quantityToAdd, storeId) {
  const api = client();
  const current = await getInventoryForVariant(variantId);
  const newQuantity = (current?.in_stock || 0) + quantityToAdd;

  await api.post("/inventory", {
    inventory_levels: [
      {
        variant_id: variantId,
        store_id: storeId,
        in_stock: newQuantity,
      },
    ],
  });

  return newQuantity;
}

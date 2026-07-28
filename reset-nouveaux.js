import "dotenv/config";
import { resetNouveaux } from "./label-generator.js";

resetNouveaux().catch((err) => {
  console.error("❌ Erreur pendant le vidage de la liste des nouveautés");
  console.error(err);
  process.exit(1);
});

import { connectDb, createIndexes } from "./db.js";
import app from "./api.js";
import { env } from "./config.js";

async function main() {
  await connectDb();
  await createIndexes();
  app.listen(env.PORT, () => {
    console.log(`API listening on http://localhost:${env.PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { connectDatabase } from "../connections";
import * as fs from "fs";
import * as path from "path";

exports.handler = async () => {
  const pool = await connectDatabase();
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id         serial    PRIMARY KEY,
        name       VARCHAR   NOT NULL UNIQUE,
        applied_at timestamp NOT NULL DEFAULT now()
      )
    `);

    const migrationsDir = path.join(__dirname, "migrations");
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const applied = await client.query("SELECT name FROM _migrations");
    const appliedNames = new Set(
      applied.rows.map((r: { name: string }) => r.name)
    );

    for (const file of files) {
      if (appliedNames.has(file)) {
        console.log(`Skipping migration: ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO _migrations (name) VALUES ($1)", [
          file,
        ]);
        await client.query("COMMIT");
        console.log(`Applied migration: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
};

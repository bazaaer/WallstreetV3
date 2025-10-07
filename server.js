const express = require("express");
const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");
const session = require("express-session");
require("dotenv").config();

const app = express();

/* ---------------- ENV CHECKS ---------------- */
if (!process.env.MYSQL_URL) {
  console.error("❌ Missing MYSQL_URL env var");
  process.exit(1);
}

/* ---------------- MIDDLEWARE ---------------- */
app.use(express.json());

// Trust the Railway proxy so secure cookies work in production
app.set("trust proxy", 1);

app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-only-secret", // set SESSION_SECRET in Railway
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production", // true on HTTPS (Railway)
      httpOnly: true,
      sameSite: "lax",
    },
  })
);

/* ---------------- FRONTEND ---------------- */
app.use(express.static(path.join(__dirname, "public")));

/* ---------------- MYSQL CONNECTION ---------------- */
const { URL } = require("url");
const u = new URL(process.env.MYSQL_URL);
let db;

(async () => {
  try {
    console.log("🔌 Attempting to connect to MySQL...");

    // Step 1: Connect (no database selected yet)
    const rawConn = await mysql.createConnection({
      host: u.hostname,
      port: u.port ? Number(u.port) : 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      multipleStatements: true, // needed for executing full SQL script
    });

    console.log("✅ MySQL connection established successfully");

    // Step 2: Construct schema if requested
    if (process.env.CONSTRUCT_DATABASE === "true") {
      console.log("⚙️ CONSTRUCT_DATABASE=true — starting schema setup...");

      try {
        const sqlPath = path.join(__dirname, "SQL Script Wall Street Ding.sql");
        const schemaSQL = fs.readFileSync(sqlPath, "utf8");
        await rawConn.query(schemaSQL);
        console.log("✅ Database schema and initial data created successfully");
      } catch (schemaErr) {
        console.error("❌ Database setup failed during schema execution:", schemaErr.message);
        console.error("📄 Check if the SQL file path or syntax is valid.");
        process.exit(1);
      }
    } else {
      console.log("ℹ️ CONSTRUCT_DATABASE not set — skipping schema setup");
    }

    // Step 3: Switch to pooled connection for app use
    db = await mysql.createPool({
      host: u.hostname,
      port: u.port ? Number(u.port) : 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ""),
      waitForConnections: true,
      connectionLimit: 10,
      decimalNumbers: true,
    });

    console.log("✅ MySQL connection pool initialized — ready for queries");

  } catch (connErr) {
    console.error("❌ Failed to connect to MySQL at startup:");
    console.error("   ↳ Host:", u.hostname);
    console.error("   ↳ Port:", u.port || 3306);
    console.error("   ↳ Error:", connErr.message);
    console.error("📄 Tip: Check MYSQL_URL in Railway and ensure the DB is running.");
    process.exit(1);
  }
})();


/* ---------------- CONFIG ---------------- */
const STIJGING = 5;

/* ---------------- HELPERS ---------------- */
async function getTotalsByGroup() {
  const [rows] = await db.query(`
    SELECT is_alcoholic, COALESCE(SUM(ROUND(base_price * 100)),0) AS totaal
    FROM drinks
    WHERE locked = 0
    GROUP BY is_alcoholic
  `);

  return rows.reduce(
    (totals, r) => {
      totals[r.is_alcoholic] = r.totaal;
      return totals;
    },
    { 0: 0, 1: 0 }
  );
}

function zeroSumUpdate(drinks, boughtId, qty = 1) {
  let updated = drinks.map((d) => ({ ...d }));
  const bought = updated.find((d) => d.id === boughtId);

  if (!bought || bought.locked) return updated;

  const group = bought.is_alcoholic;

  // Bereken totaal voor deze groep (alleen unlocked drinks)
  const unlockedInGroup = updated.filter(
    (d) => d.is_alcoholic === group && !d.locked
  );
  const groupTotal = unlockedInGroup.reduce(
    (sum, d) => sum + Math.round(d.base_price * 100),
    0
  );

  // 📌 Stijging als percentage van base_price
  const basePriceInCents = Math.round(bought.base_price * 100);
  const increase = Math.round((basePriceInCents * STIJGING * qty) / 100);

  // Popularity factor en modifier
  const exp = bought.expected_popularity ?? 1;
  const popularityFactor = 1 / (1 + (exp - 1) * 0.2);
  const modifier = bought.modifier ?? 1;

  const inc = Math.round(increase * popularityFactor * modifier);

  // Pas prijs aan van gekochte drink
  bought.price_points += inc;

  // Alleen andere drankjes in dezelfde groep aanpassen
  const others = updated.filter(
    (d) => d.id !== boughtId && !d.locked && d.is_alcoholic === group
  );

  if (others.length > 0 && inc > 0) {
    let share = Math.floor(inc / others.length);
    let remainder = inc % others.length;

    for (let d of others) {
      let reduce = share + (remainder > 0 ? 1 : 0);
      d.price_points = Math.max(0, d.price_points - reduce);
      remainder--;
    }
  }

  // Normaliseer TOTAAL voor deze groep
  let currentTotal = updated
    .filter((d) => d.is_alcoholic === group && !d.locked)
    .reduce((sum, d) => sum + d.price_points, 0);

  let adjust = groupTotal - currentTotal;

  if (Math.abs(adjust) > 0) {
    let targets = updated.filter(
      (d) => !d.locked && d.is_alcoholic === group
    );

    if (targets.length > 0) {
      let fix = Math.floor(adjust / targets.length);
      let rest = adjust % targets.length;

      for (let d of targets) {
        d.price_points += fix + (rest > 0 ? 1 : 0);
        rest--;
      }
    }
  }

  return updated;
}

/* ---------------- REBALANCE ---------------- */
setInterval(async () => {
  try {
    const groupTotals = await getTotalsByGroup();

    for (let group of [0, 1]) {
      const [rows] = await db.query(
        "SELECT SUM(price_points) AS totaal FROM drinks WHERE is_alcoholic=? AND locked=0",
        [group]
      );
      const som = rows[0].totaal ?? 0;
      const diff = som - groupTotals[group];

      // Alleen rebalancen als het verschil significant is
      if (Math.abs(diff) > 50) {
        const [unlocked] = await db.query(
          "SELECT id, price_points FROM drinks WHERE locked = 0 AND is_alcoholic=?",
          [group]
        );

        if (unlocked.length > 0) {
          const changePerDrink = Math.floor(Math.abs(diff) / unlocked.length);
          let remainder = Math.abs(diff) % unlocked.length;

          // Alleen rebalancen als de verandering per drink significant is
          if (changePerDrink > 1) {
            for (const d of unlocked) {
              let change = changePerDrink + (remainder > 0 ? 1 : 0);
              remainder--;
              if (diff > 0) {
                await db.query(
                  "UPDATE drinks SET price_points = price_points - ? WHERE id = ?",
                  [change, d.id]
                );
              } else {
                await db.query(
                  "UPDATE drinks SET price_points = price_points + ? WHERE id = ?",
                  [change, d.id]
                );
              }
            }
            console.log(
              `♻️ Rebalance uitgevoerd voor groep ${group}, som=${som}, verschil=${diff}, aanpassing=${changePerDrink} per drink`
            );
          } else {
            console.log(
              `ℹ️ Rebalance overgeslagen voor groep ${group} (te kleine aanpassing: ${changePerDrink})`
            );
          }
        }
      }
    }
  } catch (err) {
    console.error("❌ Fout bij rebalance:", err);
  }
}, 5000);

/* ---------------- AUTH ---------------- */
function isLoggedIn(req, res, next) {
  if (!req.session.loggedIn)
    return res.status(401).json({ error: "Niet ingelogd" });
  next();
}

/* ---------------- API ---------------- */
app.post("/login", async (req, res) => {
  const { password } = req.body;
  try {
    const [rows] = await db.query(
      "SELECT * FROM access_passwords WHERE password = ? LIMIT 1",
      [password]
    );
    if (rows.length === 0)
      return res.status(401).json({ error: "Ongeldig wachtwoord" });

    req.session.loggedIn = true;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "DB error" });
  }
});

app.get("/config", (req, res) => {
  res.json({ interval: 10000 });
});

app.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: "Logout failed" });
    res.json({ success: true });
  });
});

app.get("/drinks", isLoggedIn, async (_req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM drinks");
    res.json(rows);
  } catch {
    res.status(500).json({ error: "Database query failed" });
  }
});

app.post("/simulate-buy/:id", isLoggedIn, async (req, res) => {
  const id = Number(req.params.id);
  const qty = Number(req.query.qty || 1);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Lock de drinks tabel voor consistentie
    const [drinks] = await conn.query("SELECT * FROM drinks FOR UPDATE");

    // Debug logging
    console.log(`🛒 Aankoop: drink ${id}, hoeveelheid: ${qty}`);
    console.log(
      `📊 Voor aankoop prijzen:`,
      drinks.map((d) => ({
        id: d.id,
        name: d.name,
        price: d.price,
        price_points: d.price_points,
      }))
    );

    const updated = zeroSumUpdate(drinks, id, qty);

    // Update de database
    for (const u of updated) {
      await conn.query(
        "UPDATE drinks SET price_points = ?, price = ? WHERE id = ?",
        [u.price_points, u.price_points / 100, u.id]
      );
    }

    await conn.commit();

    // Debug logging na update
    const [afterUpdate] = await conn.query(
      "SELECT * FROM drinks WHERE id = ?",
      [id]
    );
    console.log(`💰 Na aankoop:`, afterUpdate[0]);

    const bought = updated.find((u) => u.id === id);
    res.json({
      success: true,
      boughtPrice: bought.price_points / 100,
      qty,
      newPrices: updated.map((u) => ({
        id: u.id,
        price: u.price_points / 100,
      })),
    });
  } catch (err) {
    await conn.rollback();
    console.error("❌ Fout bij aankoop:", err);
    res.status(500).json({ error: "Update mislukt" });
  } finally {
    conn.release();
  }
});

app.post("/set-price/:id", isLoggedIn, async (req, res) => {
  const id = Number(req.params.id);
  const { price } = req.body;
  if (typeof price !== "number" || Number.isNaN(price)) {
    return res.status(400).json({ error: "Ongeldige prijs" });
  }

  try {
    const price_points = Math.round(price * 100);
    await db.query("UPDATE drinks SET price=?, price_points=? WHERE id=?", [
      price,
      price_points,
      id,
    ]);
    res.json({ success: true, price });
  } catch {
    res.status(500).json({ error: "Failed to set price" });
  }
});

app.get("/market", async (_req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM market_status WHERE id=1");
    res.json(rows[0] || {});
  } catch {
    res.status(500).json({ error: "Database query failed" });
  }
});

app.post("/market/crash/:state", isLoggedIn, async (req, res) => {
  const state = req.params.state === "true" ? 1 : 0;
  try {
    await db.query("UPDATE market_status SET crash=? WHERE id=1", [state]);
    res.json({ crash: !!state });
  } catch {
    res.status(500).json({ error: "Failed to update market" });
  }
});

app.get("/health", (_req, res) => res.status(200).send("ok"));

/* ---------------- SPA FALLBACK ---------------- */
app.get(
  /^\/(?!simulate-buy|set-price|drinks|market|login|logout|config|health).*$/,
  (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  }
);

/* ---------------- START SERVER ---------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});

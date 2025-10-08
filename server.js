const express = require("express");
const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");
const session = require("express-session");

/* ---------------- PRICE ENGINE CONFIG ---------------- */
const SALES_WINDOW_MIN = 0.5;       // 30-second lookback
const TICK_MS = 30_000;              // update every 30s
const TICK_LEAD_MS = 1_000;          // run ~1s before boundary so frontend sees fresh data

// ---------- Helpers for schema execution ----------
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function stripCreateDbAndUse(sql) {
  return sql
    .replace(/^\s*CREATE\s+DATABASE\b[^;]*;/gim, "")
    .replace(/^\s*USE\b[^;]*;/gim, "");
}
function normalizeSqlForProgrammaticExecution(sql) {
  let currentDelimiter = ";";
  const lines = sql.split(/\r?\n/);
  const out = [];
  for (let line of lines) {
    const m = line.match(/^\s*DELIMITER\s+(.+)\s*$/i);
    if (m) { currentDelimiter = m[1].trim(); continue; }
    if (currentDelimiter !== ";") {
      const endRe = new RegExp(`${escapeRegExp(currentDelimiter)}\\s*$`);
      out.push(endRe.test(line.trim()) ? line.replace(endRe, ";") : line);
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

// ---------- Aligned interval ticker ----------
function startAlignedTicker(stepMs, fn, leadMs = 0) {
  let running = false;
  const scheduleNext = () => {
    const now = Date.now();
    const nextBoundary = Math.ceil(now / stepMs) * stepMs;
    const firstDelay = Math.max(0, nextBoundary - leadMs - now);
    setTimeout(async function tick() {
      if (!running) {
        running = true;
        try { await fn(); } catch (e) { console.error("❌ Price tick failed:", e); }
        finally { running = false; }
      }
      setTimeout(tick, stepMs - leadMs);
    }, firstDelay);
  };
  scheduleNext();
}

const app = express();

/* ---------------- ENV CHECKS ---------------- */
if (!process.env.MYSQL_URL) {
  console.error("❌ Missing MYSQL_URL env var");
  process.exit(1);
}

/* ---------------- MIDDLEWARE ---------------- */
app.use(express.json());
app.set("trust proxy", 1);

/* ---------------- MYSQL CONNECTION ---------------- */
const { URL } = require("url");
const u = new URL(process.env.MYSQL_URL);

let db; // pool (set after init)

(async () => {
  try {
    console.log("🔌 Attempting to connect to MySQL...");

    const rawConn = await mysql.createConnection({
      host: u.hostname,
      port: u.port ? Number(u.port) : 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      multipleStatements: true,
    });
    console.log("✅ MySQL connection established successfully");

    if (process.env.CONSTRUCT_DATABASE === "true") {
      const dbName = u.pathname.replace(/^\//, "") || "railway";
      console.log("⚙️ CONSTRUCT_DATABASE=true — starting schema setup...");
      try {
        await rawConn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\`; USE \`${dbName}\`;`);
        const sqlPath = path.join(__dirname, "SQL Script Wall Street Ding.sql");
        let schemaSQL = fs.readFileSync(sqlPath, "utf8");
        schemaSQL = normalizeSqlForProgrammaticExecution(schemaSQL);
        schemaSQL = stripCreateDbAndUse(schemaSQL);
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

    // ---------- Start price engine (after pool is ready) ----------
    startAlignedTicker(TICK_MS, recomputeAllPrices, TICK_LEAD_MS);

  } catch (connErr) {
    console.error("❌ Failed to connect to MySQL at startup:");
    console.error("   ↳ Host:", u.hostname);
    console.error("   ↳ Port:", u.port || 3306);
    console.error("   ↳ Error:", connErr.message);
    console.error("📄 Tip: Check MYSQL_URL in Railway and ensure the DB is running.");
    process.exit(1);
  }
})();

/* ---------------- SESSIONS (MySQL-backed) ---------------- */
const MySQLStore = require("express-mysql-session")(session);
const sessionStore = new MySQLStore({
  host: u.hostname,
  port: u.port ? Number(u.port) : 3306,
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  database: u.pathname.replace(/^\//, ""),
});
app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || "dev-only-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === "production", httpOnly: true, sameSite: "lax" },
}));

/* ---------------- FRONTEND ---------------- */
app.use(express.static(path.join(__dirname, "public")));

/* ---------------- CONFIG ENDPOINT (frontend timer alignment) ---------------- */
app.get("/config", (_req, res) => {
  const now = Date.now();
  const nextTick = Math.ceil(now / TICK_MS) * TICK_MS;
  res.json({ interval: TICK_MS, sales_window_min: SALES_WINDOW_MIN, next_tick: nextTick });
});

/* ---------------- AUTH ---------------- */
function isLoggedIn(req, res, next) {
  if (!req.session.loggedIn) return res.status(401).json({ error: "Niet ingelogd" });
  next();
}
app.post("/login", async (req, res) => {
  const { password } = req.body;
  try {
    const [rows] = await db.query(
      "SELECT 1 FROM access_passwords WHERE password = ? LIMIT 1",
      [password]
    );
    if (rows.length === 0) return res.status(401).json({ error: "Ongeldig wachtwoord" });
    req.session.loggedIn = true;
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "DB error" });
  }
});
app.post("/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: "Logout failed" });
    res.json({ success: true });
  });
});

/* ---------------- PUBLIC DATA ---------------- */
app.get("/drinks", async (_req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM drinks");
    res.json(rows);
  } catch {
    res.status(500).json({ error: "Database query failed" });
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

/* ---------------- ADMIN / MUTATION ---------------- */
app.post("/market/crash/:state", isLoggedIn, async (req, res) => {
  const state = req.params.state === "true" ? 1 : 0;
  try {
    await db.query("UPDATE market_status SET crash=? WHERE id=1", [state]);
    res.json({ crash: !!state });
  } catch {
    res.status(500).json({ error: "Failed to update market" });
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
    await db.query("UPDATE drinks SET price=?, price_points=? WHERE id=?", [price, price_points, id]);
    res.json({ success: true, price });
  } catch {
    res.status(500).json({ error: "Failed to set price" });
  }
});
app.post("/lock-drink/:id", isLoggedIn, async (req, res) => {
  const id = Number(req.params.id);
  const { locked } = req.body;
  if (typeof locked !== "boolean") {
    return res.status(400).json({ error: "Invalid locked value, must be boolean" });
  }
  try {
    const [[drink]] = await db.query("SELECT id, name FROM drinks WHERE id=? LIMIT 1", [id]);
    if (!drink) return res.status(404).json({ error: "Drink not found" });

    await db.query("UPDATE drinks SET locked=?, lock_ts=NOW() WHERE id=?", [locked, id]);
    res.json({ success: true, drink_id: id, locked, timestamp: new Date() });
  } catch (err) {
    console.error("❌ Failed to lock/unlock drink:", err);
    res.status(500).json({ error: "Failed to update drink lock status" });
  }
});

/* ---------------- SALES LOGGING (for share_real) ---------------- */
app.post("/sales", isLoggedIn, async (req, res) => {
  try {
    const { drink_id, qty } = req.body || {};
    const idNum = Number(drink_id);
    const qtyNum = Number(qty ?? 1);
    if (!Number.isInteger(idNum) || idNum <= 0) return res.status(400).json({ error: "Invalid drink_id" });
    if (!Number.isInteger(qtyNum) || qtyNum <= 0) return res.status(400).json({ error: "Invalid qty" });

    const [[exists]] = await db.query("SELECT id FROM drinks WHERE id=? LIMIT 1", [idNum]);
    if (!exists) return res.status(404).json({ error: "Drink not found" });

    await db.query("INSERT INTO sales (drink_id, qty, ts) VALUES (?, ?, NOW())", [idNum, qtyNum]);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Failed to log sale:", err);
    res.status(500).json({ error: "Failed to log sale" });
  }
});

/* ---------------- HEALTH ---------------- */
app.get("/health", (_req, res) => res.status(200).send("ok"));

/* ---------------- SPA FALLBACK ---------------- */
app.get(/^\/(?!sales|set-price|drinks|market|login|logout|config|health).*$/, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ---------------- PRICE TICK IMPLEMENTATION ---------------- */
async function recomputeAllPrices() {
  // 1) Unlocked drinks with params
  const [drinks] = await db.query(`
    SELECT id, price, min_price, max_price,
           expected_popularity, gamma, delta_max, locked, lock_ts
    FROM drinks
    WHERE locked = 0
  `);
  if (!drinks.length) return;

  // 2) Get all drinks for calculating total sales (including locked ones)
  const [allDrinks] = await db.query(`
    SELECT id, locked, lock_ts
    FROM drinks
  `);

  const windowStart = new Date(Date.now() - SALES_WINDOW_MIN * 60 * 1000);

  // 3) Calculate total sales counting only when drinks were unlocked
  let totalSales = 0;
  const salesByDrink = new Map();

  for (const drink of allDrinks) {
    const drinkId = Number(drink.id);
    
    // Get all sales for this drink in the window
    const [salesRows] = await db.query(`
      SELECT qty, ts 
      FROM sales 
      WHERE drink_id = ? AND ts >= ?
      ORDER BY ts ASC
    `, [drinkId, windowStart]);

    let drinkSales = 0;

    for (const sale of salesRows) {
      const saleTime = new Date(sale.ts);
      
      // Check if drink was unlocked at the time of sale
      let wasUnlocked = !drink.locked; // Current state
      
      if (drink.lock_ts) {
        const lockTime = new Date(drink.lock_ts);
        
        // If lock timestamp is within our window, we need to check the state at sale time
        if (lockTime >= windowStart && lockTime <= new Date()) {
          if (saleTime < lockTime) {
            // Sale happened before the lock change, so use opposite of current state
            wasUnlocked = drink.locked; 
          } else {
            // Sale happened after the lock change, so use current state
            wasUnlocked = !drink.locked;
          }
        }
      }
      
      if (wasUnlocked) {
        drinkSales += Number(sale.qty);
      }
    }
    
    salesByDrink.set(drinkId, drinkSales);
    totalSales += drinkSales;
  }

  if (totalSales === 0) return; // no movement without data

  // 4) Normalize expected shares among unlocked drinks only
  const sumExp = drinks.reduce((s, d) => s + (Number(d.expected_popularity) || 0), 0) || 1;

  // 5) Compute updates per formula (raw step -> step cap ±Δmax -> clamp [min,max])
  const updates = [];
  for (const d of drinks) {
    const id = Number(d.id);
    const Pold = Number(d.price);
    const Pmin = Number(d.min_price);
    const Pmax = Number(d.max_price);
    const gamma = Number(d.gamma ?? 0.4);
    const dmax  = Number(d.delta_max ?? 0.10);

    const realShare = (salesByDrink.get(id) || 0) / totalSales;
    const expShare  = (Number(d.expected_popularity) || 0) / sumExp;

    let P = Pold * (1 + gamma * (realShare - expShare));

    const upCap = Pold * (1 + dmax);
    const dnCap = Pold * (1 - dmax);
    if (P > upCap) P = upCap;
    if (P < dnCap) P = dnCap;

    if (P < Pmin) P = Pmin;
    if (P > Pmax) P = Pmax;

    const rounded = Math.round(P * 100) / 100;
    const points  = Math.round(rounded * 100);
    if (rounded !== Pold) updates.push({ id, price: rounded, points });
  }
  if (!updates.length) return;

  const ids = updates.map(u => u.id);
  const casePrice = updates.map(u => `WHEN ${u.id} THEN ${u.price}`).join(' ');
  const casePts   = updates.map(u => `WHEN ${u.id} THEN ${u.points}`).join(' ');
  await db.query(`
    UPDATE drinks
    SET
      price        = CASE id ${casePrice} END,
      price_points = CASE id ${casePts}   END
    WHERE id IN (${ids.join(',')})
  `);
}

/* ---------------- START SERVER ---------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});

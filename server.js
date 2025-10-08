const express = require("express");
const mysql = require("mysql2/promise");
const session = require("express-session");
const path = require("path");

const app = express();

// console.log({
//   host: process.env.MYSQLHOST,
//   user: process.env.MYSQLUSER,
//   password: process.env.MYSQLPASSWORD,
//   database: process.env.MYSQLDATABASE,
// });







app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "fallbackSecret",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, httpOnly: true, sameSite: "lax" },
  })
);

app.use(express.static(path.join(__dirname, "public")));

let db;
(async () => {
  try {
    const mysql = require('mysql2/promise');
    db = await mysql.createPool({
      host: process.env.MYSQLHOST,
      user: process.env.MYSQLUSER,
      password: process.env.MYSQLPASSWORD,
      database: process.env.MYSQLDATABASE,
      port: Number(process.env.MYSQLPORT) || 3306,
      waitForConnections: true,
      connectionLimit: 10,
      decimalNumbers: true,
    });

    console.log("✅ Connected to MySQL Database");

    const PORT = process.env.PORT || 3306;
    app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
  } catch (err) {
    console.error("❌ MySQL connection failed:", err);
    process.exit(1);
  }
})();


// ---------------- CONFIG ----------------
const STIJGING = 5;

// ---------------- HELPERS ----------------
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

// ---------------- AUTH ----------------
function isLoggedIn(req, res, next) {
  if (!req.session.loggedIn)
    return res.status(401).json({ error: "Niet ingelogd" });
  next();
}

// ---------------- API ----------------
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
// DDSLNQLFNOEON


app.get("/config", (req, res) => {
  res.json({ interval: 10000 });
});

app.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: "Logout failed" });
    res.json({ success: true });
  });
});

app.get("/drinks", isLoggedIn, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM drinks");
    res.json(rows);
  } catch {
    res.status(500).json({ error: "Database query failed" });
  }
});

// Helper: gets sales in the interval per drink
async function getRecentSalesData(intervalMins = 10) {
  const since = new Date(Date.now() - intervalMins * 60 * 1000);
  // You'll need a "sales" table for this
  const [rows] = await db.query(`
    SELECT drink_id, SUM(qty) as sold
    FROM sales
    WHERE timestamp >= ?
    GROUP BY drink_id
  `, [since]);
  
  // Build a map: { drink_id: qty_sold }
  const drinkSales = {};
  let totalSold = 0;
  for (const r of rows) {
    drinkSales[r.drink_id] = r.sold;
    totalSold += r.sold;
  }
  return { drinkSales, totalSold };
}

async function updatePricesInterval() {
  const { drinkSales, totalSold } = await getRecentSalesData(10);

  const [drinks] = await db.query('SELECT * FROM drinks WHERE locked = 0');

  for (const drink of drinks) {
    const realShare = (totalSold === 0) ? 0 : (drinkSales[drink.id] || 0) / totalSold;
    const expectedShare = drink.expected_popularity;
    const gamma = drink.gamma;
    const deltaMax = drink.delta_max;
    const Pold = Number(drink.price);
    const Pmin = Number(drink.min_price);
    const Pmax = Number(drink.max_price);
    
    // Compute all candidates
    const up = Pold * (1 + Number(deltaMax));
    const down = Pold * (1 - Number(deltaMax));
    const gammaMod = Pold * (1 + Number(gamma) * (realShare - expectedShare));
    let candidates = [
      gammaMod,
      up,
      down
    ];
    // Clamp them to model
    let newPrice = Math.min(Pmax, Math.max(Pmin, Math.min(...candidates, Math.max(up, gammaMod))));
    newPrice = Math.max(Pmin, Math.min(newPrice, Pmax));
    // Final update
    await db.query('UPDATE drinks SET price=?, price_points=? WHERE id=?', [
      newPrice, Math.round(newPrice * 100), drink.id
    ]);
  }
}

// Run every 60s
setInterval(updatePricesInterval, 30000);


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

app.get("/market", async (req, res) => {
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

// ---------------- SPA FALLBACK ----------------
// app.get(
//   /^\/(?!simulate-buy|set-price|drinks|market|login|logout|config).*$/,
//   (req, res) => {
//     res.sendFile(path.join(__dirname, "public", "index.html"));
//   }
// );

// ---------------- SERVER START ----------------
// const PORT = process.env.PORT || 3000;
//app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

console.log("__dirname:", __dirname);
console.log("Frontend path:", path.join(__dirname, "..", "public"));

// const fs = require('fs');
// const path = require('path');

app.get("/debug-files", (req, res) => {
  fs.readdir("/app", (err, files) => {
    if (err) return res.status(500).send(err.message);
    res.send(`Files in /app: ${files.join(", ")}`);
  });
});

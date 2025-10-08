document.addEventListener("DOMContentLoaded", () => {
  /* ================== CONFIG ================== */
  const API_URL = ""; // e.g. "/api" or "" for relative
  const INTERVAL = 600_000;
  const FETCH_INTERVAL = 10_000; // ms
  const CHART_POLL_INTERVAL = 2_000; // ms
  const CYCLE_INTERVAL = 8_000; // ms
  const PRICE_HISTORY_WINDOW_MS = 3 * 60 * 60 * 1000;
  const PRICE_HISTORY_POINT_LIMIT = 1500;
  const FETCH_TIMEOUT_MS = 1_000;
  const CRASH_START = "01:30";
  const CRASH_DURATION_MIN = 15;
  const COLORS = [
    "#e6194b",
    "#3cb44b",
    "#0082c8",
    "#f58231",
    "#911eb4",
    "#46f0f0",
    "#f032e6",
    "#fabebe",
    "#008080",
  ];

  /* ================== STATE ================== */
  let drinksData = [];
  const priceHistory = new Map();
  const drinkColors = new Map();
  let chartInstance = null;
  let currentDrinkIndex = 0;
  let nextFetchTime = 0;
  let nextChartTime = 0;
  let nextCycleTime = 0;

  /* ================== DOM CACHE ================== */
  const table = document.getElementById("cycle-drink-table");
  const tickerEl = document.getElementById("ticker-content");
  const timerEl = document.getElementById("refresh-timer");
  const chartCanvas = document.getElementById("all-drinks-chart");
  const chartTitleEl = document.getElementById("chart-drink-title"); // <h2> boven grafiek
  const ctx = chartCanvas?.getContext("2d");

  /* ================== UTILS ================== */
  const now = Date.now;
  const getColor = (i) => COLORS[i % COLORS.length];
  const safeNumber = (v, fallback = 0) => (isFinite(+v) ? +v : fallback);
  const formatPrice = (p) => p.toFixed(2);
  const escapeHtml = (str) =>
    String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const priceArrow = (price, base) =>
    price > base ? "▲" : price < base ? "▼" : "–";

  const pushPricePoint = (name, timestamp, price) => {
    const arr = priceHistory.get(name) || [];
    arr.push({ x: timestamp, y: price });

    const minTime = timestamp - PRICE_HISTORY_WINDOW_MS;
    while (arr.length && arr[0].x < minTime) arr.shift();
    if (arr.length > PRICE_HISTORY_POINT_LIMIT)
      arr.splice(0, arr.length - PRICE_HISTORY_POINT_LIMIT);

    priceHistory.set(name, arr);
  };

  /**
   * Bereken de volgende synchronisatietijd voor een interval
   */
  function getNextSyncTime(interval) {
    const now = Date.now();
    return Math.ceil(now / interval) * interval;
  }

  /**
   * Start een interval gesynchroniseerd met echte tijd
   */
  function startRealTimeInterval(callback, interval) {
    let stopped = false;
    let timeoutId = null;
    let intervalId = null;

    const executeAndSchedule = () => {
      if (stopped) return;
      
      // Volgende uitvoering op gesynchroniseerd tijdstip
      const nextTime = getNextSyncTime(interval);
      const delay = Math.max(0, nextTime - Date.now());
      
      timeoutId = setTimeout(() => {
        if (stopped) return;
        callback();
        intervalId = setInterval(callback, interval);
      }, delay);
    };

    executeAndSchedule();

    return {
      stop: () => {
        stopped = true;
        if (timeoutId !== null) clearTimeout(timeoutId);
        if (intervalId !== null) clearInterval(intervalId);
      }
    };
  }

  /* ================== UI: TABLE ================== */
  function updateTable(drinks) {
    if (!table) return;
    let tbody =
      table.querySelector("tbody") ||
      table.appendChild(document.createElement("tbody"));
    const frag = document.createDocumentFragment();

    for (const d of drinks) {
      const price = safeNumber(d.price);
      const base = safeNumber(d.base_price, price);
      pushPricePoint(d.name, now(), price);

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(d.name)}</td>
        <td class="price-cell">${formatPrice(price)}</td>
        <td>${priceArrow(price, base)}</td>
      `;
      frag.appendChild(tr);
    }

    // Then add the "Plat water" row at the end
    const platWaterRow = document.createElement("tr");
    platWaterRow.innerHTML = `
    <td class="name-cell">Plat water</td>
    <td class="price-cell">1.30</td>
    <td class="placeholder-cell">–</td>
  `;
    frag.appendChild(platWaterRow);
    tbody.replaceChildren(frag);
  }

  /* ================== UI: TICKER ================== */
  const updateTicker = (drinks) => {
    if (tickerEl)
      tickerEl.textContent = drinks
        .map((d) => `${d.name}: €${formatPrice(safeNumber(d.price))}`)
        .join(" | ");
  };

  /* ================== UI: CHART ================== */
  function initChart() {
    if (!ctx || chartInstance) return;
    chartInstance = new Chart(ctx, {
      type: "line",
      data: { labels: [], datasets: [] },
      options: {
        responsive: true,
        lineTension: 0,
        maintainAspectRatio: false,
        animation: { duration: 500 },
        plugins: { legend: { display: false } },
        scales: {
          x: {
            type: "time",
            time: { unit: "minute", tooltipFormat: "HH:mm:ss" },
            ticks: { color: "#fff" },
            grid: { color: "#333" },
          },
          y: {
            position: "right",
            ticks: { color: "#fff", font: { size: 16 } },
            grid: { color: "#333" },
          },
        },
      },
    });
  }

  const buildDatasetForDrink = (d) => ({
    label: d.name,
    data: priceHistory.get(d.name) || [],
    borderColor: drinkColors.get(d.name) || getColor(0),
    borderWidth: 3,
    pointRadius: 0,
    tension: 0.2,
    backgroundColor: "transparent",
  });

  function updateChart() {
    if (!chartInstance || !drinksData.length) return;
    const drink = drinksData[currentDrinkIndex % drinksData.length];
    if (!drink) return;

    const dataset = buildDatasetForDrink(drink);

    const history = priceHistory.get(drink.name) || [];
    let baseLineDataset = null;

    if (history.length >= 2) {
      const firstX = history[0].x;
      const lastX = history[history.length - 1].x;

      baseLineDataset = {
        label: `${drink.name} basisprijs`,
        data: [
          { x: firstX, y: drink.base_price },
          { x: lastX, y: drink.base_price },
        ],
        borderColor: "#fff",
        borderWidth: 2,
        borderDash: [6, 6],
        pointRadius: 0,
        fill: false,
      };
    }

    // datasets vullen
    chartInstance.data.datasets = baseLineDataset
      ? [dataset, baseLineDataset]
      : [dataset];

    // Dynamische y-as limieten instellen
    chartInstance.options.scales.y.min = Number(drink.min_price);
    chartInstance.options.scales.y.max = Number(drink.max_price);

    chartInstance.update("none");

    // titel boven grafiek
    if (chartTitleEl) {
      chartTitleEl.textContent = `${drink.name}`;
      chartTitleEl.style.color = drinkColors.get(drink.name) || "#fff";
    }
  }

  function cycleDrink() {
    if (!drinksData.length) return;
    currentDrinkIndex = (currentDrinkIndex + 1) % drinksData.length;
    updateChart();
  }

  /* ================== REFRESH TIMER ================== */
  function updateRefreshTimer() {
    if (!timerEl) return;
    
    const now = Date.now();
    const remaining = Math.max(0, nextFetchTime - now);
    const seconds = Math.floor(remaining / 1000);
    const sec = (seconds % 60).toString().padStart(2, "0");
    const min = Math.floor(seconds / 60).toString().padStart(2, "0");
    
    timerEl.textContent = `${min}:${sec}`;
    
    requestAnimationFrame(updateRefreshTimer);
  }

  /* ================== FETCH ================== */
  async function fetchWithTimeout(
    url,
    options = {},
    timeout = FETCH_TIMEOUT_MS
  ) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const resp = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(id);
      return resp;
    } finally {
      clearTimeout(id);
    }
  }

  async function fetchData() {
    try {
      const endpoint = `${API_URL.replace(/\/$/, "")}/drinks`;
      const res = await fetchWithTimeout(endpoint, { credentials: "include" });
      if (
        !res.ok ||
        !res.headers.get("content-type")?.includes("application/json")
      )
        return;

      const data = await res.json();
      if (!Array.isArray(data)) return;

      drinksData = data.map((d) => ({
        name: d.name ?? "unknown",
        price: safeNumber(d.price),
        base_price: safeNumber(d.base_price, d.price),
        min_price: safeNumber(d.min_price, d.price),
        max_price: safeNumber(d.max_price, d.price),
        color: d.color,
        raw: d,
      }));

      drinksData.forEach((d, i) =>
        drinkColors.set(d.name, d.color || getColor(i))
      );

      if (ctx) initChart();
      updateTable(drinksData);
      updateTicker(drinksData);
      updateChart();
    } catch (err) {
      if (err.name !== "AbortError") console.error("Fetch failed:", err);
    }
  }

  /* ================== CRASH MODE ================== */
  function isCrashActive() {
    const [h, m] = CRASH_START.split(":").map(Number);
    const start = new Date();
    start.setHours(h, m, 0, 0);
    const end = new Date(start.getTime() + CRASH_DURATION_MIN * 60 * 1000);
    return (
      (new Date() >= start && new Date() <= end) || window.CRASH_MODE === true
    );
  }

  function updateCrashBanner() {
    const banner = document.getElementById("crash-banner");
    if (banner) banner.style.display = isCrashActive() ? "flex" : "none";
  }

  /* ================== INIT ================== */
  function init() {
    // Bereken volgende synchronisatietijden
    nextFetchTime = getNextSyncTime(INTERVAL);
    nextChartTime = getNextSyncTime(INTERVAL);
    nextCycleTime = getNextSyncTime(CYCLE_INTERVAL);
    
    // Start de refresh timer
    updateRefreshTimer();
    
    // Start alle intervals gesynchroniseerd met echte tijd
    const fetchInterval = startRealTimeInterval(() => {
      fetchData();
      nextFetchTime = getNextSyncTime(INTERVAL);
    }, INTERVAL);

    const chartPollInterval = startRealTimeInterval(() => {
      updateChart();
      nextChartTime = getNextSyncTime(INTERVAL);
    }, INTERVAL);

    const cycleInterval = startRealTimeInterval(() => {
      cycleDrink();
      nextCycleTime = getNextSyncTime(CYCLE_INTERVAL);
    }, CYCLE_INTERVAL);

    const crashBannerInterval = startRealTimeInterval(updateCrashBanner, 1000);
    
    // Eerste fetch direct uitvoeren
    fetchData();
    
    // Bewaar interval references voor cleanup
    window.__dashboardIntervals = {
      fetch: fetchInterval,
      chart: chartPollInterval,
      cycle: cycleInterval,
      crash: crashBannerInterval
    };
  }

  init();

  /* ================== CLEANUP ================== */
  window.addEventListener("beforeunload", () => {
    if (window.__dashboardIntervals) {
      Object.values(window.__dashboardIntervals).forEach(interval => interval.stop());
    }
    chartInstance?.destroy?.();
    chartInstance = null;
  });

  /* ================== DEBUG HOOKS ================== */
  window.__drinksDashboard = {
    fetchNow: fetchData,
    getDrinks: () => drinksData,
    getPriceHistory: () => Object.fromEntries(priceHistory),
    getNextFetchTime: () => new Date(nextFetchTime),
    getNextChartTime: () => new Date(nextChartTime),
    getNextCycleTime: () => new Date(nextCycleTime),
    getIntervals: () => window.__dashboardIntervals
  };
});
/***********************
 * CONFIG (edit ONLY this section)
 ***********************/
const CONFIG = {
  seasonLabel: "2026",
  buyInUSD: 30,

  // Payment + forms (put your real links here)
  venmoUrl: "https://venmo.com/u/YOURNAME",
  cashAppUrl: "https://cash.app/$YOURCASHTAG",

  // Recommended: Google Form for signup
  signupFormUrl: "https://forms.gle/YOURFORM",
  // Optional: Google Form EMBED URL (from “Send” → <> embed). If blank, no embed shown.
  signupEmbedUrl: "",

  // Optional: Google Form for weekly pick submissions
  weeklyPickFormUrl: "",

  // Paste your published-to-web CSV links here (Google Sheets)
  // File → Share → Publish to web → choose the sheet tab → CSV → Publish → copy link
  csv: {
    teams: "PASTE_TEAMS_CSV_URL_HERE",
    picks: "PASTE_PICKS_CSV_URL_HERE",
    racePoints: "PASTE_RACEPOINTS_CSV_URL_HERE",
  },

  // Pool structure (adjust to your actual split)
  halves: {
    "1H": { minRace: 1, maxRace: 13 },
    "2H": { minRace: 14, maxRace: 26 }
  },

  // If true, duplicates in same half are forced to 0 points automatically.
  autoZeroDuplicates: true
};

/***********************
 * Utilities
 ***********************/
async function fetchText(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load: ${url}`);
  return await res.text();
}

function parseCSV(csv) {
  // Minimal CSV parser (handles quoted commas)
  const rows = [];
  let cur = "", inQ = false, row = [];
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i], next = csv[i + 1];
    if (ch === '"' && next === '"') { cur += '"'; i++; continue; }
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ',' && !inQ) { row.push(cur); cur = ""; continue; }
    if ((ch === '\n' || ch === '\r') && !inQ) {
      if (cur.length || row.length) { row.push(cur); rows.push(row); }
      cur = ""; row = [];
      continue;
    }
    cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }

  const headers = rows.shift().map(h => (h || "").trim());
  return rows
    .filter(r => r.some(x => (x || "").trim() !== ""))
    .map(r => Object.fromEntries(headers.map((h, idx) => [h, (r[idx] ?? "").trim()])));
}

function num(x, d = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}

function halfForRace(raceNo) {
  for (const [half, rg] of Object.entries(CONFIG.halves)) {
    if (raceNo >= rg.minRace && raceNo <= rg.maxRace) return half;
  }
  return "—";
}

/***********************
 * Routing / Views
 ***********************/
function setActiveView(view) {
  document.querySelectorAll(".nav-link").forEach(a => {
    a.classList.toggle("active", a.dataset.view === view);
  });
  ["standings", "weekly", "teams"].forEach(v => {
    document.getElementById(`view-${v}`).classList.toggle("d-none", v !== view);
  });
}

function routeFromHash() {
  const h = (location.hash || "").replace("#", "").trim();

  if (!h || h === "standings") { setActiveView("standings"); return; }
  if (h === "weekly") { setActiveView("weekly"); return; }
  if (h === "teams") { setActiveView("teams"); return; }

  if (h.startsWith("team=")) {
    const teamId = h.split("team=")[1];
    setActiveView("teams");
    const sel = document.getElementById("team-select");
    if (sel && teamId) sel.value = teamId;
    renderTeam();
    return;
  }

  setActiveView("standings");
}

/***********************
 * Data model build
 ***********************/
function buildModel(teamsRows, picksRows, racePointsRows) {
  const teams = teamsRows.map(t => ({
    team_id: t.team_id,
    team_name: t.team_name,
    contact: t.contact || "",
    paid: String(t.paid || "").toUpperCase() === "TRUE",
  }));

  const teamById = new Map(teams.map(t => [t.team_id, t]));
  const racesSet = new Set();

  // race points lookup: (race_no, car_no) -> points + finish
  const rp = new Map();
  for (const r of racePointsRows) {
    const race_no = num(r.race_no);
    const car_no = num(r.car_no);
    racesSet.add(race_no);
    const finish_pos = num(r.finish_pos, 999);

    rp.set(`${race_no}:${car_no}`, {
      points: num(r.points, 0),
      finish_pos,
      win: String(r.win || "").toUpperCase() === "TRUE" || finish_pos === 1,
      top5: String(r.top5 || "").toUpperCase() === "TRUE" || finish_pos <= 5,
    });
  }

  // picks normalized
  const picks = picksRows.map(p => {
    const race_no = num(p.race_no);
    racesSet.add(race_no);
    const half = (p.half && p.half.trim()) ? p.half.trim() : halfForRace(race_no);
    const team = teamById.get(p.team_id);
    return {
      race_no,
      half,
      team_id: p.team_id,
      team_name: team ? team.team_name : p.team_id,
      car_no: p.car_no ? num(p.car_no, null) : null
    };
  });

  const races = Array.from(racesSet).sort((a, b) => a - b);
  const lastRace = races.length ? races[races.length - 1] : null;

  // compute per team per race scoring + flags
  const perTeamRace = [];
  const usedByHalf = new Map(); // team_id -> { "1H": Set(), "2H": Set() }

  for (const t of teams) {
    usedByHalf.set(t.team_id, { "1H": new Set(), "2H": new Set() });
  }

  // Index picks by team+r
  const pickByTR = new Map();
  for (const p of picks) {
    pickByTR.set(`${p.team_id}:${p.race_no}`, p);
  }

  for (const race_no of races) {
    for (const t of teams) {
      const p = pickByTR.get(`${t.team_id}:${race_no}`) || {
        race_no,
        half: halfForRace(race_no),
        team_id: t.team_id,
        team_name: t.team_name,
        car_no: null
      };

      const flags = [];
      let points = 0;
      let win = false, top5 = false;
      let finish_pos = 999;

      if (p.car_no == null) {
        flags.push({ type: "miss", label: "No pick → 0" });
      } else {
        const used = usedByHalf.get(t.team_id)[p.half] || new Set();
        const rr = rp.get(`${race_no}:${p.car_no}`) || null;

        if (used.has(p.car_no)) {
          flags.push({ type: "dup", label: "Duplicate in half" });
          if (!CONFIG.autoZeroDuplicates && rr) {
            points = rr.points;
            win = rr.win;
            top5 = rr.top5;
            finish_pos = rr.finish_pos;
          } else {
            points = 0;
          }
        } else {
          used.add(p.car_no);
          if (rr) {
            points = rr.points;
            win = rr.win;
            top5 = rr.top5;
            finish_pos = rr.finish_pos;
          } else {
            points = 0;
          }
        }
      }

      perTeamRace.push({
        race_no,
        half: p.half,
        team_id: t.team_id,
        team_name: t.team_name,
        car_no: p.car_no,
        points,
        win,
        top5,
        finish_pos,
        flags
      });
    }
  }

  // totals + tie-break stats
  const teamStats = new Map();
  for (const t of teams) {
    teamStats.set(t.team_id, {
      ...t,
      total_points: 0,
      wins_picked: 0,
      top5s_picked: 0,
      flags_dup: 0,
      flags_miss: 0,
      points_by_race: new Map()
    });
  }

  for (const r of perTeamRace) {
    const s = teamStats.get(r.team_id);
    s.total_points += r.points;
    if (r.win) s.wins_picked++;
    if (r.top5) s.top5s_picked++;
    if (r.flags.some(f => f.type === "dup")) s.flags_dup++;
    if (r.flags.some(f => f.type === "miss")) s.flags_miss++;
    s.points_by_race.set(r.race_no, r.points);
  }

  // rankings (highest points = 1st) + tie-breakers
  const ranked = Array.from(teamStats.values()).sort((a, b) => {
    if (b.total_points !== a.total_points) return b.total_points - a.total_points;
    if (b.wins_picked !== a.wins_picked) return b.wins_picked - a.wins_picked;
    return b.top5s_picked - a.top5s_picked;
  });

  const leaderPts = ranked.length ? ranked[0].total_points : 0;
  ranked.forEach((t, idx) => {
    t.rank = idx + 1;
    t.behind = leaderPts - t.total_points;
  });

  return { races, lastRace, perTeamRace, ranked, teamStats };
}

/***********************
 * UI rendering
 ***********************/
let MODEL = null;
let CHART_TOP5 = null;
let CHART_TEAM = null;

function paidBadge(isPaid) {
  return isPaid
    ? `<span class="badge badge-soft">Paid</span>`
    : `<span class="badge" style="background:rgba(255,107,107,.14);border:1px solid rgba(255,107,107,.25);color:#ffd2d2;">Unpaid</span>`;
}

function renderStandings() {
  const tbody = document.querySelector("#standings-table tbody");
  tbody.innerHTML = "";

  const q = (document.getElementById("standings-search").value || "").toLowerCase().trim();
  const rows = MODEL.ranked.filter(t => !q || t.team_name.toLowerCase().includes(q));

  for (const t of rows) {
    const flags = [];
    if (t.flags_dup) flags.push(`<span class="flag flag-dup">Dup×${t.flags_dup}</span>`);
    if (t.flags_miss) flags.push(`<span class="flag flag-miss">Miss×${t.flags_miss}</span>`);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${t.rank}</td>
      <td><a href="#team=${t.team_id}" class="linklike">${t.team_name}</a></td>
      <td>${t.total_points}</td>
      <td>${t.behind}</td>
      <td>${t.wins_picked}</td>
      <td>${t.top5s_picked}</td>
      <td>${paidBadge(t.paid)}</td>
      <td>${flags.join(" ") || `<span class="muted">—</span>`}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderWeekDropdown() {
  const sel = document.getElementById("week-select");
  sel.innerHTML = "";
  for (const r of MODEL.races) {
    const opt = document.createElement("option");
    opt.value = r;
    opt.textContent = `Race ${r}`;
    sel.appendChild(opt);
  }
  if (MODEL.lastRace != null) sel.value = MODEL.lastRace;
}

function computeMovers(raceNo) {
  const upto = (rn) => {
    const totals = Array.from(MODEL.teamStats.values()).map(t => {
      let sum = 0, wins = 0, top5 = 0;
      for (const r of MODEL.races) {
        if (r > rn) break;
        const row = MODEL.perTeamRace.find(x => x.team_id === t.team_id && x.race_no === r);
        if (row) { sum += row.points; if (row.win) wins++; if (row.top5) top5++; }
      }
      return { team_id: t.team_id, team_name: t.team_name, sum, wins, top5 };
    }).sort((a, b) => b.sum - a.sum || b.wins - a.wins || b.top5 - a.top5);

    const rank = new Map();
    totals.forEach((t, idx) => rank.set(t.team_id, idx + 1));
    return rank;
  };

  const rPrev = Math.max(1, raceNo - 1);
  const a = upto(rPrev);
  const b = upto(raceNo);

  let bestUp = { delta: -999, label: "—" };
  let worst = { delta: 999, label: "—" };

  for (const [teamId, rNow] of b.entries()) {
    const rPrevRank = a.get(teamId) || rNow;
    const delta = rPrevRank - rNow;
    const name = MODEL.teamStats.get(teamId).team_name;

    if (delta > bestUp.delta) bestUp = { delta, label: delta === 0 ? `${name} (no change)` : `${name} (↑${delta})` };
    if (delta < worst.delta) worst = { delta, label: delta === 0 ? `${name} (no change)` : `${name} (↓${Math.abs(delta)})` };
  }

  return { biggestUp: bestUp, hardLuck: worst };
}

function renderWeekly() {
  const raceNo = num(document.getElementById("week-select").value, MODEL.lastRace || 1);
  const half = halfForRace(raceNo);
  document.getElementById("week-pill").textContent = `Race ${raceNo} • ${half}`;

  const tbody = document.querySelector("#weekly-table tbody");
  tbody.innerHTML = "";

  const rows = MODEL.perTeamRace
    .filter(r => r.race_no === raceNo)
    .sort((a, b) => b.points - a.points || a.team_name.localeCompare(b.team_name));

  rows.forEach((r, idx) => {
    const flags = r.flags.map(f => {
      const cls = f.type === "dup" ? "flag-dup" : "flag-miss";
      return `<span class="flag ${cls}">${f.label}</span>`;
    }).join(" ");

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td><a class="linklike" href="#team=${r.team_id}">${r.team_name}</a></td>
      <td>${r.car_no == null ? `<span class="muted">—</span>` : `#${r.car_no}`}</td>
      <td>${r.finish_pos === 999 ? `<span class="muted">—</span>` : r.finish_pos}</td>
      <td>${r.points}</td>
      <td>${r.win ? "✅" : "—"}</td>
      <td>${r.top5 ? "✅" : "—"}</td>
      <td>${flags || `<span class="muted">—</span>`}</td>
    `;
    tbody.appendChild(tr);
  });

  const best = rows[0];
  const worst = rows[rows.length - 1];
  const dupCount = rows.filter(r => r.flags.some(f => f.type === "dup")).length;
  const missCount = rows.filter(r => r.flags.some(f => f.type === "miss")).length;

  document.getElementById("week-summary").innerHTML = `
    <div><span class="pill">Race ${raceNo}</span> <span class="pill">${half}</span></div>
    <div class="mt-2">🏆 High score: <b>${best.team_name}</b> (${best.points})</div>
    <div>😬 Low score: <b>${worst.team_name}</b> (${worst.points})</div>
    <div class="mt-2 muted">Flags this week: Duplicates ${dupCount} • Missing ${missCount}</div>
  `;

  const movers = computeMovers(raceNo);
  document.getElementById("week-callouts").innerHTML = `
    <div class="mb-2"><span class="badge badge-soft">Biggest mover</span> <b>${movers.biggestUp.label}</b></div>
    <div class="mb-2"><span class="badge badge-soft">Hard luck</span> <b>${movers.hardLuck.label}</b></div>
  `;
}

function renderTop5Chart() {
  const top5 = MODEL.ranked.slice(0, 5);
  const labels = MODEL.races.map(r => `R${r}`);

  const datasets = top5.map(t => {
    const data = [];
    let running = 0;
    for (const r of MODEL.races) {
      running += (t.points_by_race.get(r) || 0);
      data.push(running);
    }
    return { label: t.team_name, data };
  });

  const ctx = document.getElementById("chart-top5");
  if (CHART_TOP5) CHART_TOP5.destroy();
  CHART_TOP5 = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#e8ecf3" } } },
      scales: {
        x: { ticks: { color: "#e8ecf3" }, grid: { color: "rgba(255,255,255,.08)" } },
        y: { ticks: { color: "#e8ecf3" }, grid: { color: "rgba(255,255,255,.08)" } }
      }
    }
  });
}

function renderTeamDropdown() {
  const sel = document.getElementById("team-select");
  sel.innerHTML = "";

  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = "Select a team…";
  sel.appendChild(opt0);

  for (const t of MODEL.ranked) {
    const opt = document.createElement("option");
    opt.value = t.team_id;
    opt.textContent = `${t.rank}. ${t.team_name}`;
    sel.appendChild(opt);
  }
}

function renderTeam() {
  const teamId = document.getElementById("team-select").value;
  const meta = document.getElementById("team-meta");
  const copyBtn = document.getElementById("btn-copy-team-link");
  const payBtn = document.getElementById("btn-pay-team");

  if (!teamId) {
    meta.textContent = "—";
    copyBtn.classList.add("d-none");
    payBtn.classList.add("d-none");
    document.querySelector("#team-picks-table tbody").innerHTML = "";
    return;
  }

  const t = MODEL.teamStats.get(teamId);
  const rankedRow = MODEL.ranked.find(x => x.team_id === teamId);
  const teamUrl = `${location.origin}${location.pathname}#team=${teamId}`;

  meta.innerHTML = `
    <div><b>${t.team_name}</b></div>
    <div class="muted">Rank #${rankedRow.rank} • Total ${t.total_points} • Behind ${rankedRow.behind}</div>
    <div class="muted">Wins picked ${t.wins_picked} • Top-5s ${t.top5s_picked}</div>
    <div class="mt-2">${paidBadge(t.paid)}</div>
    <div class="muted mt-2">Team link: <a class="linklike" href="#team=${teamId}">#team=${teamId}</a></div>
  `;

  copyBtn.classList.remove("d-none");
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(teamUrl);
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy Team Link"), 1200);
    } catch {
      alert("Could not copy automatically. You can copy the URL from your browser address bar.");
    }
  };

  payBtn.classList.remove("d-none");
  payBtn.href = CONFIG.venmoUrl || "#";
  payBtn.textContent = "Pay (Venmo)";
  if (!CONFIG.venmoUrl) payBtn.classList.add("d-none");

  // chart
  const labels = MODEL.races.map(r => `R${r}`);
  let running = 0;
  const data = MODEL.races.map(r => (running += (t.points_by_race.get(r) || 0)));

  const ctx = document.getElementById("chart-team");
  if (CHART_TEAM) CHART_TEAM.destroy();
  CHART_TEAM = new Chart(ctx, {
    type: "line",
    data: { labels, datasets: [{ label: t.team_name, data }] },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#e8ecf3" } } },
      scales: {
        x: { ticks: { color: "#e8ecf3" }, grid: { color: "rgba(255,255,255,.08)" } },
        y: { ticks: { color: "#e8ecf3" }, grid: { color: "rgba(255,255,255,.08)" } }
      }
    }
  });

  // picks history
  const tbody = document.querySelector("#team-picks-table tbody");
  tbody.innerHTML = "";

  const rows = MODEL.perTeamRace
    .filter(r => r.team_id === teamId)
    .sort((a, b) => a.race_no - b.race_no);

  for (const r of rows) {
    const flags = r.flags.map(f => {
      const cls = f.type === "dup" ? "flag-dup" : "flag-miss";
      return `<span class="flag ${cls}">${f.label}</span>`;
    }).join(" ");

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.race_no}</td>
      <td>${r.half}</td>
      <td>${r.car_no == null ? `<span class="muted">—</span>` : `#${r.car_no}`}</td>
      <td>${r.finish_pos === 999 ? `<span class="muted">—</span>` : r.finish_pos}</td>
      <td>${r.points}</td>
      <td>${r.win ? "✅" : "—"}</td>
      <td>${r.top5 ? "✅" : "—"}</td>
      <td>${flags || `<span class="muted">—</span>`}</td>
    `;
    tbody.appendChild(tr);
  }
}

/***********************
 * Boot
 ***********************/
async function main() {
  // Header pills
  document.getElementById("pill-season").textContent = `Season: ${CONFIG.seasonLabel}`;
  document.getElementById("pill-lastupdate").textContent = `Last update: ${new Date().toLocaleString()}`;

  // Join/Pay modal wiring
  document.getElementById("buyin-amount").textContent = `$${CONFIG.buyInUSD}`;
  const venmoBtn = document.getElementById("btn-venmo");
  const cashBtn = document.getElementById("btn-cashapp");
  const signupBtn = document.getElementById("btn-signup");
  venmoBtn.href = CONFIG.venmoUrl || "#";
  cashBtn.href = CONFIG.cashAppUrl || "#";
  signupBtn.href = CONFIG.signupFormUrl || "#";
  if (!CONFIG.venmoUrl) venmoBtn.classList.add("disabled");
  if (!CONFIG.cashAppUrl) cashBtn.classList.add("disabled");
  if (!CONFIG.signupFormUrl) signupBtn.classList.add("disabled");

  const embedWrap = document.getElementById("signup-embed-wrap");
  const embed = document.getElementById("signup-embed");
  if (CONFIG.signupEmbedUrl && CONFIG.signupEmbedUrl.trim()) {
    embedWrap.classList.remove("d-none");
    embed.src = CONFIG.signupEmbedUrl.trim();
  }

  // Weekly pick button
  const pickBtn = document.getElementById("btn-submit-pick");
  if (CONFIG.weeklyPickFormUrl && CONFIG.weeklyPickFormUrl.trim()) {
    pickBtn.classList.remove("d-none");
    pickBtn.href = CONFIG.weeklyPickFormUrl.trim();
  }

  // Load data
  const [teamsCSV, picksCSV, racePointsCSV] = await Promise.all([
    fetchText(CONFIG.csv.teams),
    fetchText(CONFIG.csv.picks),
    fetchText(CONFIG.csv.racePoints),
  ]);

  MODEL = buildModel(parseCSV(teamsCSV), parseCSV(picksCSV), parseCSV(racePointsCSV));

  // Hookups
  document.getElementById("standings-search").addEventListener("input", renderStandings);

  renderWeekDropdown();
  document.getElementById("week-select").addEventListener("change", renderWeekly);

  renderTeamDropdown();
  document.getElementById("team-select").addEventListener("change", () => {
    const teamId = document.getElementById("team-select").value;
    location.hash = teamId ? `team=${teamId}` : "teams";
  });

  // Initial renders
  renderStandings();
  renderWeekly();
  renderTop5Chart();

  // Routing
  window.addEventListener("hashchange", routeFromHash);
  if (!location.hash) location.hash = "standings";
  routeFromHash();
}

main().catch(err => {
  console.error(err);
  alert("Failed to load data. Check your CSV URLs in app.js (Teams, Picks, RacePoints) and make sure they are published-to-web CSV links.");
});

// -----------------------------------------------------------------------------
// TunaTrace console UI. Shared by the offline simulation (index.html) and the
// live Sepolia page (live.html). Everything chain-specific lives in a back-end
// object (chain-sim.js or chain-live.js) exposed as window.TT_BACKEND.
// -----------------------------------------------------------------------------
(function () {
  const STATUS_LABEL = { InTransit: "In transit", SoldOut: "Sold out" };
  const ROLES = [
    ["processor", "Processor"], ["distributor", "Distributor"], ["retailer", "Retailer"],
    ["inspector", "Lab / inspector"], ["regulator", "Fisheries authority"],
  ];
  const FRIENDLY = {
    UnknownVessel: "This catch declaration was not signed by a licensed vessel.",
    VesselInactive: "This vessel's licence is suspended (for example, IUU-listed).",
    LicenceExpired: "The vessel's licence had expired when the fish was caught.",
    OutsideLicensedZone: "The catch position is outside the vessel's licensed fishing zone.",
    InsideProtectedArea: "The catch position is inside a marine protected area. Illegal catch.",
    UnknownCatch: "Pick a declared catch first.",
    MassBalanceExceeded: "This catch does not have that much fish left. Possible laundering of illegal fish.",
    YieldImplausible: "That many packs cannot come from this much raw fish (yield above 70 %).",
    ShelfLifeImplausible: "That use-by date is too long for the product class.",
    LotExists: "A lot with this GTIN and lot number already exists. Use a different lot number.",
    UnknownLot: "Unknown lot.",
    InvalidInput: "Check the values (temperatures, quantity, dates).",
    NotCustodian: "This organisation does not hold the lot.",
    NotPendingCustodian: "This shipment is not addressed to this organisation.",
    InvalidRecipient: "That organisation cannot receive the lot at this stage.",
    BadStatus: "The lot is not in the right state for this action.",
    PastUseBy: "The lot is past its (effective) use-by date.",
    SensorNotBound: "The temperature report was not signed by this lot's logger.",
    StaleNonce: "This signed message was already used (replay).",
    BadWindow: "The temperature window is invalid.",
    InvalidProof: "This serial is not part of the lot. Possible counterfeit.",
    AlreadySold: "This serial was already sold. Possible copied label.",
    AccessControlUnauthorizedAccount: "This organisation does not have the role needed for this action.",
  };
  const VERDICT_TEXT = {
    Genuine: ["ok", "Genuine tuna", "This pack is registered, its lot is not on hold, and the code has not been sold before."],
    GenuineAlreadySold: ["warn", "Already sold", "This code was scanned at a till before. If you just bought it, that is expected. Otherwise the label may have been copied."],
    UnknownSerial: ["bad", "Not recognised", "This serial is not part of the lot. Do not eat it. Return it to the shop."],
    UnknownLot: ["bad", "Not recognised", "No lot with this product number and lot code exists on the ledger."],
    Recalled: ["bad", "Recalled", "This lot has been recalled. Do not eat it. Return it to the shop."],
    Quarantined: ["bad", "Do not eat", "This lot is on hold: its temperature went outside the safe range, or a lab test failed."],
    PastUseBy: ["bad", "Past use-by", "This pack is past its use-by date (the date is brought forward when the cold chain was broken)."],
  };
  const SPECIES = { YFT: "Yellowfin tuna (Thunnus albacares)", BET: "Bigeye tuna (Thunnus obesus)", SKJ: "Skipjack tuna (Katsuwonus pelamis)", ALB: "Albacore (Thunnus alalunga)" };

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const short = (h) => (h && h.length > 14 ? h.slice(0, 8) + "…" + h.slice(-4) : h || "");
  const fmtT = (s) => new Date(Number(s) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const fmtD = (s) => new Date(Number(s) * 1000).toISOString().slice(0, 10);
  const fmtC = (v) => `${Number(v).toFixed(1)} °C`;
  const deg = (lat, lon) => `${Math.abs(lat).toFixed(4)}° ${lat < 0 ? "S" : "N"}, ${Math.abs(lon).toFixed(4)}° ${lon < 0 ? "W" : "E"}`;
  const hrs = (sec) => (sec >= 86400 ? `${(sec / 86400).toFixed(1)} days` : `${(sec / 3600).toFixed(1)} h`);
  const statusPill = (st) => `<span class="pill ${st}">${STATUS_LABEL[st] || st}</span>`;
  const digitalLink = (gtin, lot, serial) => `${location.origin}${location.pathname}#/01/${encodeURIComponent(gtin)}/10/${encodeURIComponent(lot)}/21/${encodeURIComponent(serial)}`;

  const state = { view: "portal", role: "processor", selected: null, lots: [], catches: [], vessel: null, busy: false };
  let B;

  // ---------------------------------------------------------------------------
  function activity(html, hideAfter) {
    const a = $("#activity"); a.innerHTML = html; a.hidden = false;
    clearTimeout(activity.t); if (hideAfter) activity.t = setTimeout(() => (a.hidden = true), hideAfter);
  }
  function explain(e) {
    if (e && e.code && FRIENDLY[e.code]) return FRIENDLY[e.code];
    if (/insufficient funds/i.test(e?.message || "")) return "This demo wallet has run out of test ETH. Ask the owner to top it up.";
    return e?.shortMessage || e?.message || String(e);
  }
  async function run(task) {
    if (state.busy) return;
    state.busy = true; renderActions();
    try { await task(); await refresh(); }
    catch (e) { activity(`<div><strong>Not done:</strong> ${esc(explain(e))}</div>${e.code ? `<div class="mono">${esc(e.code)}</div>` : ""}`, 10000); }
    finally { state.busy = false; renderActions(); }
  }
  const orgOf = (a) => B.orgOf(a) || short(a);
  const roleOf = (a) => B.roleOf(a);
  const selected = () => state.lots.find((l) => l.id === state.selected);
  const catchOf = (id) => state.catches.find((c) => c.id === id);

  // ---------------------------------------------------------------------------
  // Rendering: portal
  function renderRoles() {
    $("#roles").innerHTML = ROLES.map(([k, l]) => `<button type="button" data-role="${k}" aria-pressed="${state.role === k}">${l}</button>`).join("");
    const w = B.roles[state.role];
    $("#who").innerHTML = `${esc(w.org)} · ${B.addrLink(w.address)} <span id="bal"></span>`;
    B.balance(state.role).then((v) => { const el = $("#bal"); if (el && v) el.textContent = `· ${v}`; }).catch(() => {});
  }
  function renderLists() {
    $("#lotList").innerHTML = state.lots.map((l) => `<button type="button" class="item" data-lot="${l.id}" aria-current="${state.selected === l.id}">
      <span class="name">${esc(l.lot)}</span>${statusPill(l.status)}
      <span class="meta">${l.frozen ? "Frozen" : "Chilled"} · ${l.quantity} × ${l.packGrams} g · held by ${esc(orgOf(l.custodian))}${l.pendingCustodian ? ` → ${esc(orgOf(l.pendingCustodian))}` : ""}</span></button>`).join("")
      || `<p class="muted">No lots yet. Act as the processor to declare a catch and pack a lot.</p>`;
    $("#catchList").innerHTML = state.catches.map((c) => `<div class="item" style="cursor:default">
      <span class="name">${esc(c.species)} · ${c.weightKg} kg</span><span class="pill ${c.usedKg >= c.weightKg ? "" : "ok"}">${c.weightKg - c.usedKg} kg left</span>
      <span class="meta">${esc(c.vesselName)} · ${deg(c.lat, c.lon)} · caught ${fmtT(c.caughtAt)}</span></div>`).join("") || `<p class="muted">No catches declared yet.</p>`;
  }

  function tempChart(l, windows) {
    const W = 660, H = 220, L = 46, R = 12, T = 14, B_ = 26, n = Math.max(windows.length, 1);
    const vals = windows.flatMap((w) => [w.min, w.max]).concat([l.minTemp, l.maxTemp]);
    let top = Math.ceil(Math.max(...vals) + 2), bot = Math.floor(Math.min(...vals) - 2);
    if (top - bot < 8) top = bot + 8;
    const x = (i) => L + (i + 0.5) * (W - L - R) / n, y = (v) => T + (top - v) / (top - bot) * (H - T - B_);
    const bw = Math.min(28, Math.max(4, (W - L - R) / n * 0.55));
    const step = Math.max(1, Math.round((top - bot) / 8));
    const ticks = []; for (let v = Math.ceil(bot / step) * step; v <= top; v += step) ticks.push(v);
    const crit = l.criticalTemp <= top ? `<line x1="${L}" x2="${W - R}" y1="${y(l.criticalTemp)}" y2="${y(l.criticalTemp)}" stroke="var(--bad)" stroke-dasharray="5 4"/><text x="${W - R - 4}" y="${y(l.criticalTemp) - 4}" font-size="10" text-anchor="end" fill="var(--bad)">critical ${l.criticalTemp} °C</text>` : "";
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="min-width:440px" role="img" aria-label="Signed temperature windows against the ${l.minTemp} to ${l.maxTemp} °C storage range">
      <rect x="${L}" y="${y(l.maxTemp)}" width="${W - L - R}" height="${y(l.minTemp) - y(l.maxTemp)}" fill="var(--band)"/>
      ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${y(v) + 3}" font-size="10" text-anchor="end" fill="var(--ink-2)">${v}</text>`).join("")}
      <text x="${L + 6}" y="${y(l.minTemp) - 6}" font-size="10" fill="var(--ink-2)">storage range ${l.minTemp} to ${l.maxTemp} °C</text>
      ${crit}
      ${windows.map((w, i) => { const out = w.min < l.minTemp || w.max > l.maxTemp; return `<rect x="${x(i) - bw / 2}" y="${y(w.max)}" width="${bw}" height="${Math.max(2, y(w.min) - y(w.max))}" rx="2" fill="${out ? "var(--bad)" : "var(--accent)"}"><title>${fmtT(w.at)}: ${w.min} to ${w.max} °C</title></rect>`; }).join("")}
      <text x="4" y="${T + 4}" font-size="10" fill="var(--ink-2)">°C</text></svg>`;
  }

  /** Schematic origin map (no external tiles): licensed zone, marine park, Mauritius, catch point. */
  function originMap(lat, lon, opts = {}) {
    const Z = B.zones.licensed, P = B.zones.park;
    const W = 320, H = 240, pad = 0.6;
    const minLon = Z.minLon - pad, maxLon = Z.maxLon + pad, minLat = Z.minLat - pad, maxLat = Z.maxLat + pad;
    const X = (lo) => ((lo - minLon) / (maxLon - minLon)) * W, Y = (la) => ((maxLat - la) / (maxLat - minLat)) * H;
    // Very rough outlines (illustrative only)
    const island = (pts) => pts.map(([la, lo], i) => `${i ? "L" : "M"}${X(lo).toFixed(1)},${Y(la).toFixed(1)}`).join(" ") + "Z";
    const mauritius = island([[-19.98, 57.6], [-20.05, 57.76], [-20.28, 57.79], [-20.5, 57.72], [-20.52, 57.45], [-20.35, 57.35], [-20.1, 57.45]]);
    const reunion = island([[-20.87, 55.45], [-20.9, 55.65], [-21.1, 55.82], [-21.38, 55.75], [-21.37, 55.3], [-21.08, 55.22]]);
    const rodrigues = island([[-19.67, 63.33], [-19.7, 63.5], [-19.76, 63.46], [-19.74, 63.32]]);
    const pt = lat != null ? `<circle cx="${X(lon)}" cy="${Y(lat)}" r="9" fill="var(--bad)" opacity=".2"/><circle cx="${X(lon)}" cy="${Y(lat)}" r="4.5" fill="var(--bad)" stroke="#fff" stroke-width="1.5"/>
      <text x="${X(lon) + 9}" y="${Y(lat) - 8}" font-size="10" fill="var(--ink)">${esc(opts.label || "catch")}</text>` : "";
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Map of the licensed zone, the marine park and the catch position">
      <rect width="${W}" height="${H}" fill="var(--sea)"/>
      <rect x="${X(Z.minLon)}" y="${Y(Z.maxLat)}" width="${X(Z.maxLon) - X(Z.minLon)}" height="${Y(Z.minLat) - Y(Z.maxLat)}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="6 4"/>
      <text x="${X(Z.minLon) + 6}" y="${Y(Z.maxLat) + 14}" font-size="10" fill="var(--accent)">licensed zone</text>
      <path d="${mauritius}" fill="var(--land)" stroke="var(--ink-2)" stroke-width=".6"/><text x="${X(57.8) + 6}" y="${Y(-20.2)}" font-size="10" fill="var(--ink-2)">Mauritius</text>
      <path d="${reunion}" fill="var(--land)" stroke="var(--ink-2)" stroke-width=".6"/><text x="${X(55.2) - 4}" y="${Y(-21.6) + 6}" font-size="10" fill="var(--ink-2)" text-anchor="middle">Réunion</text>
      ${rodrigues && X(63.4) < W ? `<path d="${rodrigues}" fill="var(--land)"/>` : ""}
      <rect x="${X(P.minLon) - 3}" y="${Y(P.maxLat) - 3}" width="${X(P.maxLon) - X(P.minLon) + 6}" height="${Y(P.minLat) - Y(P.maxLat) + 6}" fill="var(--warn)" opacity=".75"/>
      <text x="${X(P.maxLon) + 6}" y="${Y(P.minLat) + 12}" font-size="10" fill="var(--warn)">marine park</text>
      ${pt}</svg>`;
  }

  const EVENT_TEXT = {
    CatchDeclared: (a) => [`Catch declared by vessel`, `${a.weightKg} kg ${a.species} at ${deg(a.latE5 / 1e5, a.lonE5 / 1e5)}`, "good"],
    LotCreated: (a) => [`Lot packed`, `${a.quantity} packs · documents ${short(a.docsCid)}`, ""],
    SensorBound: (a) => [`Temperature logger fitted`, `logger ${short(a.sensor)}`, ""],
    TransferInitiated: (a) => [`Shipped to ${orgOf(a.to)}`, `delivery note hash ${short(a.handoverDocHash)}`, ""],
    TransferAccepted: (a) => [`Received by ${orgOf(a.to)}`, `custody confirmed by the receiver`, ""],
    TransferCancelled: () => [`Shipment cancelled`, "", ""],
    TelemetryGap: () => [`Telemetry gap`, `logger silent for over an hour`, "warn"],
    TemperatureAbuse: (a) => [`Temperature abuse`, `+${a.addedScore} (total ${a.totalScore}) · use-by brought forward ${hrs(Number(a.shelfLifeLostSec))}`, "warn"],
    LotQuarantined: (a) => [`Quarantined`, a.reason, "bad"],
    LotReleased: () => [`Released by inspector`, "histamine assessment on file", "good"],
    SpeciesTested: (a) => [a.matchesDeclared ? "DNA test: species confirmed" : "DNA test: species MISMATCH", `report ${short(a.reportCid)}`, a.matchesDeclared ? "good" : "bad"],
    LotRecalled: (a) => [`Recalled by ${orgOf(a.by)}`, a.reason, "bad"],
    PackSold: () => [`Pack sold at the till`, "", ""],
  };

  async function renderDetail() {
    const l = selected();
    if (!l) { $("#detail").innerHTML = `<p class="muted">Select a lot.</p>`; return; }
    const c = catchOf(l.catchId);
    const used = l.abuseBudget ? Math.min(100, (l.abuseScore / l.abuseBudget) * 100) : 0;
    const mClass = l.abuseScore > l.abuseBudget ? "bad" : l.abuseScore ? "warn" : "";
    const serial = "TT0007";
    $("#detail").innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between"><h2 style="margin:0">Lot ${esc(l.lot)}</h2>${statusPill(l.status)}</div>
      <div class="facts">
        <div class="fact"><div class="k">Product</div><div class="v">${esc(SPECIES[l.species] || l.species)}, ${l.frozen ? "frozen" : "chilled"}</div></div>
        <div class="fact"><div class="k">GTIN</div><div class="v mono">${esc(l.gtin)}</div></div>
        <div class="fact"><div class="k">Packs sold</div><div class="v">${l.sold} / ${l.quantity} × ${l.packGrams} g</div></div>
        <div class="fact"><div class="k">Use-by (effective)</div><div class="v">${fmtD(l.effectiveUseBy)}${l.shelfLifeLostSec ? ` <span class="muted">(−${hrs(l.shelfLifeLostSec)})</span>` : ""}</div></div>
        <div class="fact"><div class="k">Abuse budget used</div><div class="v">${l.abuseScore} of ${l.abuseBudget}</div><div class="meter ${mClass}"><span style="width:${used}%"></span></div></div>
        <div class="fact"><div class="k">DNA species test</div><div class="v">${l.dnaVerified ? "Confirmed" : "Not yet"}</div></div>
        <div class="fact"><div class="k">Holder</div><div class="v">${esc(orgOf(l.custodian))}</div></div>
        <div class="fact"><div class="k">Raw fish drawn</div><div class="v">${l.rawWeightKg} kg of ${c ? c.weightKg : "?"} kg catch</div></div>
      </div>
      ${c ? `<h3>Origin</h3><div class="row2" style="align-items:start"><div class="mapbox">${originMap(c.lat, c.lon, { label: c.vesselName.replace(" (fictional)", "") })}</div>
        <div class="muted">Caught by <strong>${esc(c.vesselName)}</strong> at ${deg(c.lat, c.lon)} on ${fmtT(c.caughtAt)}. The position was signed by the vessel's VMS unit and checked on-chain against its licensed zone and the marine park.</div></div>` : ""}
      <h3>Pack label (GS1 Digital Link)</h3>
      <div class="label-card"><div class="qr" id="qr"></div><div><div class="mono">${esc(digitalLink(l.gtin, l.lot, serial))}</div><p class="muted" style="margin:6px 0 0">Scan with a phone camera: the shopper check opens and verifies pack ${serial} against the ledger.</p></div></div>
      <div id="hist"><p class="muted"><span class="spinner"></span>Reading this lot's history…</p></div>`;
    drawQr($("#qr"), digitalLink(l.gtin, l.lot, serial));
    try {
      const events = await B.history(l.id, l.catchId);
      if (selected()?.id !== l.id) return;
      const windows = events.filter((e) => e.name === "TelemetryRecorded").map((e) => ({ at: e.args.windowStart, min: Number(e.args.minTempDeci) / 10, max: Number(e.args.maxTempDeci) / 10 }));
      const story = events.filter((e) => EVENT_TEXT[e.name]).map((e) => { const [t, d, k] = EVENT_TEXT[e.name](e.args); return { t, d, k, at: e.at, tx: e.tx }; });
      $("#hist").innerHTML = `
        <h3>Cold-chain record (signed 15-minute windows)</h3>
        ${windows.length ? `<div class="chartbox">${tempChart(l, windows)}</div>` : `<p class="note">No temperature reports yet.</p>`}
        <h3>History</h3>
        <ol class="timeline">${story.map((e) => `<li><span class="node ${e.k}"></span><div><div class="t">${esc(e.t)}</div><div class="d">${fmtT(e.at)}${e.d ? " · " + esc(e.d) : ""} · tx ${B.txLink(e.tx)}</div></div></li>`).join("")}</ol>`;
    } catch (e) {
      $("#hist").innerHTML = `<p class="note warn">Could not read the history right now: ${esc(explain(e))}</p>`;
    }
  }

  function drawQr(el, text) {
    if (!el) return;
    if (typeof window.qrcode !== "function") { el.innerHTML = `<span class="muted" style="line-height:1.3;display:block;width:104px">QR library not loaded (offline)</span>`; return; }
    const q = window.qrcode(0, "M"); q.addData(text); q.make();
    el.innerHTML = q.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
  }

  function renderActions() {
    const r = state.role, l = selected(), dis = state.busy ? "disabled" : "";
    const st = l ? l.status : null;
    const holder = l ? roleOf(l.custodian) : null;
    let h = "";
    if (r === "processor") {
      const avail = state.catches.filter((c) => c.usedKg < c.weightKg);
      const nextLot = `YFT-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${String(state.lots.length + 1).padStart(2, "0")}`;
      h = `<h2>1 · Landing: declare a catch</h2>
        <p class="muted">The vessel's VMS unit signs the declaration (EIP-712); the processor submits it. Try the presets.</p>
        <div class="seg" style="margin-bottom:8px">
          <button type="button" data-preset="legal">Legal catch</button><button type="button" data-preset="park">Inside marine park</button><button type="button" data-preset="outside">Outside licence zone</button></div>
        <form id="catchForm">
          <div class="row3"><label for="kWeight">Weight (kg)<input id="kWeight" type="number" min="1" value="480" required></label>
          <label for="kLat">Latitude<input id="kLat" type="number" step="0.0001" value="-19.4120" required></label>
          <label for="kLon">Longitude<input id="kLon" type="number" step="0.0001" value="58.3301" required></label></div>
          <button class="btn" type="submit" ${dis}>Submit signed catch declaration</button>
        </form>
        <h2 style="margin-top:18px">2 · Pack a lot</h2>
        ${avail.length ? `<form id="lotForm">
          <label for="cCatch">From catch<select id="cCatch">${avail.map((c) => `<option value="${c.id}">${esc(c.species)} ${c.weightKg} kg (${c.weightKg - c.usedKg} kg left) · ${fmtD(c.caughtAt)}</option>`).join("")}</select></label>
          <div class="row2"><label for="cLot">Lot number<input id="cLot" class="mono" value="${nextLot}" required></label>
          <label for="cClass">Product class<select id="cClass"><option value="frozen">Frozen saku, −60 °C (18 months)</option><option value="chilled">Chilled loin, 0–4 °C (10 days)</option></select></label></div>
          <div class="row3"><label for="cRaw">Raw fish (kg)<input id="cRaw" type="number" min="1" value="40" required></label>
          <label for="cQty">Packs (1–200)<input id="cQty" type="number" min="1" max="200" value="80" required></label>
          <label for="cGrams">Grams / pack<input id="cGrams" type="number" min="50" value="250" required></label></div>
          <p class="muted">Packs get serials TT0001, TT0002… Only their Merkle root goes on-chain. The contract rejects more fish than the catch holds, and yields above 70 %.</p>
          <button class="btn" type="submit" ${dis}>Pack lot</button></form>` : `<p class="muted">Declare a catch first (or all catches are used up).</p>`}`;
      if (l && holder === "processor" && (st === "Packed" || st === "Received")) h += `<h3>Selected: ${esc(l.lot)}</h3><div class="actions"><button class="btn ghost" data-act="ship-dist" ${dis}>Ship to distributor</button></div>`;
      if (l && holder === "processor" && st === "InTransit") h += `<div class="actions"><button class="btn ghost" data-act="cancel" ${dis}>Cancel shipment of ${esc(l.lot)}</button></div>`;
      if (l && st !== "Recalled") h += `<div class="actions"><button class="btn danger" data-act="recall-proc" ${dis}>Recall ${esc(l.lot)}</button></div>`;
    } else if (r === "distributor") {
      const inbound = state.lots.filter((x) => roleOf(x.pendingCustodian) === "distributor" && x.status === "InTransit");
      h = `<h2>Cold store and reefer trucks</h2><h3>Inbound consignments</h3>${inbound.map((x) => `<div class="actions"><button class="btn" data-act="accept" data-id="${x.id}" ${dis}>Accept ${esc(x.lot)}</button></div>`).join("") || `<p class="muted">Nothing waiting for you.</p>`}`;
      if (l && (st === "InTransit" || st === "Received") && ["processor", "distributor", "retailer"].includes(holder)) {
        const peak = l.frozen ? -30 : 7.5;
        h += `<h3>Reefer leg for ${esc(l.lot)}</h3>
        <form id="tripForm"><div class="row2"><label for="tPeak">Peak °C<input id="tPeak" type="number" step="0.5" value="${peak}"></label><label for="tMin">Minutes above limit (0–45)<input id="tMin" type="number" min="0" max="45" step="15" value="45"></label></div>
        <p class="muted">Fits a new logger, then sends 3 signed 15-minute windows through the IoT gateway. The contract scores time-temperature abuse and may quarantine the lot.</p>
        <button class="btn" type="submit" ${dis}>Send temperature reports</button></form>`;
      }
      if (l && holder === "distributor" && st === "Received") h += `<div class="actions" style="margin-top:10px"><button class="btn ghost" data-act="ship-ret" ${dis}>Ship ${esc(l.lot)} to retailer</button></div>`;
    } else if (r === "retailer") {
      const inbound = state.lots.filter((x) => roleOf(x.pendingCustodian) === "retailer" && x.status === "InTransit");
      h = `<h2>Supermarket</h2>${inbound.map((x) => `<div class="actions"><button class="btn" data-act="accept" data-id="${x.id}" ${dis}>Accept ${esc(x.lot)}</button></div>`).join("")}
        <form id="sellForm"><label for="sSerial">Scan a pack at the till (${l ? esc(l.lot) : "select a lot"})<input id="sSerial" class="mono" value="TT0007"></label>
        <p class="muted">Try TT0042 on the first lot (already sold) or TT9999 (not in the lot).</p>
        <button class="btn" type="submit" ${dis}>Sell pack</button></form>`;
    } else if (r === "inspector") {
      h = `<h2>Laboratory and inspection</h2>${l ? `<p>Selected: <span class="mono">${esc(l.lot)}</span></p>
        <h3>DNA barcoding (species authenticity)</h3>
        <div class="actions"><button class="btn" data-act="dna-ok" ${dis}>Result: yellowfin confirmed</button><button class="btn danger" data-act="dna-bad" ${dis}>Result: substituted species</button></div>
        <h3>Quarantine decisions</h3>
        <div class="actions"><button class="btn" data-act="release" ${st !== "Quarantined" || state.busy ? "disabled" : ""}>Release after histamine test</button>
        <button class="btn ghost" data-act="quarantine" ${["Quarantined", "Recalled", "SoldOut"].includes(st) || state.busy ? "disabled" : ""}>Quarantine</button></div>` : `<p class="muted">Select a lot.</p>`}`;
    } else if (r === "regulator") {
      const v = state.vessel;
      h = `<h2>Fisheries authority</h2>
        ${v ? `<h3>Vessel register</h3><p><strong>${esc(v.name)}</strong> · licence ${esc(v.licenceNo)} · expires ${fmtD(v.licenceExpiry)} · ${v.active ? `<span class="pill ok">Active</span>` : `<span class="pill bad">Suspended</span>`}</p>
        <div class="actions">${v.active ? `<button class="btn danger" data-act="suspend" ${dis}>Suspend (IUU listing)</button>` : `<button class="btn" data-act="relicense" ${dis}>Reinstate licence</button>`}</div>` : ""}
        <div class="mapbox" style="margin:8px 0">${originMap(null, null)}</div>
        <h3>Recall</h3><p class="muted">Every pack of a recalled lot shows Recalled to retailers and shoppers.</p>
        ${l && st !== "Recalled" ? `<div class="actions"><button class="btn danger" data-act="recall-reg" ${dis}>Recall ${esc(l.lot)}</button></div>` : ""}`;
    }
    if (state.busy) h += `<p class="note"><span class="spinner"></span>Waiting for the ledger…</p>`;
    const kept = {};
    document.querySelectorAll("#actionPanel input, #actionPanel select").forEach((i) => { if (i.id !== "cLot") kept[i.id] = i.value; });
    $("#actionPanel").innerHTML = h;
    for (const [id, v] of Object.entries(kept)) { const el = document.getElementById(id); if (el) el.value = v; }
  }

  async function refresh() {
    const d = await B.load();
    state.lots = d.lots; state.catches = d.catches; state.vessel = d.vessel;
    if (!state.selected && state.lots.length) state.selected = state.lots[0].id;
    renderRoles(); renderLists(); renderActions(); await renderDetail();
    $("#chainInfo").innerHTML = await B.chainInfo();
    if (B.renderLedger) B.renderLedger($("#ledger"));
  }

  // ---------------------------------------------------------------------------
  // Shopper check
  async function verify(gtin, lot, serial) {
    $("#verdict").innerHTML = `<p class="muted"><span class="spinner"></span>Checking the ledger…</p>`;
    const r = await B.verify(gtin.trim(), lot.trim(), serial.trim());
    const [k, big, text] = VERDICT_TEXT[r.verdict];
    const prov = r.verdict !== "UnknownLot" ? `
      <div class="prov">
        <div><div class="k">Species</div>${esc(SPECIES[r.species] || r.species)}${r.dnaVerified ? ` <span class="pill ok">DNA-verified</span>` : ""}</div>
        <div><div class="k">Caught by</div>${esc(r.vesselName)}</div>
        <div><div class="k">Where</div>${deg(r.lat, r.lon)}<br><span class="muted">Western Indian Ocean (FAO area 51)</span></div>
        <div><div class="k">When</div>${fmtT(r.caughtAt)}</div>
        <div><div class="k">Cold chain</div>${r.abuseScore ? `${r.abuseScore} units of temperature abuse recorded${r.verdict === "Genuine" || r.verdict === "GenuineAlreadySold" ? ", within the safe limit" : ""}` : "No temperature abuse recorded"}</div>
        <div><div class="k">Use by</div>${fmtD(r.effectiveUseBy)} · ${r.frozen ? "keep frozen" : "keep at 0–4 °C"}</div>
        <div><div class="k">Packed by</div>${esc(orgOf(r.processor))}</div>
        <div><div class="k">Lot</div><span class="mono">${esc(r.lot)}</span></div>
      </div>
      <div class="mapbox">${originMap(r.lat, r.lon, { label: "your tuna" })}</div>` : "";
    $("#verdict").innerHTML = `<div class="verdict ${k}" role="status"><div class="big">${big}</div><div class="detail">${text}</div>${prov}
      <div class="detail muted">${esc(B.verifySource())}</div></div>`;
  }
  function renderSamples() {
    const s = B.samples;
    const rows = [["Genuine pack", s.gtin, s.goodLot, "TT0007"], ["Already sold", s.gtin, s.goodLot, "TT0042"], ["Counterfeit label", s.gtin, s.goodLot, "TT9999"], ["Freezer-failure lot", s.gtin, s.badLot, "TT0003"]];
    $("#samples").innerHTML = rows.map((x) => `<button type="button" data-sample='${esc(JSON.stringify(x.slice(1)))}'>${x[0]}</button>`).join("");
  }
  function parseLink(text) {
    const m = /\/01\/([^/]+)\/10\/([^/]+)\/21\/([^/?#]+)/.exec(text || "");
    return m ? m.slice(1).map(decodeURIComponent) : null;
  }
  function setView(v) {
    state.view = v;
    document.querySelectorAll("nav.views button").forEach((x) => x.setAttribute("aria-pressed", x.dataset.view === v));
    for (const id of ["portal", "shopper", "ledger"]) { const el = $(`#v-${id}`); if (el) el.hidden = id !== v; }
  }

  // ---------------------------------------------------------------------------
  // Events
  const PRESETS = { legal: [480, -19.412, 58.3301], park: [350, -20.445, 57.712], outside: [500, -12.1, 58.5] };
  document.addEventListener("click", (e) => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.view) { setView(t.dataset.view); return; }
    if (t.dataset.role) { state.role = t.dataset.role; renderRoles(); renderActions(); return; }
    if (t.dataset.lot) { state.selected = t.dataset.lot; renderLists(); renderActions(); renderDetail(); return; }
    if (t.dataset.preset) { const [w, la, lo] = PRESETS[t.dataset.preset]; $("#kWeight").value = w; $("#kLat").value = la; $("#kLon").value = lo; return; }
    if (t.dataset.sample) { const [g, l, s] = JSON.parse(t.dataset.sample); $("#vGtin").value = g; $("#vLot").value = l; $("#vSerial").value = s; verify(g, l, s).catch((err) => ($("#verdict").innerHTML = `<p class="note err">${esc(explain(err))}</p>`)); return; }
    if (t.id === "refresh") { run(async () => {}); return; }
    const a = t.dataset.act; if (!a) return;
    const l = t.dataset.id ? state.lots.find((x) => x.id === t.dataset.id) : selected();
    if (a === "ship-dist") run(() => B.ship(l, "processor", "distributor"));
    if (a === "ship-ret") run(() => B.ship(l, "distributor", "retailer"));
    if (a === "cancel") run(() => B.cancel(l, "processor"));
    if (a === "accept") run(async () => { await B.accept(l, state.role); state.selected = l.id; });
    if (a === "dna-ok") run(() => B.dnaTest(l, true));
    if (a === "dna-bad") run(() => B.dnaTest(l, false));
    if (a === "release") run(() => B.release(l));
    if (a === "quarantine") run(() => B.quarantine(l));
    if (a === "recall-proc") run(() => B.recall(l, "processor"));
    if (a === "recall-reg") run(() => B.recall(l, "regulator"));
    if (a === "suspend") run(() => B.suspendVessel());
    if (a === "relicense") run(() => B.relicenseVessel());
  });
  document.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = e.target.id;
    if (id === "catchForm") {
      const f = { weightKg: +$("#kWeight").value, lat: +$("#kLat").value, lon: +$("#kLon").value };
      run(() => B.declareCatch(f));
    }
    if (id === "lotForm") {
      // Read every field now: the panel re-renders as soon as the transaction starts.
      const qty = +$("#cQty").value, frozen = $("#cClass").value === "frozen", lot = $("#cLot").value.trim();
      const c = catchOf($("#cCatch").value), raw = +$("#cRaw").value, grams = +$("#cGrams").value;
      run(async () => {
        if (!(qty >= 1 && qty <= 200)) throw new Error("Use between 1 and 200 packs in the demo.");
        await B.createLot({
          lot, catchId: c.id, rawWeightKg: raw, quantity: qty, packGrams: grams, frozen,
          useBy: c.caughtAt + (frozen ? 540 : 10) * 86400,
          minTemp: frozen ? -65 : 0, maxTemp: frozen ? -45 : 4, criticalTemp: frozen ? -18 : 10,
          abuseBudget: frozen ? 3000 : 600, shelfLifePenaltySec: frozen ? 600 : 120,
        });
        state.selected = B.lotIdOf(frozen ? B.samples.gtin : B.samples.gtinChilled, lot);
      });
    }
    if (id === "tripForm") { const l = selected(), peak = +$("#tPeak").value, mins = +$("#tMin").value; run(() => B.trip(l, peak, mins)); }
    if (id === "sellForm") { const l = selected(), serial = $("#sSerial").value.trim(); run(() => B.sell(l, serial)); }
    if (id === "verifyForm") {
      const link = parseLink($("#vLink").value);
      if (link) { $("#vGtin").value = link[0]; $("#vLot").value = link[1]; $("#vSerial").value = link[2]; }
      verify($("#vGtin").value, $("#vLot").value, $("#vSerial").value).catch((err) => ($("#verdict").innerHTML = `<p class="note err">${esc(explain(err))}</p>`));
    }
  });

  // ---------------------------------------------------------------------------
  window.TT_START = async function start(backend) {
    B = backend;
    B.onProgress = activity;
    try {
      await B.init();
      renderSamples();
      $("#vGtin").value = B.samples.gtin; $("#vLot").value = B.samples.goodLot; $("#vSerial").value = "TT0007";
      await refresh();
      const link = parseLink(location.hash);
      if (link) {
        setView("shopper");
        $("#vGtin").value = link[0]; $("#vLot").value = link[1]; $("#vSerial").value = link[2];
        await verify(...link);
      }
    } catch (e) {
      $("#setupError").hidden = false; $("#setupError").textContent = explain(e);
    }
  };
})();

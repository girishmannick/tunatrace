// -----------------------------------------------------------------------------
// TunaTrace offline back-end: an in-browser simulation of the consortium chain.
// It re-implements the TunaTrace.sol rules in JavaScript (same checks, same
// error names, same events) and seals every transaction into a block signed
// by a simulated 7-validator QBFT committee, so the console works with no
// network, no wallet and no blockchain. Hashes use SHA-256 (WebCrypto).
// -----------------------------------------------------------------------------
window.TT_SIM_BACKEND = function () {
  const DAY = 86400;
  const ORG = {
    regulator: "Fisheries Competent Authority (fictional)", processor: "Port Louis Ocean Foods Ltd (fictional)",
    distributor: "IslandCold Logistics (fictional)", retailer: "Lagoon Fresh Market (fictional)", oracle: "IoT oracle gateway",
    inspector: "Marine Food Lab (fictional)", vessel: "FV Albacora Star VMS unit (fictional)",
  };
  const VALIDATORS = ["Fisheries Authority", "Port Louis Ocean Foods", "Second processor", "IslandCold Logistics", "Retail association", "Marine Food Lab", "NGO observer"];
  const GTIN = { frozen: "06099999000027", chilled: "06099999000010" };
  const LICENSED = { minLat: -24, maxLat: -16, minLon: 53, maxLon: 62 };
  const PARK = { minLat: -20.47, maxLat: -20.42, minLon: 57.69, maxLon: 57.74 };
  const MAX_YIELD = 0.7, MAX_CHILLED_LIFE = 21 * DAY, MAX_FROZEN_LIFE = 730 * DAY, MAX_GAP = 3600;
  const enc = new TextEncoder();
  const sha = async (s) => "0x" + [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const short = (h) => (h && h.length > 14 ? h.slice(0, 8) + "…" + h.slice(-4) : h);
  const now = () => Math.floor(Date.now() / 1000);
  const fail = (code) => { const e = new Error(code); e.code = code; throw e; };
  const inside = (z, la, lo) => la >= z.minLat && la <= z.maxLat && lo >= z.minLon && lo <= z.maxLon;

  const B = { mode: "sim", onProgress: () => {} };
  const S = { roles: {}, hasRole: {}, vessel: null, park: [PARK], catches: new Map(), lots: new Map(), sold: new Set(), sensors: {}, events: [], blocks: [], pendingEvents: [] };

  // ---- Ledger ---------------------------------------------------------------------
  async function seal(fn, from, summary) {
    const prev = S.blocks.length ? S.blocks[S.blocks.length - 1] : null;
    const height = S.blocks.length;
    const txHash = await sha(`${height}|${fn}|${from}|${summary}|${Math.random()}`);
    const at = now();
    const signed = VALIDATORS.map((_, i) => i !== (height * 3 + 1) % 7 || height % 4 !== 0); // one validator occasionally offline: 6 of 7 still > 2f+1 = 5
    const header = { height, prev: prev ? prev.hash : "0x0", at, proposer: VALIDATORS[height % 7], tx: txHash };
    const block = { ...header, hash: await sha(JSON.stringify(header)), fn, from, summary, signed };
    S.blocks.push(block);
    for (const e of S.pendingEvents) S.events.push({ ...e, tx: txHash, at, block: height });
    S.pendingEvents = [];
    return block;
  }
  const emit = (name, key, args) => S.pendingEvents.push({ name, key, args });
  async function tx(role, label, fn, body) {
    S.pendingEvents = [];
    body(); // throws on any rule violation, before anything is sealed
    const b = await seal(fn, role, label);
    if (!S.seeding) B.onProgress(`<div>${label}: sealed in block ${b.height} by ${b.proposer}.</div><div class="mono">${short(b.tx)}</div>`, 6000);
    return b;
  }
  const need = (role, r) => { if (!S.hasRole[r]?.has(S.roles[role].address)) fail("AccessControlUnauthorizedAccount"); };

  // ---- Contract rules (mirror of TunaTrace.sol) --------------------------------------
  function _declareCatch(role, signer, c) {
    need(role, "processor");
    const v = S.vessel;
    if (!v || signer !== v.address) fail("UnknownVessel");
    if (!v.active) fail("VesselInactive");
    if (c.caughtAt > v.licenceExpiry) fail("LicenceExpired");
    if (c.weightKg <= 0) fail("InvalidInput");
    if (c.nonce <= v.lastNonce) fail("StaleNonce");
    if (!inside(LICENSED, c.lat, c.lon)) fail("OutsideLicensedZone");
    if (S.park.some((z) => inside(z, c.lat, c.lon))) fail("InsideProtectedArea");
    v.lastNonce = c.nonce;
    const id = `catch-${v.address}-${c.nonce}`;
    S.catches.set(id, { id, vessel: v.address, vesselName: v.name, species: c.species, weightKg: c.weightKg, usedKg: 0, lat: c.lat, lon: c.lon, caughtAt: c.caughtAt });
    emit("CatchDeclared", id, { catchId: id, species: c.species, weightKg: c.weightKg, latE5: Math.round(c.lat * 1e5), lonE5: Math.round(c.lon * 1e5), caughtAt: c.caughtAt });
    return id;
  }
  function _createLot(role, f) {
    need(role, "processor");
    if (!(f.quantity > 0) || !(f.packGrams > 0) || !(f.rawWeightKg > 0) || f.useBy <= now() || f.minTemp >= f.maxTemp || f.criticalTemp <= f.maxTemp) fail("InvalidInput");
    const c = S.catches.get(f.catchId); if (!c) fail("UnknownCatch");
    if (c.usedKg + f.rawWeightKg > c.weightKg) fail("MassBalanceExceeded");
    if (f.quantity * f.packGrams > f.rawWeightKg * 1000 * MAX_YIELD) fail("YieldImplausible");
    if (f.frozen && f.maxTemp > -18) fail("InvalidInput");
    if (f.useBy > c.caughtAt + (f.frozen ? MAX_FROZEN_LIFE : MAX_CHILLED_LIFE)) fail("ShelfLifeImplausible");
    const gtin = f.frozen ? GTIN.frozen : GTIN.chilled, id = B.lotIdOf(gtin, f.lot);
    if (S.lots.has(id)) fail("LotExists");
    c.usedKg += f.rawWeightKg;
    const p = S.roles[role].address;
    S.lots.set(id, { id, gtin, lot: f.lot, species: c.species, catchId: c.id, rawWeightKg: f.rawWeightKg, quantity: f.quantity, sold: 0, packGrams: f.packGrams,
      frozen: f.frozen, useBy: f.useBy, minTemp: f.minTemp, maxTemp: f.maxTemp, criticalTemp: f.criticalTemp, abuseBudget: f.abuseBudget, abuseScore: 0,
      excursionSec: 0, shelfLifePenaltySec: f.shelfLifePenaltySec, shelfLifeLostSec: 0, telemetryGaps: 0, dnaVerified: false, processor: p, custodian: p,
      pendingCustodian: null, status: "Packed", lastTelemetryEnd: 0 });
    emit("LotCreated", id, { quantity: f.quantity, docsCid: "bafkrei-sim-catch-and-health-certificate" });
    return id;
  }
  const lotOr = (id) => S.lots.get(id) || fail("UnknownLot");
  const eff = (l) => Math.max(0, l.useBy - l.shelfLifeLostSec);
  const roleHas = (addr, r) => S.hasRole[r]?.has(addr);
  function _ship(role, id, toRole) {
    const l = lotOr(id), from = S.roles[role].address, to = S.roles[toRole].address;
    if (l.custodian !== from) fail("NotCustodian");
    if (l.status !== "Packed" && l.status !== "Received") fail("BadStatus");
    if (now() >= eff(l)) fail("PastUseBy");
    const ok = roleHas(from, "processor") ? roleHas(to, "distributor") : roleHas(from, "distributor") ? roleHas(to, "distributor") || roleHas(to, "retailer") : false;
    if (!ok || to === from) fail("InvalidRecipient");
    l.pendingCustodian = to; l.status = "InTransit";
    emit("TransferInitiated", id, { from, to, handoverDocHash: "0x" + Math.random().toString(16).slice(2).padEnd(64, "0") });
  }
  function _accept(role, id) {
    const l = lotOr(id), me = S.roles[role].address;
    if (l.status !== "InTransit") fail("BadStatus");
    if (l.pendingCustodian !== me) fail("NotPendingCustodian");
    const from = l.custodian; l.custodian = me; l.pendingCustodian = null; l.status = "Received";
    emit("TransferAccepted", id, { from, to: me });
  }
  function _cancel(role, id) {
    const l = lotOr(id);
    if (l.status !== "InTransit") fail("BadStatus");
    if (l.custodian !== S.roles[role].address) fail("NotCustodian");
    l.pendingCustodian = null; l.status = l.custodian === l.processor ? "Packed" : "Received";
    emit("TransferCancelled", id, {});
  }
  function quarantine(l, reason) { l.status = "Quarantined"; l.pendingCustodian = null; emit("LotQuarantined", l.id, { reason }); }
  function _bind(role, id, sensor) {
    const l = lotOr(id);
    if (l.custodian !== S.roles[role].address && role !== "regulator") fail("NotCustodian");
    S.sensors[sensor] = { lot: id, nonce: 0 };
    emit("SensorBound", id, { sensor });
  }
  function _telemetry(role, signer, t) {
    need(role, "oracle");
    const l = lotOr(t.lotId);
    if (t.windowEnd <= t.windowStart || t.windowEnd > now() + 300 || t.minTempDeci > t.maxTempDeci) fail("BadWindow");
    const s = S.sensors[signer];
    if (!s || s.lot !== t.lotId) fail("SensorNotBound");
    if (t.nonce <= s.nonce) fail("StaleNonce");
    s.nonce = t.nonce;
    if (l.lastTelemetryEnd && t.windowStart > l.lastTelemetryEnd + MAX_GAP) { l.telemetryGaps++; emit("TelemetryGap", l.id, {}); }
    if (t.windowEnd > l.lastTelemetryEnd) l.lastTelemetryEnd = t.windowEnd;
    emit("TelemetryRecorded", l.id, { windowStart: t.windowStart, windowEnd: t.windowEnd, minTempDeci: t.minTempDeci, maxTempDeci: t.maxTempDeci });
    const live = !["Quarantined", "Recalled", "SoldOut"].includes(l.status);
    const maxD = Math.round(l.maxTemp * 10), minD = Math.round(l.minTemp * 10), critD = Math.round(l.criticalTemp * 10);
    if (t.maxTempDeci > maxD || t.minTempDeci < minD) {
      const secs = t.windowEnd - t.windowStart;
      l.excursionSec += secs;
      const added = t.maxTempDeci > maxD ? (t.maxTempDeci - maxD) * Math.floor(secs / 60) : 0;
      if (added > 0) {
        l.abuseScore += added; l.shelfLifeLostSec += added * l.shelfLifePenaltySec;
        emit("TemperatureAbuse", l.id, { addedScore: added, totalScore: l.abuseScore, shelfLifeLostSec: l.shelfLifeLostSec });
      }
    }
    if (!live) return;
    if (t.maxTempDeci >= critD) quarantine(l, "Critical temperature limit reached");
    else if (l.abuseScore > l.abuseBudget) quarantine(l, "Time-temperature abuse budget exceeded");
  }
  function _dna(role, id, ok) {
    need(role, "inspector");
    const l = lotOr(id);
    emit("SpeciesTested", id, { matchesDeclared: ok, reportCid: "bafkrei-sim-dna-report" });
    l.dnaVerified = ok;
    if (!ok && l.status !== "Recalled" && l.status !== "Quarantined") quarantine(l, "DNA test: species does not match declaration");
  }
  function _release(role, id) {
    need(role, "inspector");
    const l = lotOr(id);
    if (l.status !== "Quarantined") fail("BadStatus");
    l.status = l.custodian === l.processor ? "Packed" : "Received";
    l.abuseBudget = l.abuseScore + l.abuseBudget;
    emit("LotReleased", id, { assessmentCid: "bafkrei-sim-histamine-assessment" });
  }
  function _quarantine(role, id) {
    need(role, "inspector");
    const l = lotOr(id);
    if (["Recalled", "Quarantined", "SoldOut"].includes(l.status)) fail("BadStatus");
    quarantine(l, "Inspection finding");
  }
  function _recall(role, id) {
    const l = lotOr(id), me = S.roles[role].address;
    if (me !== l.processor && !roleHas(me, "regulator")) fail("NotCustodian");
    if (l.status === "Recalled") fail("BadStatus");
    l.status = "Recalled"; l.pendingCustodian = null;
    emit("LotRecalled", id, { by: me, reason: "Recall issued from the console" });
  }
  const validSerial = (l, serial) => /^TT\d{4}$/.test(serial) && +serial.slice(2) >= 1 && +serial.slice(2) <= l.quantity;
  function _sell(role, id, serial) {
    need(role, "retailer");
    const l = lotOr(id);
    if (l.custodian !== S.roles[role].address) fail("NotCustodian");
    if (l.status !== "Received") fail("BadStatus");
    if (now() >= eff(l)) fail("PastUseBy");
    if (!validSerial(l, serial)) fail("InvalidProof");
    if (S.sold.has(`${id}|${serial}`)) fail("AlreadySold");
    S.sold.add(`${id}|${serial}`); l.sold++;
    if (l.sold === l.quantity) l.status = "SoldOut";
    emit("PackSold", id, {});
  }

  // ---- Back-end interface ----------------------------------------------------------
  B.lotIdOf = (gtin, lot) => `${gtin}|${lot}`;
  B.init = async function () {
    for (const r of ["regulator", "processor", "distributor", "retailer", "oracle", "inspector", "vessel"]) {
      S.roles[r] = { org: ORG[r], address: "0x" + (await sha(`tunatrace-sim-${r}`)).slice(2, 42) };
    }
    for (const r of ["regulator", "processor", "distributor", "retailer", "oracle", "inspector"]) S.hasRole[r] = new Set([S.roles[r].address]);
    B.roles = S.roles;
    B.zones = { licensed: LICENSED, park: PARK };
    B.samples = { gtin: GTIN.frozen, gtinChilled: GTIN.chilled, goodLot: "YFT-ULT-2610-A", badLot: "YFT-ULT-2610-B" };
    S.seeding = true; await seed(); S.seeding = false;
  };
  B.orgOf = (a) => Object.values(S.roles).find((r) => r.address === a)?.org;
  B.roleOf = (a) => Object.keys(S.roles).find((k) => S.roles[k].address === a);
  B.txLink = (h) => `<span class="mono">${short(h)}</span>`;
  B.addrLink = (a) => `<span class="mono">${short(a)}</span>`;
  B.balance = async () => null;
  B.chainInfo = async () => `Simulated QBFT · block ${S.blocks.length - 1} · 7 validators · 2 s blocks`;
  B.verifySource = () => "Offline simulation: the same rules as the TunaTrace contract, running in your browser.";
  const view = (l) => ({ ...l, effectiveUseBy: eff(l) });
  B.load = async () => ({ lots: [...S.lots.values()].map(view), catches: [...S.catches.values()].map((c) => ({ ...c })), vessel: { ...S.vessel } });
  B.history = async (lotId, catchId) => S.events.filter((e) => e.key === lotId || e.key === catchId);
  B.verify = async (gtin, lot, serial) => {
    const l = S.lots.get(B.lotIdOf(gtin, lot));
    if (!l) return { verdict: "UnknownLot" };
    const c = S.catches.get(l.catchId);
    let verdict;
    if (!validSerial(l, serial)) verdict = "UnknownSerial";
    else if (l.status === "Recalled") verdict = "Recalled";
    else if (l.status === "Quarantined") verdict = "Quarantined";
    else if (now() >= eff(l)) verdict = "PastUseBy";
    else if (S.sold.has(`${l.id}|${serial}`)) verdict = "GenuineAlreadySold";
    else verdict = "Genuine";
    return { verdict, gtin: l.gtin, lot: l.lot, species: l.species, vesselName: c.vesselName, lat: c.lat, lon: c.lon, caughtAt: c.caughtAt,
      effectiveUseBy: eff(l), abuseScore: l.abuseScore, dnaVerified: l.dnaVerified, frozen: l.frozen, processor: l.processor };
  };

  B.declareCatch = ({ weightKg, lat, lon }) => tx("processor", `Declare ${weightKg} kg YFT at ${lat}, ${lon}`, "declareCatch",
    () => _declareCatch("processor", S.roles.vessel.address, { species: "YFT", weightKg, lat, lon, caughtAt: now() - 6 * 3600, nonce: S.vessel.lastNonce + 1 }));
  B.createLot = (f) => tx("processor", `Pack lot ${f.lot}`, "createLot", () => _createLot("processor", f));
  B.ship = (l, from, to) => tx(from, `Ship ${l.lot} to ${ORG[to]}`, "initiateTransfer", () => _ship(from, l.id, to));
  B.accept = (l, role) => tx(role, `Accept ${l.lot}`, "acceptTransfer", () => _accept(role, l.id));
  B.cancel = (l, role) => tx(role, `Cancel shipment of ${l.lot}`, "cancelTransfer", () => _cancel(role, l.id));
  B.trip = async (l, peak, minutesOut) => {
    const holder = B.roleOf(l.custodian);
    const logger = await sha(`logger-${Math.random()}`);
    await tx(holder, `Fit logger to ${l.lot}`, "bindSensor", () => _bind(holder, l.id, logger.slice(0, 42)));
    const t0 = now(), range = l.maxTemp - l.minTemp, outW = Math.min(3, Math.ceil(minutesOut / 15));
    for (let i = 0; i < 3; i++) {
      const hot = outW > 0 && i >= 3 - outW;
      const t = { lotId: l.id, windowStart: t0 - 2700 + i * 900, windowEnd: t0 - 1800 + i * 900,
        minTempDeci: Math.round((hot ? l.maxTemp - 1 : l.maxTemp - range * 0.6) * 10) + i, maxTempDeci: Math.round((hot ? peak : l.maxTemp - range * 0.25) * 10) + i, nonce: i + 1 };
      await tx("oracle", `Temperature window ${i + 1} of 3 (${t.minTempDeci / 10} to ${t.maxTempDeci / 10} °C)`, "recordTelemetry", () => _telemetry("oracle", logger.slice(0, 42), t));
    }
  };
  B.dnaTest = (l, ok) => tx("inspector", `DNA result for ${l.lot}`, "recordSpeciesTest", () => _dna("inspector", l.id, ok));
  B.quarantine = (l) => tx("inspector", `Quarantine ${l.lot}`, "quarantine", () => _quarantine("inspector", l.id));
  B.release = (l) => tx("inspector", `Release ${l.lot}`, "releaseFromQuarantine", () => _release("inspector", l.id));
  B.recall = (l, role) => tx(role, `Recall ${l.lot}`, "recall", () => _recall(role, l.id));
  B.sell = (l, serial) => tx("retailer", `Sell ${serial}`, "sell", () => _sell("retailer", l.id, serial));
  B.suspendVessel = () => tx("regulator", "Suspend vessel licence", "suspendVessel", () => { S.vessel.active = false; emit("VesselSuspended", "vessel", {}); });
  B.relicenseVessel = () => tx("regulator", "Reinstate vessel licence", "registerVessel", () => { S.vessel.active = true; emit("VesselRegistered", "vessel", {}); });

  B.renderLedger = function (el) {
    if (!el) return;
    el.innerHTML = S.blocks.slice().reverse().slice(0, 60).map((b) => `<div class="block">
      <div class="hd"><span>Block #${b.height}</span><span class="pill">${b.fn}</span></div>
      <div class="muted">${new Date(b.at * 1000).toISOString().replace("T", " ").slice(0, 19)} UTC · proposer <strong>${b.proposer}</strong> · from ${ORG[b.from] || b.from}</div>
      <div>${b.summary}</div>
      <div class="mono">hash ${b.hash}</div><div class="mono muted">prev ${b.prev}</div>
      <div class="sigs" title="QBFT commit seals: a block is final once 5 of 7 validators (2f+1, f = 2) have signed">${VALIDATORS.map((v, i) => `<span class="${b.signed[i] ? "" : "off"}">${v}</span>`).join("")}</div>
    </div>`).join("");
  };

  // ---- Seed: the same story deploy-live.js writes to Sepolia ------------------------
  async function seed() {
    const t = now();
    S.vessel = { address: S.roles.vessel.address, name: "FV Albacora Star (fictional)", licenceNo: "MU-LL-0042", licenceExpiry: t + 3 * 365 * DAY, active: true, lastNonce: 0 };
    await seal("deploy", "regulator", "TunaTrace deployed; roles granted to six consortium members");
    await seal("registerVessel", "regulator", "Licensed FV Albacora Star (MU-LL-0042) for the zone 16–24° S, 53–62° E");
    await seal("addProtectedArea", "regulator", "Marine park declared as a no-take zone");
    const q = (fn) => fn();
    const cid = await q(async () => { let id; await tx("processor", "Declare 600 kg YFT at -19.2514, 58.1032", "declareCatch", () => { id = _declareCatch("processor", S.vessel.address, { species: "YFT", weightKg: 600, lat: -19.2514, lon: 58.1032, caughtAt: t - 2 * DAY, nonce: 1 }); }); return id; });
    const base = { catchId: cid, rawWeightKg: 60, quantity: 100, packGrams: 300, frozen: true, useBy: t - 2 * DAY + 540 * DAY, minTemp: -65, maxTemp: -45, criticalTemp: -18, abuseBudget: 3000, shelfLifePenaltySec: 600 };
    for (const lot of ["YFT-ULT-2610-A", "YFT-ULT-2610-B"]) await tx("processor", `Pack lot ${lot}`, "createLot", () => _createLot("processor", { ...base, lot }));
    const ids = { A: B.lotIdOf(GTIN.frozen, "YFT-ULT-2610-A"), Bb: B.lotIdOf(GTIN.frozen, "YFT-ULT-2610-B") };
    const plan = { A: [[-588, -561], [-579, -552], [-556, -410], [-581, -560]], Bb: [[-585, -560], [-470, -380], [-380, -300], [-300, -260]] };
    for (const k of ["A", "Bb"]) {
      const logger = `logger-${k}`;
      await tx("processor", "Fit logger", "bindSensor", () => _bind("processor", ids[k], logger));
      await tx("processor", "Ship to distributor", "initiateTransfer", () => _ship("processor", ids[k], "distributor"));
      for (let i = 0; i < 4; i++) {
        await tx("oracle", `Window ${i + 1}`, "recordTelemetry", () => _telemetry("oracle", logger, { lotId: ids[k], windowStart: t - 3600 + i * 900, windowEnd: t - 2700 + i * 900, minTempDeci: plan[k][i][0], maxTempDeci: plan[k][i][1], nonce: i + 1 }));
      }
    }
    await tx("inspector", "DNA confirmed", "recordSpeciesTest", () => _dna("inspector", ids.A, true));
    await tx("distributor", "Accept", "acceptTransfer", () => _accept("distributor", ids.A));
    await tx("distributor", "Ship to retailer", "initiateTransfer", () => _ship("distributor", ids.A, "retailer"));
    await tx("retailer", "Accept", "acceptTransfer", () => _accept("retailer", ids.A));
    await tx("retailer", "Sell TT0042", "sell", () => _sell("retailer", ids.A, "TT0042"));
  }
  return B;
};

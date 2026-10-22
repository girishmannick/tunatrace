// -----------------------------------------------------------------------------
// TunaTrace live back-end: talks to the deployed TunaTrace contract.
// Reads go through a public RPC endpoint. Writes are signed by the demo wallets
// created by scripts/deploy-live.js (test ETH only), so visitors need no wallet.
// The vessel's VMS key only signs EIP-712 catch declarations; it never pays gas.
// -----------------------------------------------------------------------------
window.TT_LIVE_BACKEND = function () {
  const D = window.TUNATRACE_DEPLOYMENT;
  const STATUS = ["None", "Packed", "InTransit", "Received", "Quarantined", "Recalled", "SoldOut"];
  const VERDICT = ["Genuine", "GenuineAlreadySold", "UnknownSerial", "UnknownLot", "Recalled", "Quarantined", "PastUseBy"];
  const short = (h) => (h && h.length > 14 ? h.slice(0, 8) + "…" + h.slice(-4) : h);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const TELEMETRY_TYPES = { Telemetry: [
    { name: "lotId", type: "bytes32" }, { name: "windowStart", type: "uint64" }, { name: "windowEnd", type: "uint64" },
    { name: "minTempDeci", type: "int16" }, { name: "maxTempDeci", type: "int16" }, { name: "readingsRoot", type: "bytes32" }, { name: "nonce", type: "uint64" }] };
  const CATCH_TYPES = { CatchDeclaration: [
    { name: "species", type: "string" }, { name: "weightKg", type: "uint32" }, { name: "latE5", type: "int32" },
    { name: "lonE5", type: "int32" }, { name: "caughtAt", type: "uint64" }, { name: "nonce", type: "uint64" }] };
  const E5 = (d) => Math.round(d * 1e5);
  const zoneE5 = (z) => ({ minLatE5: E5(z.minLat), maxLatE5: E5(z.maxLat), minLonE5: E5(z.minLon), maxLonE5: E5(z.maxLon) });

  let provider, reader, wallets = {}, vesselWallet, domain;
  const orgByAddr = {};
  const B = { mode: "live", onProgress: () => {} };

  // ---- Serial numbers and Merkle proofs (same algorithm as @openzeppelin/merkle-tree) ----
  const serialsFor = (n) => Array.from({ length: n }, (_, i) => `TT${String(i + 1).padStart(4, "0")}`);
  const leafHash = (s) => ethers.keccak256(ethers.keccak256(coder.encode(["string"], [s])));
  const hashPair = (a, b) => ethers.keccak256(ethers.concat(a < b ? [a, b] : [b, a]));
  const treeCache = {};
  function serialTree(qty) {
    if (treeCache[qty]) return treeCache[qty];
    const leaves = serialsFor(qty).map((s) => ({ s, h: leafHash(s) })).sort((x, y) => (x.h < y.h ? -1 : x.h > y.h ? 1 : 0));
    const n = leaves.length, tree = new Array(2 * n - 1), index = {};
    leaves.forEach((l, i) => { tree[tree.length - 1 - i] = l.h; index[l.s] = tree.length - 1 - i; });
    for (let i = tree.length - 1 - n; i >= 0; i--) tree[i] = hashPair(tree[2 * i + 1], tree[2 * i + 2]);
    const proof = (serial) => {
      let i = index[serial]; const p = [];
      if (i === undefined) return [];
      while (i > 0) { p.push(tree[i % 2 === 1 ? i + 1 : i - 1]); i = Math.floor((i - 1) / 2); }
      return p;
    };
    return (treeCache[qty] = { root: tree[0], proof });
  }
  B.lotIdOf = (gtin, lot) => ethers.keccak256(coder.encode(["string", "string"], [gtin, lot]));

  B.init = async function () {
    if (!window.ethers) throw new Error("Could not load the ethers.js library. Check your internet connection and refresh.");
    if (!D) throw new Error("This page is not connected to a contract yet. Run scripts/deploy-live.js first; it creates web/deployment.js.");
    for (const url of D.rpcUrls) {
      try {
        const p = new ethers.JsonRpcProvider(url, D.chainId, { staticNetwork: true, cacheTimeout: -1 });
        await p.getBlockNumber();
        provider = p; break;
      } catch { /* try the next endpoint */ }
    }
    if (!provider) throw new Error("Could not reach the blockchain. Check your internet connection and refresh.");
    reader = new ethers.Contract(D.contract, D.abi, provider);
    for (const [role, w] of Object.entries(D.demoWallets)) {
      if (role === "vessel") vesselWallet = new ethers.Wallet(w.privateKey);
      else wallets[role] = new ethers.Wallet(w.privateKey, provider);
      orgByAddr[w.address.toLowerCase()] = w.org;
    }
    orgByAddr[D.admin.toLowerCase()] = "Consortium administrator";
    domain = { name: "TunaTrace", version: "1", chainId: D.chainId, verifyingContract: D.contract };
    B.roles = D.demoWallets;
    B.zones = { licensed: D.licensedZone, park: D.marinePark };
    B.samples = { gtin: D.gtins.frozen, gtinChilled: D.gtins.chilled, goodLot: D.seededLots.good, badLot: D.seededLots.bad };
  };
  B.orgOf = (a) => orgByAddr[(a || "").toLowerCase()];
  B.roleOf = (a) => Object.keys(D.demoWallets).find((r) => D.demoWallets[r].address.toLowerCase() === (a || "").toLowerCase());
  B.txLink = (h) => (D.explorer ? `<a href="${D.explorer}/tx/${h}" target="_blank" rel="noopener">${short(h)}</a>` : `<span class="mono">${short(h)}</span>`);
  B.addrLink = (a) => (D.explorer ? `<a class="mono" href="${D.explorer}/address/${a}" target="_blank" rel="noopener">${short(a)}</a>` : `<span class="mono">${short(a)}</span>`);
  B.balance = async (role) => wallets[role] ? `${Number(ethers.formatEther(await provider.getBalance(wallets[role].address))).toFixed(4)} test ETH` : null;
  B.chainInfo = async () => `Block ${(await provider.getBlockNumber()).toLocaleString()} · contract ${B.addrLink(D.contract)}`;
  B.verifySource = () => `Read live from contract ${short(D.contract)} on ${D.network === "sepolia" ? "Ethereum Sepolia" : D.network}. Free; no wallet needed.`;

  // ---- Reading -------------------------------------------------------------------
  const lotView = (id, l) => {
    const o = l.toObject();
    const n = (k) => Number(o[k]);
    return {
      id, gtin: o.gtin, lot: o.lot, species: o.species, catchId: o.catchId, rawWeightKg: n("rawWeightKg"), quantity: n("quantity"), sold: n("sold"),
      packGrams: n("packGrams"), frozen: o.frozen, useBy: n("useBy"), minTemp: n("minTempDeci") / 10, maxTemp: n("maxTempDeci") / 10, criticalTemp: n("criticalTempDeci") / 10,
      abuseBudget: n("abuseBudget"), abuseScore: n("abuseScore"), excursionSec: n("excursionSec"), shelfLifeLostSec: n("shelfLifeLostSec"),
      telemetryGaps: n("telemetryGaps"), dnaVerified: o.dnaVerified, processor: o.processor, custodian: o.custodian,
      pendingCustodian: o.pendingCustodian === ethers.ZeroAddress ? null : o.pendingCustodian, status: STATUS[n("status")],
      effectiveUseBy: Math.max(0, n("useBy") - n("shelfLifeLostSec")),
    };
  };
  const vesselNames = {};
  B.load = async function () {
    const [nl, nc] = (await Promise.all([reader.lotCount(), reader.catchCount()])).map(Number);
    const lotIds = await Promise.all(Array.from({ length: nl }, (_, i) => reader.lotIdAt(i)));
    const catchIds = await Promise.all(Array.from({ length: nc }, (_, i) => reader.catchIdAt(i)));
    const lots = await Promise.all(lotIds.map(async (id) => lotView(id, await reader.getLot(id))));
    const catches = await Promise.all(catchIds.map(async (id) => {
      const c = (await reader.getCatch(id)).toObject();
      if (!vesselNames[c.vessel]) vesselNames[c.vessel] = (await reader.getVessel(c.vessel)).name;
      return { id, vessel: c.vessel, vesselName: vesselNames[c.vessel], species: c.species, weightKg: Number(c.weightKg), usedKg: Number(c.usedKg),
        lat: Number(c.latE5) / 1e5, lon: Number(c.lonE5) / 1e5, caughtAt: Number(c.caughtAt) };
    }));
    const v = (await reader.getVessel(D.demoWallets.vessel.address)).toObject();
    const vessel = { name: v.name, licenceNo: v.licenceNo, licenceExpiry: Number(v.licenceExpiry), active: v.active, lastNonce: Number(v.lastNonce) };
    return { lots, catches, vessel };
  };
  const blockTimes = {};
  B.history = async function (lotId, catchId) {
    const latest = await provider.getBlockNumber();
    const logs = [];
    for (let from = D.deployBlock; from <= latest; from += 40000) {
      const to = Math.min(from + 39999, latest);
      for (const topic of [lotId, catchId]) logs.push(...(await provider.getLogs({ address: D.contract, topics: [null, topic], fromBlock: from, toBlock: to })));
    }
    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
    const events = [];
    for (const l of logs) {
      let ev; try { ev = reader.interface.parseLog(l); } catch { continue; }
      if (ev.name === "CatchDeclared" && ev.args.catchId !== catchId) continue;
      if (!blockTimes[l.blockNumber]) blockTimes[l.blockNumber] = (await provider.getBlock(l.blockNumber)).timestamp;
      const args = Object.fromEntries(Object.entries(ev.args.toObject()).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v]));
      events.push({ name: ev.name, args, tx: l.transactionHash, at: blockTimes[l.blockNumber] });
    }
    return events;
  };
  B.verify = async function (gtin, lot, serial) {
    const id = B.lotIdOf(gtin, lot);
    let proof = [];
    try { const l = await reader.getLot(id); proof = serialTree(Number(l.quantity)).proof(serial); } catch { /* unknown lot */ }
    const r = (await reader.verifyPack(id, serial, proof)).toObject();
    return { verdict: VERDICT[Number(r.verdict)], gtin: r.gtin, lot: r.lot, species: r.species, vesselName: r.vesselName, lat: Number(r.latE5) / 1e5, lon: Number(r.lonE5) / 1e5,
      caughtAt: Number(r.caughtAt), effectiveUseBy: Number(r.effectiveUseBy), abuseScore: Number(r.abuseScore), dnaVerified: r.dnaVerified, frozen: r.frozen, processor: r.processor };
  };

  // ---- Writing ---------------------------------------------------------------------
  function decodeError(e) {
    let name = e?.revert?.name;
    if (!name) { try { name = reader.interface.parseError(e?.data)?.name; } catch { /* not a contract error */ } }
    if (name) { const err = new Error(name); err.code = name; return err; }
    return e;
  }
  async function send(role, label, fn, ...args) {
    const c = reader.connect(wallets[role]);
    try { await c[fn].staticCall(...args); } catch (e) { throw decodeError(e); } // dry run first: clear reason, no gas spent
    B.onProgress(`<div><span class="spinner"></span>${label}</div><div>Signing as ${D.demoWallets[role].org}…</div>`);
    let tx;
    for (let attempt = 0; ; attempt++) {
      try {
        const nonce = await provider.getTransactionCount(wallets[role].address, "pending");
        tx = await c[fn](...args, { nonce });
        break;
      } catch (e) {
        // Another visitor may have just used the same demo wallet: wait and retry with a fresh nonce.
        if (attempt < 2 && /nonce|replacement/i.test(e?.message || "")) { await new Promise((r) => setTimeout(r, 4000)); continue; }
        throw decodeError(e);
      }
    }
    B.onProgress(`<div><span class="spinner"></span>${label}</div><div>Sent ${B.txLink(tx.hash)}. Waiting for the next block (about 12 seconds)…</div>`);
    const rc = await tx.wait();
    B.onProgress(`<div>${label}: confirmed in block ${rc.blockNumber}.</div><div>${B.txLink(tx.hash)}</div>`, 9000);
    return rc;
  }

  B.declareCatch = async function ({ weightKg, lat, lon }) {
    const v = await reader.getVessel(vesselWallet.address);
    const now = (await provider.getBlock("latest")).timestamp;
    const c = { species: "YFT", weightKg, latE5: E5(lat), lonE5: E5(lon), caughtAt: now - 6 * 3600, nonce: Number(v.lastNonce) + 1 };
    const sig = await vesselWallet.signTypedData(domain, CATCH_TYPES, c);
    await send("processor", `Declare ${weightKg} kg YFT caught at ${lat}, ${lon}`, "declareCatch", c, sig);
  };
  B.createLot = async function (f) {
    const input = {
      gtin: f.frozen ? D.gtins.frozen : D.gtins.chilled, lot: f.lot, catchId: f.catchId, rawWeightKg: f.rawWeightKg, quantity: f.quantity,
      packGrams: f.packGrams, frozen: f.frozen, useBy: f.useBy, minTempDeci: Math.round(f.minTemp * 10), maxTempDeci: Math.round(f.maxTemp * 10),
      criticalTempDeci: Math.round(f.criticalTemp * 10), abuseBudget: f.abuseBudget, shelfLifePenaltySec: f.shelfLifePenaltySec,
      serialRoot: serialTree(f.quantity).root, docsCid: "not uploaded (live demo)",
    };
    await send("processor", `Pack lot ${f.lot}`, "createLot", input);
  };
  B.ship = (l, from, to) => send(from, `Ship ${l.lot} to ${D.demoWallets[to].org}`, "initiateTransfer", l.id, D.demoWallets[to].address, ethers.id(`DN|${l.lot}|${from}->${to}|${Date.now()}`));
  B.accept = (l, role) => send(role, `Accept ${l.lot}`, "acceptTransfer", l.id);
  B.cancel = (l, role) => send(role, `Cancel shipment of ${l.lot}`, "cancelTransfer", l.id);
  B.trip = async function (l, peak, minutesOut) {
    const holder = B.roleOf(l.custodian);
    if (!holder || holder === "vessel") throw new Error("The current holder is not one of the demo organisations.");
    const logger = ethers.Wallet.createRandom();
    await send(holder, `Fit a new temperature logger to ${l.lot}`, "bindSensor", l.id, logger.address);
    const now = (await provider.getBlock("latest")).timestamp;
    const range = l.maxTemp - l.minTemp;
    const outWindows = Math.min(3, Math.ceil(minutesOut / 15));
    for (let i = 0; i < 3; i++) {
      const hot = outWindows > 0 && i >= 3 - outWindows;
      const t = {
        lotId: l.id, windowStart: now - 2700 + i * 900, windowEnd: now - 1800 + i * 900,
        minTempDeci: Math.round((hot ? l.maxTemp - 1 : l.maxTemp - range * 0.6) * 10) + i,
        maxTempDeci: Math.round((hot ? peak : l.maxTemp - range * 0.25) * 10) + i,
        readingsRoot: ethers.id(`${l.lot}-${now}-${i}`), nonce: i + 1,
      };
      const sig = await logger.signTypedData(domain, TELEMETRY_TYPES, t);
      await send("oracle", `Temperature window ${i + 1} of 3 (${t.minTempDeci / 10} to ${t.maxTempDeci / 10} °C)`, "recordTelemetry", t, sig);
    }
  };
  B.dnaTest = (l, ok) => send("inspector", `Record DNA result for ${l.lot}`, "recordSpeciesTest", l.id, ok, `dna-report-${Date.now()}`);
  B.quarantine = (l) => send("inspector", `Quarantine ${l.lot}`, "quarantine", l.id, "Inspection finding");
  B.release = (l) => send("inspector", `Release ${l.lot}`, "releaseFromQuarantine", l.id, `histamine-assessment-${Date.now()}`);
  B.recall = (l, role) => send(role, `Recall ${l.lot}`, "recall", l.id, "Recall issued from the live demo");
  B.sell = (l, serial) => send("retailer", `Sell ${serial}`, "sell", l.id, serial, serialTree(l.quantity).proof(serial));
  B.suspendVessel = () => send("regulator", `Suspend vessel licence`, "suspendVessel", vesselWallet.address, "Placed on IUU vessel list (demo)");
  B.relicenseVessel = async () => {
    const v = await reader.getVessel(vesselWallet.address);
    await send("regulator", `Reinstate vessel licence`, "registerVessel", vesselWallet.address, v.name, v.licenceNo, v.licenceExpiry, zoneE5(D.licensedZone));
  };
  return B;
};

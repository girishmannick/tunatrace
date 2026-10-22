/**
 * End-to-end simulation of the TunaTrace pipeline on a local PoA-style chain.
 *
 *   npx hardhat run scripts/simulate.js
 *
 * Scenario: a longliner lands 420 kg of yellowfin tuna. The processor cuts and
 * vacuum-packs two lots of 250 g loin steaks. Both travel by reefer truck to a
 * distributor's cold store; lot A has a short door-open spike that stays
 * within its abuse budget, lot B suffers a refrigeration-unit failure and is
 * quarantined automatically. Lot A is DNA-verified, reaches the supermarket,
 * a pack is sold and checked by a shopper. Three fraud attempts are made and
 * rejected along the way. Writes reports/simulation.json.
 * All organisation and vessel names are fictional.
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { StandardMerkleTree } = require("@openzeppelin/merkle-tree");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { simulateReadings, aggregateWindows, signWindow, proveReading } = require("../oracle/gateway");
const { signCatch, zone } = require("../oracle/vms");
const { LocalPinStore, encryptForConsortium } = require("../offchain/ipfs");

const { ethers } = hre;
const VERDICTS = ["Genuine", "GenuineAlreadySold", "UnknownSerial", "UnknownLot", "Recalled", "Quarantined", "PastUseBy"];
const STATUS = ["None", "Packed", "InTransit", "Received", "Quarantined", "Recalled", "SoldOut"];
const DAY = 86400;

async function main() {
  const [regulator, processor, distributor, retailer, gateway, lab] = await ethers.getSigners();
  const actors = {
    regulator: { name: "Fisheries Competent Authority (fictional)", address: regulator.address },
    processor: { name: "Port Louis Ocean Foods Ltd (fictional)", address: processor.address },
    distributor: { name: "IslandCold Logistics (fictional)", address: distributor.address },
    retailer: { name: "Lagoon Fresh Market (fictional)", address: retailer.address },
    gateway: { name: "IoT oracle gateway", address: gateway.address },
    lab: { name: "Marine Food Lab (fictional, ISO 17025)", address: lab.address },
  };
  const gas = {};
  const record = async (label, txPromise) => {
    const rc = await (await txPromise).wait();
    gas[label] = gas[label] || [];
    gas[label].push(Number(rc.gasUsed));
    return rc;
  };
  const rejected = async (fn) => {
    try { await fn(); return "ACCEPTED (unexpected)"; } catch (e) {
      const m = /custom error '(\w+)\(/.exec(e.message || "");
      return `Rejected: ${e.revert?.name || (m && m[1]) || e.shortMessage || e.message}`;
    }
  };

  // ---- Deploy and onboard consortium members ---------------------------------
  const tt = await (await ethers.getContractFactory("TunaTrace")).deploy(regulator.address);
  const deployRc = await tt.deploymentTransaction().wait();
  gas.deploy = [Number(deployRc.gasUsed)];
  for (const [role, acct] of [["PROCESSOR_ROLE", processor], ["DISTRIBUTOR_ROLE", distributor], ["RETAILER_ROLE", retailer], ["ORACLE_ROLE", gateway], ["INSPECTOR_ROLE", lab]]) {
    await record("grantRole", tt.grantRole(await tt[role](), acct.address));
  }

  // ---- Fishing authority: vessel licence and a marine park -------------------
  const vessel = ethers.Wallet.createRandom();
  const now0 = await time.latest();
  const licensedZone = { minLat: -24, maxLat: -16, minLon: 53, maxLon: 62 };
  const marinePark = { minLat: -20.47, maxLat: -20.42, minLon: 57.69, maxLon: 57.74 };
  await record("registerVessel", tt.registerVessel(vessel.address, "FV Albacora Star (fictional)", "MU-LL-0042", now0 + 300 * DAY, zone(licensedZone)));
  await record("addProtectedArea", tt.addProtectedArea(zone(marinePark)));

  // ---- Landing: signed catch declaration from the vessel's VMS ----------------
  const catchDecl = { species: "YFT", weightKg: 420, lat: -19.2514, lon: 58.1032, caughtAt: now0 - 1 * DAY, nonce: 1 };
  const { c, sig } = await signCatch(tt, vessel, catchDecl);
  await record("declareCatch", tt.connect(processor).declareCatch(c, sig));
  const catchId = await tt.catchIdOf(vessel.address, 1);

  // Fraud attempt 1: an unlicensed boat forges a declaration
  const pirate = ethers.Wallet.createRandom();
  const forged = await signCatch(tt, pirate, { ...catchDecl, nonce: 2 });
  // Fraud attempt 2: the licensed vessel fished inside the marine park
  const inPark = await signCatch(tt, vessel, { ...catchDecl, lat: -20.445, lon: 57.712, nonce: 2 });
  const attacks = {
    forgedCatchFromUnlicensedVessel: await rejected(() => tt.connect(processor).declareCatch.staticCall(forged.c, forged.sig)),
    catchInsideMarinePark: await rejected(() => tt.connect(processor).declareCatch.staticCall(inPark.c, inPark.sig)),
    replayedCatchDeclaration: await rejected(() => tt.connect(processor).declareCatch.staticCall(c, sig)),
  };

  // ---- Off-chain documents -> IPFS CIDs ---------------------------------------
  const ipfs = new LocalPinStore();
  const catchCert = Buffer.from(JSON.stringify({
    doc: "Catch certificate (EU Reg. 1005/2008 format)", vessel: "FV Albacora Star", licence: "MU-LL-0042", flag: "MU",
    species: "Thunnus albacares (YFT)", gear: "Drifting longline", area: "FAO 51 - Western Indian Ocean", landedKg: 420,
  }));
  const healthCert = Buffer.from(JSON.stringify({ doc: "Health certificate", establishment: "MU-PP-017", haccp: "Approved", histamineAtIntake_ppm: 4 }));
  const { key: certKey, payload: certEnc } = encryptForConsortium(Buffer.concat([catchCert, healthCert]));
  const docsCid = await ipfs.add(certEnc);

  // ---- Processing: two lots of 200 vacuum packs (250 g loin steaks) ------------
  const serials = Array.from({ length: 200 }, (_, i) => `TT${String(500000 + i)}`);
  const tree = StandardMerkleTree.of(serials.map((s) => [s]), ["string"]);
  const now = await time.latest();
  const base = {
    gtin: "06099999000010", catchId, rawWeightKg: 90, quantity: serials.length, packGrams: 250, frozen: false,
    useBy: catchDecl.caughtAt + 12 * DAY, minTempDeci: 0, maxTempDeci: 40, criticalTempDeci: 100,
    abuseBudget: 600, shelfLifePenaltySec: 120, serialRoot: tree.root, docsCid,
  };
  const good = { ...base, lot: "YFT-2026-1019-A" };
  const bad = { ...base, lot: "YFT-2026-1019-B" };
  await record("createLot", tt.connect(processor).createLot(good));
  await record("createLot", tt.connect(processor).createLot(bad));
  const goodId = await tt.lotIdOf(good.gtin, good.lot);
  const badId = await tt.lotIdOf(bad.gtin, bad.lot);

  // Fraud attempt 3: launder extra (illegal) fish under the same legal catch
  attacks.launderingBeyondCatchWeight = await rejected(() => tt.connect(processor).createLot.staticCall({ ...base, lot: "YFT-2026-1019-X", rawWeightKg: 300 }));
  attacks.implausibleYield = await rejected(() => tt.connect(processor).createLot.staticCall({ ...base, lot: "YFT-2026-1019-Y", rawWeightKg: 50, quantity: 200 }));

  // ---- Bind data-loggers -------------------------------------------------------
  const loggerA = ethers.Wallet.createRandom();
  const loggerB = ethers.Wallet.createRandom();
  await record("bindSensor", tt.connect(processor).bindSensor(goodId, loggerA.address));
  await record("bindSensor", tt.connect(processor).bindSensor(badId, loggerB.address));

  // ---- Hand-over 1: Processor -> Distributor (delivery note) ------------------
  const dn1 = Buffer.from(JSON.stringify({ doc: "Delivery note", from: actors.processor.name, to: actors.distributor.name, lot: good.lot, packs: 200, truck: "Reefer MU-4471" }));
  const dn1Cid = await ipfs.add(dn1);
  await record("initiateTransfer", tt.connect(processor).initiateTransfer(goodId, distributor.address, ethers.keccak256(dn1)));
  await record("initiateTransfer", tt.connect(processor).initiateTransfer(badId, distributor.address, ethers.keccak256(dn1)));

  // ---- Six-hour reefer leg and cold-store: telemetry --------------------------
  const tripStart = Math.floor((await time.latest()) / 900) * 900 + 900;
  const readingsA = simulateReadings({ start: tripStart, minutes: 360, excursions: [{ from: 150, to: 162, base: 4.0, peak: 5.1 }] });
  const readingsB = simulateReadings({ start: tripStart, minutes: 360, seed: 7, excursions: [{ from: 190, to: 255, base: 4.2, peak: 9.6 }] });
  const winA = aggregateWindows(readingsA);
  const winB = aggregateWindows(readingsB);
  const telemetry = { A: [], B: [] };
  let quarantinedAtWindow = null;
  for (let i = 0; i < winA.length; i++) {
    await time.increaseTo(winA[i].windowEnd);
    const a = await signWindow(tt, loggerA, goodId, winA[i], i + 1);
    await record("recordTelemetry", tt.connect(gateway).recordTelemetry(a.t, a.sig));
    const b = await signWindow(tt, loggerB, badId, winB[i], i + 1);
    const rc = await record("recordTelemetry", tt.connect(gateway).recordTelemetry(b.t, b.sig));
    if (quarantinedAtWindow === null && rc.logs.some((l) => { try { return tt.interface.parseLog(l).name === "LotQuarantined"; } catch { return false; } })) quarantinedAtWindow = i;
    telemetry.A.push({ start: winA[i].windowStart, min: winA[i].minTempDeci / 10, max: winA[i].maxTempDeci / 10 });
    telemetry.B.push({ start: winB[i].windowStart, min: winB[i].minTempDeci / 10, max: winB[i].maxTempDeci / 10 });
  }
  const rawLogCid = await ipfs.add(Buffer.from(JSON.stringify(readingsA)));
  // Auditor re-checks one raw minute against the on-chain window root
  const spikeWin = winA.find((w) => w.maxTempDeci === Math.max(...winA.map((x) => x.maxTempDeci)));
  const spikeMinute = spikeWin.raw.find((r) => r.tempDeci === spikeWin.maxTempDeci);
  const minuteProof = proveReading(spikeWin, spikeMinute.ts);
  const auditOk = StandardMerkleTree.verify(minuteProof.root, ["uint64", "int16"], minuteProof.value, minuteProof.proof);

  await record("acceptTransfer", tt.connect(distributor).acceptTransfer(goodId));
  const badAcceptBlocked = (await rejected(() => tt.connect(distributor).acceptTransfer.staticCall(badId))) .startsWith("Rejected");

  // ---- Species authenticity (DNA barcoding of a sample from lot A) ------------
  const dnaReport = Buffer.from(JSON.stringify({ lab: actors.lab.name, method: "COI barcoding", result: "Thunnus albacares, 99.8% identity", lot: good.lot }));
  const dnaCid = await ipfs.add(dnaReport);
  await record("recordSpeciesTest", tt.connect(lab).recordSpeciesTest(goodId, true, dnaCid));

  // ---- Hand-over 2: Distributor -> Retailer ------------------------------------
  const dn2 = Buffer.from(JSON.stringify({ doc: "Delivery note", from: actors.distributor.name, to: actors.retailer.name, lot: good.lot }));
  await record("initiateTransfer", tt.connect(distributor).initiateTransfer(goodId, retailer.address, ethers.keccak256(dn2)));
  await time.increase(3600);
  await record("acceptTransfer", tt.connect(retailer).acceptTransfer(goodId));

  // ---- Point of sale and shopper scans ------------------------------------------
  const scanned = serials[117];
  const proof = tree.getProof([scanned]);
  const beforeSale = await tt.verifyPack(goodId, scanned, proof);
  await record("sell", tt.connect(retailer).sell(goodId, scanned, proof));
  const afterSale = await tt.verifyPack(goodId, scanned, proof);
  const counterfeit = await tt.verifyPack(goodId, "TT999999", proof);
  const quarantinedPack = await tt.verifyPack(badId, serials[3], tree.getProof([serials[3]]));
  const verifyGas = await tt.verifyPack.estimateGas(goodId, scanned, proof);

  // ---- Integrity check of an off-chain document --------------------------------
  const tamperedDn = Buffer.from(dn1.toString().replace("\"packs\":200", "\"packs\":260"));
  const log = await tt.getCustodyLog(goodId);
  const docIntegrity = {
    originalMatchesLedger: ethers.keccak256(dn1) === log[1].handoverDocHash,
    tamperedMatchesLedger: ethers.keccak256(tamperedDn) === log[1].handoverDocHash,
  };

  const g = await tt.getLot(goodId);
  const b = await tt.getLot(badId);
  const cat = await tt.getCatch(catchId);
  const avg = (xs) => Math.round(xs.reduce((s, x) => s + x, 0) / xs.length);
  const iso = (s) => new Date(Number(s) * 1000).toISOString();
  const shopper = (r) => ({ verdict: VERDICTS[Number(r.verdict)], species: r.species, vessel: r.vesselName, lat: Number(r.latE5) / 1e5, lon: Number(r.lonE5) / 1e5, caughtAt: iso(r.caughtAt), effectiveUseBy: iso(r.effectiveUseBy), abuseScore: Number(r.abuseScore), dnaVerified: r.dnaVerified });
  const out = {
    generatedAt: new Date().toISOString(),
    network: { chainId: Number((await ethers.provider.getNetwork()).chainId), note: "Hardhat EVM standing in for a QBFT consortium chain" },
    actors,
    contract: await tt.getAddress(),
    vessel: { name: "FV Albacora Star (fictional)", key: vessel.address, licence: "MU-LL-0042", licensedZone, marinePark },
    catch: { id: catchId, species: cat.species, weightKg: Number(cat.weightKg), usedKg: Number(cat.usedKg), lat: catchDecl.lat, lon: catchDecl.lon, caughtAt: iso(cat.caughtAt) },
    documents: { catchAndHealthCertCid: docsCid, certKeyFingerprint: ethers.keccak256(certKey).slice(0, 18), deliveryNoteCid: dn1Cid, rawSensorLogCid: rawLogCid, dnaReportCid: dnaCid },
    serialisation: { packsPerLot: serials.length, merkleRoot: tree.root, proofLength: proof.length },
    lots: {
      good: { id: goodId, lot: good.lot, status: STATUS[Number(g.status)], abuseScore: Number(g.abuseScore), excursionSec: Number(g.excursionSec), shelfLifeLostHours: Number(g.shelfLifeLostSec) / 3600, sold: Number(g.sold), dnaVerified: g.dnaVerified, custodian: g.custodian },
      bad: { id: badId, lot: bad.lot, status: STATUS[Number(b.status)], abuseScore: Number(b.abuseScore), excursionSec: Number(b.excursionSec), shelfLifeLostHours: Number(b.shelfLifeLostSec) / 3600, quarantinedAtWindow, downstreamAcceptBlocked: badAcceptBlocked },
    },
    attacks,
    verification: {
      beforeSale: shopper(beforeSale),
      afterSale: VERDICTS[Number(afterSale.verdict)],
      counterfeitSerial: VERDICTS[Number(counterfeit.verdict)],
      quarantinedLotPack: VERDICTS[Number(quarantinedPack.verdict)],
      verifyPackGasIfOnChain: Number(verifyGas),
    },
    audit: { spikeMinute: { ts: iso(spikeMinute.ts), tempC: spikeMinute.tempDeci / 10 }, merkleProofLength: minuteProof.proof.length, provenAgainstOnChainRoot: auditOk },
    docIntegrity,
    telemetry,
    gas: Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, { calls: v.length, avg: avg(v), min: Math.min(...v), max: Math.max(...v) }])),
  };
  fs.mkdirSync(path.join(__dirname, "..", "reports"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "reports", "simulation.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ...out, telemetry: `${telemetry.A.length} windows per lot` }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

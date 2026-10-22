const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { StandardMerkleTree } = require("@openzeppelin/merkle-tree");
const { signWindow } = require("../oracle/gateway");
const { signCatch, zone } = require("../oracle/vms");

const Status = { None: 0n, Packed: 1n, InTransit: 2n, Received: 3n, Quarantined: 4n, Recalled: 5n, SoldOut: 6n };
const Verdict = { Genuine: 0n, GenuineAlreadySold: 1n, UnknownSerial: 2n, UnknownLot: 3n, Recalled: 4n, Quarantined: 5n, PastUseBy: 6n };

const GTIN = "06099999000010";
const LOT = "YFT-2026-1021-A";
const SERIALS = Array.from({ length: 8 }, (_, i) => `TT${String(100000 + i)}`);
const DAY = 24 * 3600;

// Licensed zone: a box over the Mauritius EEZ (illustrative). Protected area: a coastal marine park.
const LICENSED = zone({ minLat: -24, maxLat: -16, minLon: 53, maxLon: 62 });
const MARINE_PARK = zone({ minLat: -20.47, maxLat: -20.42, minLon: 57.69, maxLon: 57.74 });

async function deployFixture() {
  const [regulator, processor, distributor, distributor2, retailer, gateway, lab, outsider] = await ethers.getSigners();
  const vessel = ethers.Wallet.createRandom();
  const rogueVessel = ethers.Wallet.createRandom();
  const sensor = ethers.Wallet.createRandom();
  const rogueSensor = ethers.Wallet.createRandom();

  const tt = await (await ethers.getContractFactory("TunaTrace")).deploy(regulator.address);
  await tt.grantRole(await tt.PROCESSOR_ROLE(), processor.address);
  await tt.grantRole(await tt.DISTRIBUTOR_ROLE(), distributor.address);
  await tt.grantRole(await tt.DISTRIBUTOR_ROLE(), distributor2.address);
  await tt.grantRole(await tt.RETAILER_ROLE(), retailer.address);
  await tt.grantRole(await tt.ORACLE_ROLE(), gateway.address);
  await tt.grantRole(await tt.INSPECTOR_ROLE(), lab.address);

  const now = await time.latest();
  await tt.registerVessel(vessel.address, "FV Albacora Star (fictional)", "MU-LL-0042", now + 365 * DAY, LICENSED);
  await tt.addProtectedArea(MARINE_PARK);

  const tree = StandardMerkleTree.of(SERIALS.map((s) => [s]), ["string"]);
  return { tt, regulator, processor, distributor, distributor2, retailer, gateway, lab, outsider, vessel, rogueVessel, sensor, rogueSensor, tree };
}

const catchAt = (now, over = {}) => ({ species: "YFT", weightKg: 400, lat: -19.25, lon: 58.1, caughtAt: now - 2 * DAY, nonce: 1, ...over });

async function caughtFixture() {
  const f = await deployFixture();
  const now = await time.latest();
  const { c, sig } = await signCatch(f.tt, f.vessel, catchAt(now));
  await f.tt.connect(f.processor).declareCatch(c, sig);
  const catchId = await f.tt.catchIdOf(f.vessel.address, 1);
  const input = {
    gtin: GTIN,
    lot: LOT,
    catchId,
    rawWeightKg: 60,
    quantity: SERIALS.length,
    packGrams: 250, // 8 x 250 g = 2 kg, well within a 70 % yield of 60 kg
    frozen: false, // chilled product class
    useBy: now + 7 * DAY,
    minTempDeci: 0, // 0.0 C
    maxTempDeci: 40, // 4.0 C
    criticalTempDeci: 100, // 10.0 C
    abuseBudget: 600, // e.g. 2 C above the limit for 30 minutes
    shelfLifePenaltySec: 120, // each deci-degree-minute of abuse costs 2 minutes of shelf life
    serialRoot: f.tree.root,
    docsCid: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
  };
  const lotId = await f.tt.lotIdOf(GTIN, LOT);
  return { ...f, catchId, input, lotId, now };
}

async function packedFixture() {
  const f = await caughtFixture();
  await f.tt.connect(f.processor).createLot(f.input);
  return f;
}

async function atRetailerFixture() {
  const f = await packedFixture();
  const { tt, processor, distributor, retailer, lotId } = f;
  await tt.connect(processor).initiateTransfer(lotId, distributor.address, ethers.id("delivery-note-1"));
  await tt.connect(distributor).acceptTransfer(lotId);
  await tt.connect(distributor).initiateTransfer(lotId, retailer.address, ethers.id("delivery-note-2"));
  await tt.connect(retailer).acceptTransfer(lotId);
  return f;
}

async function window(tt, sensor, lotId, { start, end, min, max, nonce }) {
  return signWindow(tt, sensor, lotId, { windowStart: start, windowEnd: end, minTempDeci: min, maxTempDeci: max, readingsRoot: ethers.id(`readings-${nonce}`) }, nonce);
}

describe("TunaTrace", function () {
  // ---------------------------------------------------------------------------
  describe("Vessel registry and origin oracle (anti-IUU)", function () {
    it("lets only the regulator register vessels and protected areas", async function () {
      const { tt, outsider, vessel } = await loadFixture(deployFixture);
      const now = await time.latest();
      await expect(tt.connect(outsider).registerVessel(outsider.address, "X", "Y", now + DAY, LICENSED)).to.be.revertedWithCustomError(tt, "AccessControlUnauthorizedAccount");
      await expect(tt.connect(outsider).addProtectedArea(MARINE_PARK)).to.be.revertedWithCustomError(tt, "AccessControlUnauthorizedAccount");
      const v = await tt.getVessel(vessel.address);
      expect(v.licenceNo).to.equal("MU-LL-0042");
      expect(v.active).to.equal(true);
      expect(await tt.protectedAreaCount()).to.equal(1);
    });

    it("records a catch signed by a licensed vessel inside its zone", async function () {
      const { tt, processor, vessel } = await loadFixture(deployFixture);
      const now = await time.latest();
      const { c, sig } = await signCatch(tt, vessel, catchAt(now));
      const id = await tt.catchIdOf(vessel.address, 1);
      await expect(tt.connect(processor).declareCatch(c, sig)).to.emit(tt, "CatchDeclared").withArgs(id, vessel.address, "YFT", 400, -1925000, 5810000, c.caughtAt);
      const stored = await tt.getCatch(id);
      expect(stored.landedBy).to.equal(processor.address);
      expect(stored.usedKg).to.equal(0);
    });

    it("rejects declarations from unknown keys or with edited fields", async function () {
      const { tt, processor, rogueVessel, vessel } = await loadFixture(deployFixture);
      const now = await time.latest();
      const rogue = await signCatch(tt, rogueVessel, catchAt(now));
      await expect(tt.connect(processor).declareCatch(rogue.c, rogue.sig)).to.be.revertedWithCustomError(tt, "UnknownVessel");
      // Processor inflates the weight after the vessel signed: signature no longer matches the vessel
      const genuine = await signCatch(tt, vessel, catchAt(now));
      await expect(tt.connect(processor).declareCatch({ ...genuine.c, weightKg: 4000 }, genuine.sig)).to.be.revertedWithCustomError(tt, "UnknownVessel");
    });

    it("rejects catches outside the licensed zone or inside a protected area", async function () {
      const { tt, processor, vessel } = await loadFixture(deployFixture);
      const now = await time.latest();
      const outside = await signCatch(tt, vessel, catchAt(now, { lat: -12.0, lon: 58.1 }));
      await expect(tt.connect(processor).declareCatch(outside.c, outside.sig)).to.be.revertedWithCustomError(tt, "OutsideLicensedZone");
      const park = await signCatch(tt, vessel, catchAt(now, { lat: -20.44, lon: 57.71, nonce: 2 }));
      await expect(tt.connect(processor).declareCatch(park.c, park.sig)).to.be.revertedWithCustomError(tt, "InsideProtectedArea");
    });

    it("rejects replayed declarations, suspended vessels and expired licences", async function () {
      const { tt, regulator, processor, vessel } = await loadFixture(deployFixture);
      const now = await time.latest();
      const first = await signCatch(tt, vessel, catchAt(now));
      await tt.connect(processor).declareCatch(first.c, first.sig);
      await expect(tt.connect(processor).declareCatch(first.c, first.sig)).to.be.revertedWithCustomError(tt, "StaleNonce");

      const late = await signCatch(tt, vessel, catchAt(now, { caughtAt: now + 400 * DAY, nonce: 2 }));
      await expect(tt.connect(processor).declareCatch(late.c, late.sig)).to.be.revertedWithCustomError(tt, "LicenceExpired");

      await expect(tt.connect(regulator).suspendVessel(vessel.address, "Listed on IOTC IUU vessel list")).to.emit(tt, "VesselSuspended");
      const next = await signCatch(tt, vessel, catchAt(now, { nonce: 3 }));
      await expect(tt.connect(processor).declareCatch(next.c, next.sig)).to.be.revertedWithCustomError(tt, "VesselInactive");
    });
  });

  // ---------------------------------------------------------------------------
  describe("Processing: lot creation and mass balance", function () {
    it("lets only a processor create a lot, inheriting species and recording genesis custody", async function () {
      const { tt, processor, outsider, input, lotId, catchId } = await loadFixture(caughtFixture);
      await expect(tt.connect(outsider).createLot(input)).to.be.revertedWithCustomError(tt, "AccessControlUnauthorizedAccount");
      await expect(tt.connect(processor).createLot(input)).to.emit(tt, "LotCreated").withArgs(lotId, catchId, processor.address, GTIN, LOT, 8, input.docsCid);
      const l = await tt.getLot(lotId);
      expect(l.status).to.equal(Status.Packed);
      expect(l.species).to.equal("YFT");
      expect(l.custodian).to.equal(processor.address);
      expect((await tt.getCatch(catchId)).usedKg).to.equal(60);
      expect((await tt.getCustodyLog(lotId)).length).to.equal(1);
    });

    it("enforces mass balance: lots can never draw more fish than was caught", async function () {
      const { tt, processor, input } = await loadFixture(packedFixture);
      // 60 kg already used; 340 kg left
      await tt.connect(processor).createLot({ ...input, lot: "B", rawWeightKg: 340 });
      await expect(tt.connect(processor).createLot({ ...input, lot: "C", rawWeightKg: 1 })).to.be.revertedWithCustomError(tt, "MassBalanceExceeded");
    });

    it("rejects implausible yield, implausible freshness claims and bad parameters", async function () {
      const { tt, processor, input, now } = await loadFixture(caughtFixture);
      // 300 packs x 250 g = 75 kg from 60 kg of whole fish: impossible
      await expect(tt.connect(processor).createLot({ ...input, quantity: 300 })).to.be.revertedWithCustomError(tt, "YieldImplausible");
      // A chilled product cannot be sold 30 days after capture
      await expect(tt.connect(processor).createLot({ ...input, useBy: now + 30 * DAY })).to.be.revertedWithCustomError(tt, "ShelfLifeImplausible");
      await expect(tt.connect(processor).createLot({ ...input, minTempDeci: 50 })).to.be.revertedWithCustomError(tt, "InvalidInput");
      await expect(tt.connect(processor).createLot({ ...input, criticalTempDeci: 30 })).to.be.revertedWithCustomError(tt, "InvalidInput");
      await expect(tt.connect(processor).createLot({ ...input, catchId: ethers.id("nope") })).to.be.revertedWithCustomError(tt, "UnknownCatch");
      await tt.connect(processor).createLot(input);
      await expect(tt.connect(processor).createLot(input)).to.be.revertedWithCustomError(tt, "LotExists");
    });

    it("allows a long life only for frozen product held at -18 C or colder", async function () {
      const { tt, processor, input, now, lotId } = await loadFixture(caughtFixture);
      const frozen = { ...input, lot: "FRZ-1", frozen: true, minTempDeci: -650, maxTempDeci: -450, criticalTempDeci: -180, useBy: now + 540 * DAY };
      // Frozen class but a chilled storage range: rejected
      await expect(tt.connect(processor).createLot({ ...frozen, minTempDeci: 0, maxTempDeci: 40, criticalTempDeci: 100 })).to.be.revertedWithCustomError(tt, "InvalidInput");
      // Same 18-month use-by on a chilled lot: rejected
      await expect(tt.connect(processor).createLot({ ...frozen, frozen: false, minTempDeci: 0, maxTempDeci: 40, criticalTempDeci: 100 })).to.be.revertedWithCustomError(tt, "ShelfLifeImplausible");
      await expect(tt.connect(processor).createLot(frozen)).to.emit(tt, "LotCreated");
      const l = await tt.getLot(await tt.lotIdOf(GTIN, "FRZ-1"));
      expect(l.frozen).to.equal(true);
      expect(lotId).to.not.equal(await tt.lotIdOf(GTIN, "FRZ-1"));
    });
  });

  // ---------------------------------------------------------------------------
  describe("Custody hand-over", function () {
    it("follows processor -> distributor -> retailer with a two-step handshake", async function () {
      const { tt, processor, distributor, retailer, lotId } = await loadFixture(packedFixture);
      await expect(tt.connect(processor).initiateTransfer(lotId, distributor.address, ethers.id("DN-1"))).to.emit(tt, "TransferInitiated");
      expect((await tt.getLot(lotId)).status).to.equal(Status.InTransit);
      expect((await tt.getLot(lotId)).custodian).to.equal(processor.address); // not moved until the receiver signs
      await expect(tt.connect(retailer).acceptTransfer(lotId)).to.be.revertedWithCustomError(tt, "NotPendingCustodian");
      await tt.connect(distributor).acceptTransfer(lotId);
      await tt.connect(distributor).initiateTransfer(lotId, retailer.address, ethers.id("DN-2"));
      await tt.connect(retailer).acceptTransfer(lotId);
      const l = await tt.getLot(lotId);
      expect(l.custodian).to.equal(retailer.address);
      expect(l.status).to.equal(Status.Received);
      const log = await tt.getCustodyLog(lotId);
      expect(log.length).to.equal(3);
      expect(log[2].handoverDocHash).to.equal(ethers.id("DN-2"));
    });

    it("blocks skipping a tier, non-custodians and unregistered recipients", async function () {
      const { tt, processor, distributor, retailer, outsider, lotId } = await loadFixture(packedFixture);
      await expect(tt.connect(processor).initiateTransfer(lotId, retailer.address, ethers.ZeroHash)).to.be.revertedWithCustomError(tt, "InvalidRecipient");
      await expect(tt.connect(processor).initiateTransfer(lotId, outsider.address, ethers.ZeroHash)).to.be.revertedWithCustomError(tt, "InvalidRecipient");
      await expect(tt.connect(distributor).initiateTransfer(lotId, retailer.address, ethers.ZeroHash)).to.be.revertedWithCustomError(tt, "NotCustodian");
    });

    it("allows distributor-to-distributor transhipment and cancelling an unaccepted hand-over", async function () {
      const { tt, processor, distributor, distributor2, lotId } = await loadFixture(packedFixture);
      await tt.connect(processor).initiateTransfer(lotId, distributor.address, ethers.ZeroHash);
      await tt.connect(processor).cancelTransfer(lotId);
      expect((await tt.getLot(lotId)).status).to.equal(Status.Packed);
      await expect(tt.connect(distributor).acceptTransfer(lotId)).to.be.revertedWithCustomError(tt, "BadStatus");
      await tt.connect(processor).initiateTransfer(lotId, distributor.address, ethers.ZeroHash);
      await tt.connect(distributor).acceptTransfer(lotId);
      await tt.connect(distributor).initiateTransfer(lotId, distributor2.address, ethers.ZeroHash);
      await tt.connect(distributor2).acceptTransfer(lotId);
      expect((await tt.getLot(lotId)).custodian).to.equal(distributor2.address);
    });

    it("refuses to ship a lot past its use-by date", async function () {
      const { tt, processor, distributor, lotId, input } = await loadFixture(packedFixture);
      await time.increaseTo(input.useBy + 1);
      await expect(tt.connect(processor).initiateTransfer(lotId, distributor.address, ethers.ZeroHash)).to.be.revertedWithCustomError(tt, "PastUseBy");
    });
  });

  // ---------------------------------------------------------------------------
  describe("Cold-chain oracle and time-temperature abuse", function () {
    it("accepts in-range telemetry signed by the bound logger", async function () {
      const { tt, processor, gateway, sensor, lotId } = await loadFixture(packedFixture);
      await tt.connect(processor).bindSensor(lotId, sensor.address);
      const now = await time.latest();
      const { t, sig } = await window(tt, sensor, lotId, { start: now - 900, end: now, min: 8, max: 25, nonce: 1 });
      await expect(tt.connect(gateway).recordTelemetry(t, sig)).to.emit(tt, "TelemetryRecorded").and.not.to.emit(tt, "TemperatureAbuse");
      const l = await tt.getLot(lotId);
      expect(l.abuseScore).to.equal(0);
      expect(await tt.lastTelemetryEnd(lotId)).to.equal(now);
    });

    it("rejects forged signatures, replayed nonces, tampered values and non-gateway callers", async function () {
      const { tt, processor, gateway, outsider, sensor, rogueSensor, lotId } = await loadFixture(packedFixture);
      await tt.connect(processor).bindSensor(lotId, sensor.address);
      const now = await time.latest();
      const forged = await window(tt, rogueSensor, lotId, { start: now - 900, end: now, min: 10, max: 20, nonce: 1 });
      await expect(tt.connect(gateway).recordTelemetry(forged.t, forged.sig)).to.be.revertedWithCustomError(tt, "SensorNotBound");

      const good = await window(tt, sensor, lotId, { start: now - 900, end: now, min: 10, max: 20, nonce: 7 });
      await expect(tt.connect(outsider).recordTelemetry(good.t, good.sig)).to.be.revertedWithCustomError(tt, "AccessControlUnauthorizedAccount");
      await tt.connect(gateway).recordTelemetry(good.t, good.sig);
      await expect(tt.connect(gateway).recordTelemetry(good.t, good.sig)).to.be.revertedWithCustomError(tt, "StaleNonce");
      // The gateway "cools" a hot reading before submitting: the signature breaks
      const hot = await window(tt, sensor, lotId, { start: now - 900, end: now, min: 10, max: 95, nonce: 8 });
      await expect(tt.connect(gateway).recordTelemetry({ ...hot.t, maxTempDeci: 35 }, hot.sig)).to.be.revertedWithCustomError(tt, "SensorNotBound");
    });

    it("accumulates abuse, shortens the use-by date and quarantines when the budget is spent", async function () {
      const { tt, processor, distributor, gateway, sensor, lotId, input } = await loadFixture(packedFixture);
      await tt.connect(processor).bindSensor(lotId, sensor.address);
      await tt.connect(processor).initiateTransfer(lotId, distributor.address, ethers.ZeroHash);
      let now = await time.latest();
      // 15 minutes peaking at 6.0 C: (60-40) x 15 = 300 deci-degree-minutes, within the 600 budget
      const w1 = await window(tt, sensor, lotId, { start: now - 900, end: now, min: 30, max: 60, nonce: 1 });
      await expect(tt.connect(gateway).recordTelemetry(w1.t, w1.sig)).to.emit(tt, "TemperatureAbuse").withArgs(lotId, 300, 300, 300 * 120);
      expect((await tt.getLot(lotId)).status).to.equal(Status.InTransit);
      expect(await tt.effectiveUseBy(lotId)).to.equal(input.useBy - 300 * 120);

      await time.increase(900);
      now = await time.latest();
      // another 15 minutes at 7.0 C: +450 -> 750 > 600 -> quarantine
      const w2 = await window(tt, sensor, lotId, { start: now - 900, end: now, min: 50, max: 70, nonce: 2 });
      await expect(tt.connect(gateway).recordTelemetry(w2.t, w2.sig)).to.emit(tt, "LotQuarantined").withArgs(lotId, "Time-temperature abuse budget exceeded");
      const l = await tt.getLot(lotId);
      expect(l.status).to.equal(Status.Quarantined);
      expect(l.abuseScore).to.equal(750);
      expect(l.excursionSec).to.equal(1800);
      await expect(tt.connect(distributor).acceptTransfer(lotId)).to.be.revertedWithCustomError(tt, "BadStatus");
    });

    it("quarantines immediately when a critical temperature is reached", async function () {
      const { tt, processor, gateway, sensor, lotId } = await loadFixture(packedFixture);
      await tt.connect(processor).bindSensor(lotId, sensor.address);
      const now = await time.latest();
      // Only 1 minute window, so abuse is tiny, but the peak is 12.0 C (>= 10.0 C critical)
      const w = await window(tt, sensor, lotId, { start: now - 60, end: now, min: 30, max: 120, nonce: 1 });
      await expect(tt.connect(gateway).recordTelemetry(w.t, w.sig)).to.emit(tt, "LotQuarantined").withArgs(lotId, "Critical temperature limit reached");
      expect((await tt.getLot(lotId)).abuseScore).to.equal(80);
    });

    it("flags silent periods as telemetry gaps", async function () {
      const { tt, processor, gateway, sensor, lotId } = await loadFixture(packedFixture);
      await tt.connect(processor).bindSensor(lotId, sensor.address);
      await time.increase(4 * 3600);
      const now = await time.latest();
      const a = await window(tt, sensor, lotId, { start: now - 4 * 3600, end: now - 4 * 3600 + 900, min: 10, max: 20, nonce: 1 });
      await tt.connect(gateway).recordTelemetry(a.t, a.sig);
      const b = await window(tt, sensor, lotId, { start: now - 900, end: now, min: 10, max: 20, nonce: 2 });
      await expect(tt.connect(gateway).recordTelemetry(b.t, b.sig)).to.emit(tt, "TelemetryGap");
      expect((await tt.getLot(lotId)).telemetryGaps).to.equal(1);
    });

    it("lets an inspector release a quarantined lot while keeping the abuse on record", async function () {
      const { tt, gateway, lab, outsider, retailer, sensor, lotId, input } = await loadFixture(atRetailerFixture);
      await tt.connect(retailer).bindSensor(lotId, sensor.address);
      const now = await time.latest();
      // 30 minutes at 6.5 C: 25 x 30 = 750 > 600 -> quarantined
      const w = await window(tt, sensor, lotId, { start: now - 1800, end: now, min: 40, max: 65, nonce: 1 });
      await tt.connect(gateway).recordTelemetry(w.t, w.sig);
      expect((await tt.getLot(lotId)).status).to.equal(Status.Quarantined);

      await expect(tt.connect(outsider).releaseFromQuarantine(lotId, "bafy-assess")).to.be.revertedWithCustomError(tt, "AccessControlUnauthorizedAccount");
      await expect(tt.connect(lab).releaseFromQuarantine(lotId, "bafy-histamine-12ppm")).to.emit(tt, "LotReleased");
      const l = await tt.getLot(lotId);
      expect(l.status).to.equal(Status.Received);
      expect(l.abuseScore).to.equal(750); // history is never erased
      expect(l.abuseBudget).to.equal(750 + 600); // a fresh budget for new abuse
      expect(await tt.effectiveUseBy(lotId)).to.equal(input.useBy - 750 * 120); // shelf life stays shortened
      // A physical finding can still quarantine it again
      await tt.connect(lab).quarantine(lotId, "Damaged vacuum seals found on inspection");
      expect((await tt.getLot(lotId)).status).to.equal(Status.Quarantined);
    });
  });

  // ---------------------------------------------------------------------------
  describe("Species authenticity (DNA barcoding)", function () {
    it("marks a lot DNA-verified on a match and quarantines it on substitution", async function () {
      const { tt, processor, lab, input, lotId } = await loadFixture(packedFixture);
      await expect(tt.connect(processor).recordSpeciesTest(lotId, true, "x")).to.be.revertedWithCustomError(tt, "AccessControlUnauthorizedAccount");
      await tt.connect(lab).recordSpeciesTest(lotId, true, "bafy-dna-ok");
      expect((await tt.getLot(lotId)).dnaVerified).to.equal(true);

      await tt.connect(processor).createLot({ ...input, lot: "SUB-1" });
      const subId = await tt.lotIdOf(GTIN, "SUB-1");
      await expect(tt.connect(lab).recordSpeciesTest(subId, false, "bafy-dna-escolar"))
        .to.emit(tt, "LotQuarantined").withArgs(subId, "DNA test: species does not match declaration");
      expect((await tt.getLot(subId)).status).to.equal(Status.Quarantined);
    });
  });

  // ---------------------------------------------------------------------------
  describe("Point of sale and consumer verification", function () {
    it("verifies a genuine pack with its provenance, then flags a second scan", async function () {
      const { tt, retailer, lab, tree, lotId, vessel } = await loadFixture(atRetailerFixture);
      await tt.connect(lab).recordSpeciesTest(lotId, true, "bafy-dna-ok");
      const serial = SERIALS[3];
      const proof = tree.getProof([serial]);
      const info = await tt.verifyPack(lotId, serial, proof);
      expect(info.verdict).to.equal(Verdict.Genuine);
      expect(info.species).to.equal("YFT");
      expect(info.vesselName).to.equal((await tt.getVessel(vessel.address)).name);
      expect(info.latE5).to.equal(-1925000);
      expect(info.dnaVerified).to.equal(true);
      await expect(tt.connect(retailer).sell(lotId, serial, proof)).to.emit(tt, "PackSold");
      expect((await tt.verifyPack(lotId, serial, proof)).verdict).to.equal(Verdict.GenuineAlreadySold);
      await expect(tt.connect(retailer).sell(lotId, serial, proof)).to.be.revertedWithCustomError(tt, "AlreadySold");
    });

    it("detects counterfeit serials and unknown lots", async function () {
      const { tt, retailer, tree, lotId } = await loadFixture(atRetailerFixture);
      const proof = tree.getProof([SERIALS[0]]);
      expect((await tt.verifyPack(lotId, "TT999999", proof)).verdict).to.equal(Verdict.UnknownSerial);
      expect((await tt.verifyPack(ethers.id("fake"), SERIALS[0], proof)).verdict).to.equal(Verdict.UnknownLot);
      await expect(tt.connect(retailer).sell(lotId, "TT999999", proof)).to.be.revertedWithCustomError(tt, "InvalidProof");
    });

    it("propagates a recall to every pack and blocks sales", async function () {
      const { tt, processor, retailer, outsider, tree, lotId } = await loadFixture(atRetailerFixture);
      await expect(tt.connect(outsider).recall(lotId, "x")).to.be.revertedWithCustomError(tt, "NotCustodian");
      await expect(tt.connect(processor).recall(lotId, "Histamine above 50 ppm in retained sample")).to.emit(tt, "LotRecalled");
      const proof = tree.getProof([SERIALS[1]]);
      expect((await tt.verifyPack(lotId, SERIALS[1], proof)).verdict).to.equal(Verdict.Recalled);
      await expect(tt.connect(retailer).sell(lotId, SERIALS[1], proof)).to.be.revertedWithCustomError(tt, "BadStatus");
    });

    it("marks the lot sold out once every pack is sold", async function () {
      const { tt, retailer, tree, lotId } = await loadFixture(atRetailerFixture);
      for (const s of SERIALS) await tt.connect(retailer).sell(lotId, s, tree.getProof([s]));
      const l = await tt.getLot(lotId);
      expect(l.sold).to.equal(8);
      expect(l.status).to.equal(Status.SoldOut);
    });

    it("reports packs past their (abuse-shortened) use-by date", async function () {
      const { tt, gateway, retailer, sensor, tree, lotId, input } = await loadFixture(atRetailerFixture);
      await tt.connect(retailer).bindSensor(lotId, sensor.address);
      const now = await time.latest();
      // 30 minutes at 5.5 C in the shop's display chiller: 15 x 30 = 450 units -> 15 hours lost
      const w = await window(tt, sensor, lotId, { start: now - 1800, end: now, min: 30, max: 55, nonce: 1 });
      await tt.connect(gateway).recordTelemetry(w.t, w.sig);
      const eff = await tt.effectiveUseBy(lotId);
      expect(eff).to.equal(input.useBy - 450 * 120);
      await time.increaseTo(Number(eff) + 1); // before the printed use-by, after the effective one
      expect(Number(eff)).to.be.lessThan(input.useBy);
      const proof = tree.getProof([SERIALS[0]]);
      expect((await tt.verifyPack(lotId, SERIALS[0], proof)).verdict).to.equal(Verdict.PastUseBy);
      await expect(tt.connect(retailer).sell(lotId, SERIALS[0], proof)).to.be.revertedWithCustomError(tt, "PastUseBy");
    });
  });
});

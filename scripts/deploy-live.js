/**
 * Deploys TunaTrace to a live network (Sepolia) and prepares the public demo.
 *
 *   npx hardhat run scripts/deploy-live.js --network sepolia
 *
 * (It also works against a local node:  npx hardhat node  then
 *  npx hardhat run scripts/deploy-live.js --network localhost)
 *
 * What it does:
 *   1. Checks your wallet has enough test ETH for everything below.
 *   2. Deploys the contract. Your MetaMask account becomes the administrator
 *      (and the fisheries authority).
 *   3. Creates six DEMO wallets (regulator, processor, distributor, retailer,
 *      IoT gateway, lab inspector), sends each a little test ETH and grants roles.
 *      Creates a seventh key for the fishing vessel's VMS unit; it only signs
 *      catch declarations, so it never needs ETH.
 *   4. Licenses the vessel, declares a marine park, then runs a short story on
 *      the real chain: a signed catch, two lots of frozen tuna, signed
 *      temperature windows, one lot quarantined, one lot DNA-verified and
 *      delivered to the supermarket, one pack sold.
 *   5. Writes web/deployment.js so web/live.html can talk to the contract.
 *
 * The demo keys are written into web/deployment.js on purpose, so anyone
 * opening the public page can act as each organisation without installing a
 * wallet. They only ever hold small amounts of TEST ETH.
 * Your own MetaMask key is NEVER written anywhere by this script.
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { StandardMerkleTree } = require("@openzeppelin/merkle-tree");
const { cidOf, encryptForConsortium } = require("../offchain/ipfs");
const { signCatch, zone } = require("../oracle/vms");
const { TELEMETRY_TYPES, domainOf } = require("../oracle/gateway");

const { ethers } = hre;
const GTIN_FROZEN = "06099999000027"; // ultra-low-temperature saku blocks, 300 g
const GTIN_CHILLED = "06099999000010"; // chilled loin steaks, 250 g
const QTY = 100;
const DAY = 86400;
const serialsFor = (n) => Array.from({ length: n }, (_, i) => `TT${String(i + 1).padStart(4, "0")}`);
const LICENSED = { minLat: -24, maxLat: -16, minLon: 53, maxLon: 62 };
const MARINE_PARK = { minLat: -20.47, maxLat: -20.42, minLon: 57.69, maxLon: 57.74 };

// Gas each demo wallet is funded for (seeding + headroom for visitors to try things).
const BUDGET = { regulator: 600_000, processor: 4_000_000, distributor: 1_200_000, retailer: 800_000, oracle: 1_800_000, inspector: 300_000 };
const ROLE_OF = { regulator: "REGULATOR_ROLE", processor: "PROCESSOR_ROLE", distributor: "DISTRIBUTOR_ROLE", retailer: "RETAILER_ROLE", oracle: "ORACLE_ROLE", inspector: "INSPECTOR_ROLE" };
const ORG = {
  regulator: "Fisheries Competent Authority (fictional)",
  processor: "Port Louis Ocean Foods Ltd (fictional)",
  distributor: "IslandCold Logistics (fictional)",
  retailer: "Lagoon Fresh Market (fictional)",
  oracle: "IoT oracle gateway",
  inspector: "Marine Food Lab (fictional)",
  vessel: "FV Albacora Star VMS unit (fictional)",
};

const fmt = (wei) => `${Number(ethers.formatEther(wei)).toFixed(5)} ETH`;
let step = 0;
const log = (msg) => console.log(`[${String(++step).padStart(2, "0")}] ${msg}`);

async function send(label, txPromise) {
  const tx = await txPromise;
  const rc = await tx.wait();
  log(`${label}  (tx ${tx.hash.slice(0, 12)}…, gas ${rc.gasUsed})`);
  return rc;
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error("No deployer key. Run:  npx hardhat vars set SEPOLIA_PRIVATE_KEY  and paste your MetaMask test account's private key.");
  }
  const admin = signers[0];
  const balance = await ethers.provider.getBalance(admin.address);
  const fee = await ethers.provider.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice;
  const fundingPrice = (price * 3n) / 2n; // 50% headroom on today's gas price for the demo wallets

  const fundTotal = Object.values(BUDGET).reduce((s, g) => s + BigInt(g), 0n) * fundingPrice;
  const adminGas = 5_600_000n; // deploy + role grants + funding transfers + vessel licence + marine park
  const needed = fundTotal + adminGas * price;

  console.log(`\nNetwork:        ${hre.network.name} (chain ${net.chainId})`);
  console.log(`Your account:   ${admin.address}`);
  console.log(`Balance:        ${fmt(balance)}`);
  console.log(`Gas price now:  ${ethers.formatUnits(price, "gwei")} gwei`);
  console.log(`Estimated need: ${fmt(needed)}\n`);
  if (balance < needed) {
    throw new Error(`Not enough test ETH. Get at least ${fmt(needed - balance)} more from a faucet, then run this again.`);
  }

  // ---- 1. Deploy --------------------------------------------------------------
  const Factory = await ethers.getContractFactory("TunaTrace", admin);
  const tt = await Factory.deploy(admin.address);
  const deployTx = tt.deploymentTransaction();
  const deployRc = await deployTx.wait();
  const address = await tt.getAddress();
  log(`Contract deployed at ${address} (block ${deployRc.blockNumber})`);

  // ---- 2. Demo wallets, funding and roles ------------------------------------
  const wallets = {};
  for (const role of Object.keys(BUDGET)) wallets[role] = ethers.Wallet.createRandom().connect(ethers.provider);
  const vms = ethers.Wallet.createRandom(); // signs only; never pays gas
  for (const [role, w] of Object.entries(wallets)) {
    await send(`Funded ${role} wallet ${w.address.slice(0, 10)}… with ${fmt(BigInt(BUDGET[role]) * fundingPrice)}`,
      admin.sendTransaction({ to: w.address, value: BigInt(BUDGET[role]) * fundingPrice }));
  }
  for (const [role, w] of Object.entries(wallets)) {
    await send(`Granted ${ROLE_OF[role]} to ${role}`, tt.connect(admin).grantRole(await tt[ROLE_OF[role]](), w.address));
  }
  const as = (role) => tt.connect(wallets[role]);

  // ---- 3. Fisheries authority: licence and marine park --------------------------
  const t0 = (await ethers.provider.getBlock("latest")).timestamp;
  await send(`Licensed vessel FV Albacora Star (VMS key ${vms.address.slice(0, 10)}…)`,
    tt.connect(admin).registerVessel(vms.address, "FV Albacora Star (fictional)", "MU-LL-0042", t0 + 3 * 365 * DAY, zone(LICENSED)));
  await send(`Declared a marine park as a no-take zone`, tt.connect(admin).addProtectedArea(zone(MARINE_PARK)));

  // ---- 4. Landing: vessel-signed catch declaration --------------------------------
  const decl = { species: "YFT", weightKg: 600, lat: -19.2514, lon: 58.1032, caughtAt: t0 - 2 * DAY, nonce: 1 };
  const { c, sig } = await signCatch(tt, vms, decl);
  await send(`Processor declared catch: ${decl.weightKg} kg YFT at ${decl.lat}, ${decl.lon} (signed by the vessel)`, as("processor").declareCatch(c, sig));
  const catchId = await tt.catchIdOf(vms.address, 1);

  // ---- 5. Two lots of frozen saku blocks -------------------------------------------
  const tree = StandardMerkleTree.of(serialsFor(QTY).map((s) => [s]), ["string"]);
  const cert = Buffer.from(JSON.stringify({ doc: "Catch certificate + health certificate", vessel: "FV Albacora Star", species: "Thunnus albacares", area: "FAO 51" }));
  const docsCid = await cidOf(encryptForConsortium(cert).payload);
  const base = {
    gtin: GTIN_FROZEN, catchId, rawWeightKg: 60, quantity: QTY, packGrams: 300, frozen: true,
    useBy: decl.caughtAt + 540 * DAY, minTempDeci: -650, maxTempDeci: -450, criticalTempDeci: -180,
    abuseBudget: 3000, shelfLifePenaltySec: 600, serialRoot: tree.root, docsCid,
  };
  const lots = { good: "YFT-ULT-2610-A", bad: "YFT-ULT-2610-B" };
  for (const lot of Object.values(lots)) await send(`Processor packed lot ${lot} (${QTY} x 300 g frozen saku)`, as("processor").createLot({ ...base, lot }));
  const ids = { good: await tt.lotIdOf(GTIN_FROZEN, lots.good), bad: await tt.lotIdOf(GTIN_FROZEN, lots.bad) };

  // ---- 6. Loggers, shipping, signed telemetry ---------------------------------------
  const loggers = { good: ethers.Wallet.createRandom(), bad: ethers.Wallet.createRandom() };
  for (const k of ["good", "bad"]) {
    await send(`Logger bound to ${lots[k]}`, as("processor").bindSensor(ids[k], loggers[k].address));
    await send(`${lots[k]} shipped to distributor`, as("processor").initiateTransfer(ids[k], wallets.distributor.address, ethers.id(`DN|${lots[k]}|P->D`)));
  }
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const plan = {
    good: [[-588, -561], [-579, -552], [-556, -410], [-581, -560]], // dock door left open: one window peaks at -41 C (within budget)
    bad: [[-585, -560], [-470, -380], [-380, -300], [-300, -260]], // reefer compressor failure: warms to -26 C
  };
  const domain = await domainOf(tt);
  for (const k of ["good", "bad"]) {
    for (let i = 0; i < 4; i++) {
      const t = {
        lotId: ids[k], windowStart: now - 3600 + i * 900, windowEnd: now - 2700 + i * 900,
        minTempDeci: plan[k][i][0], maxTempDeci: plan[k][i][1], readingsRoot: ethers.id(`${lots[k]}-window-${i + 1}`), nonce: i + 1,
      };
      const s = await loggers[k].signTypedData(domain, TELEMETRY_TYPES, t);
      await send(`${lots[k]} window ${i + 1}: ${plan[k][i][0] / 10} to ${plan[k][i][1] / 10} C`, as("oracle").recordTelemetry(t, s));
    }
  }

  // ---- 7. Good lot: DNA verified, reaches the supermarket; one pack sold ------------
  await send(`Lab recorded DNA barcoding: ${lots.good} is yellowfin`, as("inspector").recordSpeciesTest(ids.good, true, "bafkrei-demo-dna-report"));
  await send(`Distributor accepted ${lots.good}`, as("distributor").acceptTransfer(ids.good));
  await send(`${lots.good} shipped to retailer`, as("distributor").initiateTransfer(ids.good, wallets.retailer.address, ethers.id(`DN|${lots.good}|D->R`)));
  await send(`Retailer accepted ${lots.good}`, as("retailer").acceptTransfer(ids.good));
  await send(`Retailer sold pack TT0042`, as("retailer").sell(ids.good, "TT0042", tree.getProof(["TT0042"])));

  const statusBad = (await tt.getLot(ids.bad)).status;
  log(`${lots.bad} status on-chain: ${["None", "Packed", "InTransit", "Received", "Quarantined", "Recalled", "SoldOut"][Number(statusBad)]}`);

  // ---- 8. Write the page configuration ----------------------------------------------
  const abi = JSON.parse(tt.interface.formatJson());
  const explorer = Number(net.chainId) === 11155111 ? "https://sepolia.etherscan.io" : null;
  const deployment = {
    network: hre.network.name,
    chainId: Number(net.chainId),
    contract: address,
    deployBlock: deployRc.blockNumber,
    deployTx: deployTx.hash,
    deployedAt: new Date().toISOString(),
    admin: admin.address,
    explorer,
    rpcUrls: hre.network.name === "sepolia"
      ? ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.drpc.org", "https://1rpc.io/sepolia"]
      : ["http://127.0.0.1:8545"],
    gtins: { frozen: GTIN_FROZEN, chilled: GTIN_CHILLED },
    serialScheme: "TT0001 to TT<quantity>, 4 digits",
    seededLots: lots,
    licensedZone: LICENSED,
    marinePark: MARINE_PARK,
    demoWallets: {
      ...Object.fromEntries(Object.entries(wallets).map(([role, w]) => [role, { org: ORG[role], address: w.address, privateKey: w.privateKey }])),
      vessel: { org: ORG.vessel, address: vms.address, privateKey: vms.privateKey, nextNonce: 2 },
    },
    abi,
  };
  const outJs = path.join(__dirname, "..", "web", "deployment.js");
  fs.writeFileSync(outJs,
    "// Generated by scripts/deploy-live.js. TEST NETWORK ONLY: the demo keys below hold test ETH, never real money.\n" +
    `window.TUNATRACE_DEPLOYMENT = ${JSON.stringify(deployment, null, 2)};\n`);
  fs.mkdirSync(path.join(__dirname, "..", "reports"), { recursive: true });
  const { abi: _omit, demoWallets, ...summary } = deployment;
  fs.writeFileSync(path.join(__dirname, "..", "reports", `deployment-${hre.network.name}.json`),
    JSON.stringify({ ...summary, demoWallets: Object.fromEntries(Object.entries(demoWallets).map(([r, w]) => [r, w.address])) }, null, 2));

  const left = await ethers.provider.getBalance(admin.address);
  console.log(`\nDone. Contract: ${address}`);
  if (explorer) console.log(`View it:        ${explorer}/address/${address}`);
  console.log(`Page config:    web/deployment.js (open web/live.html)`);
  console.log(`Your balance:   ${fmt(left)}\n`);
}

main().catch((e) => {
  console.error(`\nERROR: ${e.shortMessage || e.message}\n`);
  process.exit(1);
});

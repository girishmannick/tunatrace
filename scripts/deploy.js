// Deploys TunaTrace to the network given by --network, grants demo roles and licenses one demo vessel.
//   npx hardhat run scripts/deploy.js --network consortium
const { ethers } = require("hardhat");
const { zone } = require("../oracle/vms");

async function main() {
  const s = await ethers.getSigners();
  // Use six different accounts when available; otherwise reuse the first (e.g. on Besu with one key)
  const [regulator, processor, distributor, retailer, gateway, lab] = [0, 1, 2, 3, 4, 5].map((i) => s[i] ?? s[0]);
  const tt = await (await ethers.getContractFactory("TunaTrace")).deploy(regulator.address);
  await tt.waitForDeployment();
  const roles = [
    ["PROCESSOR_ROLE", processor], ["DISTRIBUTOR_ROLE", distributor], ["RETAILER_ROLE", retailer],
    ["ORACLE_ROLE", gateway], ["INSPECTOR_ROLE", lab],
  ];
  for (const [name, acct] of roles) await (await tt.grantRole(await tt[name](), acct.address)).wait();
  const vms = ethers.Wallet.createRandom();
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  await (await tt.registerVessel(vms.address, "FV Albacora Star (fictional)", "MU-LL-0042", now + 365 * 86400,
    zone({ minLat: -24, maxLat: -16, minLon: 53, maxLon: 62 }))).wait();
  await (await tt.addProtectedArea(zone({ minLat: -20.47, maxLat: -20.42, minLon: 57.69, maxLon: 57.74 }))).wait();
  console.log("TunaTrace deployed at", await tt.getAddress());
  for (const [name, acct] of roles) console.log(name.padEnd(18), acct.address);
  console.log("Demo vessel VMS key".padEnd(18), vms.address, "(private key printed once:", vms.privateKey + ")");
}
main().catch((e) => { console.error(e); process.exit(1); });

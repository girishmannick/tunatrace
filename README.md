# TunaTrace — catch-to-plate traceability for chilled and frozen tuna

Prototype for the *Blockchain Foundations and Applications* assignment (Part B).
A catch of yellowfin tuna is tracked **Fishing vessel → Processor → Distributor →
Retailer → Consumer** on a permissioned EVM chain (Hyperledger Besu, QBFT consensus),
with documents on IPFS, an EIP-712-signed **vessel origin oracle** (VMS / e-logbook)
and EIP-712-signed **cold-chain telemetry**. All organisation and vessel names are fictional.

## What the contract enforces
| Threat | Control in `TunaTrace.sol` |
| --- | --- |
| Illegal, unreported, unregulated (IUU) fishing | Catch must be signed by a licensed, non-suspended vessel key; position must be inside the licensed zone and outside every marine protected area; nonce stops replays |
| Laundering illegal fish under a legal catch | Mass balance: lots can never draw more raw weight than the catch; packed weight capped at 70 % yield |
| Freshness fraud | Chilled lots: use-by ≤ capture + 21 days. Frozen lots (≤ −18 °C): ≤ capture + 24 months |
| Cold-chain abuse / histamine risk | Signed 15-minute windows; time-temperature **abuse score** (deci-°C·min above limit) shortens the use-by date and auto-quarantines when the budget is spent or a critical temperature is reached; gaps > 1 h are flagged |
| Species substitution | Accredited lab records DNA-barcoding result; mismatch quarantines the lot |
| Grey-market diversion | Two-step custody hand-over; only processor → distributor → (distributor) → retailer |
| Counterfeit / cloned labels | Pack serials committed as a Merkle root; each serial sold once; public `verifyPack` |

## Layout
| Path | What it is |
| --- | --- |
| `contracts/TunaTrace.sol` | Smart contract: roles, vessel registry, origin oracle, mass balance, lots, custody, cold-chain oracle, DNA test, recall, Merkle-proof sale and public `verifyPack` |
| `test/TunaTrace.test.js` | 25 unit tests (access control, IUU checks, mass balance, custody, oracle forgery/replay/tampering, abuse scoring, critical limit, gaps, DNA, recall, counterfeit, dynamic use-by) |
| `oracle/vms.js` | Vessel VMS unit: EIP-712 catch declarations, coordinate helpers |
| `oracle/gateway.js` | IoT gateway: windows raw readings, Merkle-roots them, obtains the logger's EIP-712 signature; auditor proof of any single minute |
| `offchain/ipfs.js` | CIDv1 computation, AES-256-GCM encryption for confidential documents, integrity-checked pin store |
| `scripts/simulate.js` | End-to-end run (two lots, one auto-quarantined, five fraud attempts rejected) → `reports/simulation.json` |
| `scripts/deploy.js` | Plain deployment to any network (e.g. the Besu consortium) |
| `scripts/deploy-live.js` | Deploys to Sepolia, creates funded demo wallets, runs a short story on-chain, writes `web/deployment.js` |
| `scripts/topup-live.js` | Refills the demo wallets with test ETH |
| `web/index.html` | Offline console: same rules simulated in the browser, with a QBFT ledger view |
| `web/live.html` | Live console: reads and writes the deployed contract (needs `web/deployment.js`) |
| `web/app.js`, `web/chain-sim.js`, `web/chain-live.js`, `web/style.css` | Shared UI and the two back-ends |
| `network/` | Example Besu QBFT genesis and `generate-blockchain-config` input for a 7-validator consortium |
| `reports/` | Gas report, coverage summary and simulation output |

## Run
```bash
npm install --legacy-peer-deps
npm test           # compiles and runs 25 tests + gas report
npm run simulate   # end-to-end scenario -> reports/simulation.json
```
Solidity 0.8.24 (solc-js from npm), OpenZeppelin Contracts 5.x (AccessControl, EIP712, ECDSA, MerkleProof), Hardhat 2.x, ethers 6.

Open `web/index.html` in a browser for the offline console (no blockchain needed).

## Deploying to a consortium network
1. Generate validator keys and genesis with `besu operator generate-blockchain-config --config-file=network/besu-qbft-config.example.json --to=networkFiles`.
2. Start one Besu node per consortium member with QBFT and node permissioning enabled.
3. `npx hardhat vars set CONSORTIUM_RPC_URL` and `npx hardhat vars set CONSORTIUM_PRIVATE_KEY`, then
   `npx hardhat run scripts/deploy.js --network consortium`. The regulator then grants roles to member addresses.

## Live deployment (Sepolia test network)
```bash
npx hardhat vars set SEPOLIA_PRIVATE_KEY <your MetaMask TEST account private key>
npx hardhat run scripts/deploy-live.js --network sepolia
```
Then open `web/live.html`, or publish the repository with GitHub Pages. See `docs/TunaTrace_Live_Deployment_Guide.pdf`.
The demo keys in `web/deployment.js` are public by design and only hold test ETH.

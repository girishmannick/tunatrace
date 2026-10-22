/**
 * Cold-chain IoT oracle gateway (off-chain).
 *
 * A data-logger packed with each lot of chilled tuna samples temperature once
 * a minute. Signing every reading would drain a coin-cell battery, so the
 * gateway (a reefer-truck telematics box or a cold-store edge server):
 *   1. groups raw readings into fixed windows (default 15 minutes),
 *   2. builds a Merkle root over the window's raw readings (the raw file goes
 *      to IPFS so an auditor can later re-check any single minute),
 *   3. asks the logger's secure element to sign the window summary using
 *      EIP-712 typed data (human-readable, domain-separated to this contract
 *      and chain, so a signature cannot be replayed elsewhere),
 *   4. submits the signed summary to TunaTrace.recordTelemetry().
 *
 * The contract re-checks the signature, so a compromised gateway can delay
 * data (which the contract flags as a TelemetryGap) but cannot forge or alter it.
 */
const { StandardMerkleTree } = require("@openzeppelin/merkle-tree");

const TELEMETRY_TYPES = {
  Telemetry: [
    { name: "lotId", type: "bytes32" },
    { name: "windowStart", type: "uint64" },
    { name: "windowEnd", type: "uint64" },
    { name: "minTempDeci", type: "int16" },
    { name: "maxTempDeci", type: "int16" },
    { name: "readingsRoot", type: "bytes32" },
    { name: "nonce", type: "uint64" },
  ],
};

async function domainOf(contract) {
  const net = await contract.runner.provider.getNetwork();
  return { name: "TunaTrace", version: "1", chainId: net.chainId, verifyingContract: await contract.getAddress() };
}

/**
 * Simulated logger for chilled tuna loins stored at 0-4 C.
 * `excursions` describe events such as a reefer door left open at a
 * transhipment dock: [{ from, to, base, peak }] in minutes / degrees C.
 */
function simulateReadings({ start, minutes, excursions = [], seed = 42 }) {
  const readings = [];
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let m = 0; m < minutes; m++) {
    let temp = 1.6 + Math.sin(m / 41) * 0.7 + (rand() - 0.5) * 0.4; // ~0.7-2.5 C on ice slurry / chiller
    for (const e of excursions) {
      if (m >= e.from && m < e.to) {
        const mid = (e.from + e.to) / 2;
        const shape = 1 - Math.abs(m - mid) / ((e.to - e.from) / 2 + 1);
        temp = e.base + (e.peak - e.base) * shape;
      }
    }
    readings.push({ ts: start + m * 60, tempDeci: Math.round(temp * 10) });
  }
  return readings;
}

function aggregateWindows(readings, windowSec = 900) {
  const windows = new Map();
  for (const r of readings) {
    const key = Math.floor(r.ts / windowSec) * windowSec;
    if (!windows.has(key)) windows.set(key, []);
    windows.get(key).push(r);
  }
  return [...windows.entries()].map(([windowStart, rs]) => {
    const tree = StandardMerkleTree.of(rs.map((r) => [r.ts, r.tempDeci]), ["uint64", "int16"]);
    return {
      windowStart,
      windowEnd: windowStart + windowSec,
      minTempDeci: Math.min(...rs.map((r) => r.tempDeci)),
      maxTempDeci: Math.max(...rs.map((r) => r.tempDeci)),
      readingsRoot: tree.root,
      count: rs.length,
      raw: rs,
      tree,
    };
  });
}

/** The logger signs one window summary (EIP-712). */
async function signWindow(contract, loggerWallet, lotId, w, nonce) {
  const t = {
    lotId,
    windowStart: w.windowStart,
    windowEnd: w.windowEnd,
    minTempDeci: w.minTempDeci,
    maxTempDeci: w.maxTempDeci,
    readingsRoot: w.readingsRoot,
    nonce,
  };
  const sig = await loggerWallet.signTypedData(await domainOf(contract), TELEMETRY_TYPES, t);
  return { t, sig };
}

/** Auditor helper: prove that one raw minute belongs to an on-chain window. */
function proveReading(window, ts) {
  for (const [i, v] of window.tree.entries()) {
    if (Number(v[0]) === ts) return { value: v, proof: window.tree.getProof(i), root: window.tree.root };
  }
  throw new Error(`No reading at ${ts}`);
}

module.exports = { TELEMETRY_TYPES, domainOf, simulateReadings, aggregateWindows, signWindow, proveReading };

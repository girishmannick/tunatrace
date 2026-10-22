/**
 * Vessel origin oracle (off-chain): the vessel's VMS / electronic logbook.
 *
 * Licensed vessels carry a type-approved Vessel Monitoring System unit with a
 * GNSS receiver and a secure element holding a private key. The fisheries
 * authority registers the matching public address in TunaTrace together with
 * the vessel's licence and licensed fishing zone.
 *
 * When a set is hauled, the e-logbook records species, estimated landed
 * weight and the GNSS position, and the secure element signs an EIP-712
 * "CatchDeclaration". The signed declaration travels with the fish to the
 * processor, who submits it on landing. Because only the vessel can produce
 * the signature, nobody further down the chain can invent a catch, move it
 * out of a marine protected area, or re-use one declaration twice.
 */
const { domainOf } = require("./gateway");

const CATCH_TYPES = {
  CatchDeclaration: [
    { name: "species", type: "string" },
    { name: "weightKg", type: "uint32" },
    { name: "latE5", type: "int32" },
    { name: "lonE5", type: "int32" },
    { name: "caughtAt", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
};

/** Degrees -> fixed-point 1e-5 degrees, as stored on-chain. */
const toE5 = (deg) => Math.round(deg * 1e5);
const fromE5 = (v) => Number(v) / 1e5;

/** Box helper: { minLat, maxLat, minLon, maxLon } in degrees -> on-chain Zone. */
const zone = ({ minLat, maxLat, minLon, maxLon }) => ({
  minLatE5: toE5(minLat),
  maxLatE5: toE5(maxLat),
  minLonE5: toE5(minLon),
  maxLonE5: toE5(maxLon),
});

async function signCatch(contract, vesselWallet, { species, weightKg, lat, lon, caughtAt, nonce }) {
  const c = { species, weightKg, latE5: toE5(lat), lonE5: toE5(lon), caughtAt, nonce };
  const sig = await vesselWallet.signTypedData(await domainOf(contract), CATCH_TYPES, c);
  return { c, sig };
}

module.exports = { CATCH_TYPES, toE5, fromE5, zone, signCatch };

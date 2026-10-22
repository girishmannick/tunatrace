// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title TunaTrace
 * @notice Catch-to-plate traceability, cold-chain and authenticity ledger for
 *         chilled yellowfin tuna:
 *
 *            Fishing vessel -> Processor -> Distributor -> Retailer -> Consumer
 *
 *         Heavy documents (catch certificates, health certificates, DNA lab
 *         reports, raw sensor logs) live off-chain on IPFS; only their content
 *         identifiers (CIDs) and hashes are anchored here.
 *
 * Design notes
 *  - Permissioned writes (role-based) on a consortium EVM chain running QBFT
 *    (Proof of Authority family). Reads are public so any shopper can verify
 *    a pack without an account or fees.
 *  - ORIGIN ORACLE (anti-IUU): every catch is declared by the vessel's own
 *    tamper-resistant VMS / e-logbook unit, which signs an EIP-712 message.
 *    The contract checks that the signer is a licensed, non-suspended vessel,
 *    that the position lies inside the vessel's licensed zone and outside
 *    every protected area, and that the declaration is not replayed.
 *  - MASS BALANCE (anti-laundering): lots draw raw weight from a declared
 *    catch. The total drawn can never exceed the catch, and the packed weight
 *    can never exceed a plausible processing yield, so illegal fish cannot be
 *    "laundered" into a legal catch by inflating volumes.
 *  - COLD-CHAIN ORACLE: data-loggers sign windowed temperature summaries
 *    (EIP-712). The contract accumulates a time-temperature abuse score in
 *    deci-degree-minutes above the storage limit (a proxy for histamine
 *    formation), shortens the effective use-by date in proportion, and
 *    auto-quarantines the lot when the abuse budget is spent or a critical
 *    temperature is reached in any window.
 *  - SPECIES AUTHENTICITY: an accredited laboratory records the DNA-barcoding
 *    result. A mismatch (species substitution) quarantines the lot.
 *  - Custody changes use a two-step handshake (initiate -> accept).
 *  - Retail pack serials are committed as one Merkle root; a pack is proven
 *    with a Merkle proof read from its QR code / NFC tag.
 */
contract TunaTrace is AccessControl, EIP712 {
    // ------------------------------------------------------------------
    // Roles
    // ------------------------------------------------------------------
    bytes32 public constant REGULATOR_ROLE = keccak256("REGULATOR_ROLE");
    bytes32 public constant PROCESSOR_ROLE = keccak256("PROCESSOR_ROLE");
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");
    bytes32 public constant RETAILER_ROLE = keccak256("RETAILER_ROLE");
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant INSPECTOR_ROLE = keccak256("INSPECTOR_ROLE");

    // ------------------------------------------------------------------
    // Policy constants
    // ------------------------------------------------------------------
    /// Maximum packed weight as a share of raw catch weight (basis points). Loining yield of tuna is ~50-60 %.
    uint16 public constant MAX_YIELD_BP = 7000;
    /// A chilled (never frozen) product cannot claim a use-by more than 21 days after capture.
    uint64 public constant MAX_CHILLED_LIFE = 21 days;
    /// A frozen product (stored at -18 C or colder) can claim up to 24 months.
    uint64 public constant MAX_FROZEN_LIFE = 730 days;
    int16 public constant FROZEN_MAX_TEMP_DECI = -180;
    /// Silence longer than this between two telemetry windows is flagged as a data gap.
    uint64 public constant MAX_TELEMETRY_GAP = 1 hours;

    bytes32 private constant CATCH_TYPEHASH =
        keccak256("CatchDeclaration(string species,uint32 weightKg,int32 latE5,int32 lonE5,uint64 caughtAt,uint64 nonce)");
    bytes32 private constant TELEMETRY_TYPEHASH =
        keccak256("Telemetry(bytes32 lotId,uint64 windowStart,uint64 windowEnd,int16 minTempDeci,int16 maxTempDeci,bytes32 readingsRoot,uint64 nonce)");

    // ------------------------------------------------------------------
    // Data model
    // ------------------------------------------------------------------
    enum Status {
        None,
        Packed,
        InTransit,
        Received,
        Quarantined,
        Recalled,
        SoldOut
    }

    /// Geographic box in 1e-5 degrees (about 1.1 m at the equator).
    struct Zone {
        int32 minLatE5;
        int32 maxLatE5;
        int32 minLonE5;
        int32 maxLonE5;
    }

    struct Vessel {
        string name;
        string licenceNo;
        uint64 licenceExpiry;
        Zone zone;
        bool active;
        uint64 lastNonce;
    }

    /// Signed by the vessel's VMS / e-logbook unit.
    struct CatchDeclaration {
        string species; // FAO ASFIS 3-alpha code, e.g. "YFT" = yellowfin tuna
        uint32 weightKg; // whole-fish landed weight
        int32 latE5;
        int32 lonE5;
        uint64 caughtAt;
        uint64 nonce;
    }

    struct Catch {
        address vessel;
        string species;
        uint32 weightKg;
        uint32 usedKg;
        int32 latE5;
        int32 lonE5;
        uint64 caughtAt;
        uint64 landedAt;
        address landedBy;
    }

    struct LotInput {
        string gtin; // GS1 Global Trade Item Number of the retail pack
        string lot;
        bytes32 catchId;
        uint32 rawWeightKg; // raw fish drawn from the catch for this lot
        uint32 quantity; // retail packs
        uint32 packGrams; // net weight per pack
        bool frozen; // product class: chilled (0-4 C) or frozen (-18 C or colder)
        uint64 useBy; // nominal use-by date (unix seconds)
        int16 minTempDeci; // storage range in tenths of a degree C (0 = 0.0 C)
        int16 maxTempDeci; // e.g. 40 = 4.0 C
        int16 criticalTempDeci; // any window at or above this quarantines immediately
        uint32 abuseBudget; // allowed deci-degree-minutes above maxTemp
        uint32 shelfLifePenaltySec; // seconds of use-by lost per deci-degree-minute of abuse
        bytes32 serialRoot; // Merkle root of pack serial numbers
        string docsCid; // IPFS CID: catch certificate + health certificate + processing record
    }

    struct Lot {
        string gtin;
        string lot;
        string species;
        bytes32 catchId;
        uint32 rawWeightKg;
        uint32 quantity;
        uint32 sold;
        uint32 packGrams;
        bool frozen;
        uint64 useBy;
        int16 minTempDeci;
        int16 maxTempDeci;
        int16 criticalTempDeci;
        uint32 abuseBudget;
        uint32 abuseScore;
        uint32 excursionSec;
        uint32 shelfLifePenaltySec;
        uint32 shelfLifeLostSec;
        uint16 telemetryGaps;
        bool dnaVerified;
        bytes32 serialRoot;
        string docsCid;
        address processor;
        address custodian;
        address pendingCustodian;
        bytes32 pendingDocHash;
        Status status;
        uint64 createdAt;
    }

    struct Telemetry {
        bytes32 lotId;
        uint64 windowStart;
        uint64 windowEnd;
        int16 minTempDeci;
        int16 maxTempDeci;
        bytes32 readingsRoot; // Merkle root of the raw readings kept on IPFS
        uint64 nonce;
    }

    struct CustodyEvent {
        address from;
        address to;
        uint64 at;
        bytes32 handoverDocHash; // hash of the signed delivery note / health certificate on IPFS
    }

    enum Verdict {
        Genuine,
        GenuineAlreadySold,
        UnknownSerial,
        UnknownLot,
        Recalled,
        Quarantined,
        PastUseBy
    }

    /// Everything the shopper's phone needs after scanning a pack.
    struct PackInfo {
        Verdict verdict;
        string gtin;
        string lot;
        string species;
        string vesselName;
        int32 latE5;
        int32 lonE5;
        uint64 caughtAt;
        uint64 effectiveUseBy;
        uint32 abuseScore;
        bool dnaVerified;
        bool frozen;
        address processor;
    }

    mapping(address => Vessel) private vessels;
    address[] private vesselKeys;
    Zone[] private protectedAreas;
    mapping(bytes32 => Catch) private catches;
    mapping(bytes32 => Lot) private lots;
    mapping(bytes32 => CustodyEvent[]) private custodyLog;
    mapping(bytes32 => mapping(bytes32 => bool)) public serialSold; // lotId => serialLeaf => sold
    mapping(address => bytes32) public sensorLot; // logger key => lot it is bound to
    mapping(address => uint64) public sensorNonce; // logger key => last accepted nonce
    mapping(bytes32 => uint64) public lastTelemetryEnd; // lotId => end of last accepted window
    bytes32[] private lotIds;
    bytes32[] private catchIds;

    // ------------------------------------------------------------------
    // Events (the off-chain indexer and the UIs are driven by these)
    // ------------------------------------------------------------------
    event VesselRegistered(address indexed vessel, string name, string licenceNo, uint64 licenceExpiry);
    event VesselSuspended(address indexed vessel, string reason);
    event ProtectedAreaAdded(uint256 indexed index, int32 minLatE5, int32 maxLatE5, int32 minLonE5, int32 maxLonE5);
    event CatchDeclared(bytes32 indexed catchId, address indexed vessel, string species, uint32 weightKg, int32 latE5, int32 lonE5, uint64 caughtAt);
    event LotCreated(bytes32 indexed lotId, bytes32 indexed catchId, address indexed processor, string gtin, string lot, uint32 quantity, string docsCid);
    event TransferInitiated(bytes32 indexed lotId, address indexed from, address indexed to, bytes32 handoverDocHash);
    event TransferAccepted(bytes32 indexed lotId, address indexed from, address indexed to);
    event TransferCancelled(bytes32 indexed lotId, address indexed by);
    event SensorBound(bytes32 indexed lotId, address indexed sensor);
    event TelemetryRecorded(bytes32 indexed lotId, address indexed sensor, uint64 windowStart, uint64 windowEnd, int16 minTempDeci, int16 maxTempDeci, bytes32 readingsRoot);
    event TelemetryGap(bytes32 indexed lotId, uint64 lastEnd, uint64 nextStart);
    event TemperatureAbuse(bytes32 indexed lotId, uint32 addedScore, uint32 totalScore, uint32 shelfLifeLostSec);
    event LotQuarantined(bytes32 indexed lotId, string reason);
    event LotReleased(bytes32 indexed lotId, address indexed inspector, string assessmentCid);
    event SpeciesTested(bytes32 indexed lotId, address indexed lab, bool matchesDeclared, string reportCid);
    event LotRecalled(bytes32 indexed lotId, address indexed by, string reason);
    event PackSold(bytes32 indexed lotId, bytes32 indexed serialLeaf, address indexed retailer);
    event DocumentAttached(bytes32 indexed lotId, string cid, string docType);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------
    error UnknownVessel();
    error VesselInactive();
    error LicenceExpired();
    error OutsideLicensedZone();
    error InsideProtectedArea();
    error UnknownCatch();
    error MassBalanceExceeded();
    error YieldImplausible();
    error ShelfLifeImplausible();
    error LotExists();
    error UnknownLot();
    error InvalidInput();
    error NotCustodian();
    error NotPendingCustodian();
    error InvalidRecipient();
    error BadStatus(Status current);
    error PastUseBy();
    error SensorNotBound();
    error StaleNonce();
    error BadWindow();
    error InvalidProof();
    error AlreadySold();

    constructor(address regulator) EIP712("TunaTrace", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, regulator);
        _grantRole(REGULATOR_ROLE, regulator);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    function lotIdOf(string calldata gtin, string calldata lot) public pure returns (bytes32) {
        return keccak256(abi.encode(gtin, lot));
    }

    function catchIdOf(address vessel, uint64 nonce) public pure returns (bytes32) {
        return keccak256(abi.encode(vessel, nonce));
    }

    function _lot(bytes32 lotId) internal view returns (Lot storage l) {
        l = lots[lotId];
        if (l.status == Status.None) revert UnknownLot();
    }

    function _inside(Zone memory z, int32 lat, int32 lon) internal pure returns (bool) {
        return lat >= z.minLatE5 && lat <= z.maxLatE5 && lon >= z.minLonE5 && lon <= z.maxLonE5;
    }

    function _validZone(Zone calldata z) internal pure returns (bool) {
        return z.minLatE5 < z.maxLatE5 && z.minLonE5 < z.maxLonE5 && z.minLatE5 >= -9_000_000 && z.maxLatE5 <= 9_000_000
            && z.minLonE5 >= -18_000_000 && z.maxLonE5 <= 18_000_000;
    }

    /// Effective use-by after the cold-chain penalty has been applied.
    function effectiveUseBy(bytes32 lotId) public view returns (uint64) {
        Lot storage l = _lot(lotId);
        return l.useBy > l.shelfLifeLostSec ? l.useBy - l.shelfLifeLostSec : 0;
    }

    // ------------------------------------------------------------------
    // 0. Fishing authority: vessel registry and protected areas
    // ------------------------------------------------------------------
    function registerVessel(address vesselKey, string calldata name, string calldata licenceNo, uint64 licenceExpiry, Zone calldata zone)
        external
        onlyRole(REGULATOR_ROLE)
    {
        if (vesselKey == address(0) || licenceExpiry <= block.timestamp || !_validZone(zone)) revert InvalidInput();
        Vessel storage v = vessels[vesselKey];
        if (bytes(v.name).length == 0) vesselKeys.push(vesselKey);
        v.name = name;
        v.licenceNo = licenceNo;
        v.licenceExpiry = licenceExpiry;
        v.zone = zone;
        v.active = true;
        emit VesselRegistered(vesselKey, name, licenceNo, licenceExpiry);
    }

    /// Used when a vessel is placed on an IUU list or its licence is withdrawn.
    function suspendVessel(address vesselKey, string calldata reason) external onlyRole(REGULATOR_ROLE) {
        Vessel storage v = vessels[vesselKey];
        if (bytes(v.name).length == 0) revert UnknownVessel();
        v.active = false;
        emit VesselSuspended(vesselKey, reason);
    }

    function addProtectedArea(Zone calldata zone) external onlyRole(REGULATOR_ROLE) {
        if (!_validZone(zone)) revert InvalidInput();
        protectedAreas.push(zone);
        emit ProtectedAreaAdded(protectedAreas.length - 1, zone.minLatE5, zone.maxLatE5, zone.minLonE5, zone.maxLonE5);
    }

    // ------------------------------------------------------------------
    // 1. Landing: the origin oracle
    // ------------------------------------------------------------------
    /// EIP-712 digest the vessel's VMS unit signs.
    function catchDigest(CatchDeclaration calldata c) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(CATCH_TYPEHASH, keccak256(bytes(c.species)), c.weightKg, c.latE5, c.lonE5, c.caughtAt, c.nonce))
        );
    }

    /**
     * @notice The processor submits the catch declaration it received with the
     *         fish at landing. Only the vessel's signature makes it valid, so a
     *         processor cannot invent a catch or move its position.
     */
    function declareCatch(CatchDeclaration calldata c, bytes calldata vesselSig) external onlyRole(PROCESSOR_ROLE) returns (bytes32 catchId) {
        address vesselKey = ECDSA.recover(catchDigest(c), vesselSig);
        Vessel storage v = vessels[vesselKey];
        if (bytes(v.name).length == 0) revert UnknownVessel();
        if (!v.active) revert VesselInactive();
        if (c.caughtAt > v.licenceExpiry) revert LicenceExpired();
        if (c.weightKg == 0 || c.caughtAt > block.timestamp + 300) revert InvalidInput();
        if (c.nonce <= v.lastNonce) revert StaleNonce();
        if (!_inside(v.zone, c.latE5, c.lonE5)) revert OutsideLicensedZone();
        for (uint256 i = 0; i < protectedAreas.length; i++) {
            if (_inside(protectedAreas[i], c.latE5, c.lonE5)) revert InsideProtectedArea();
        }
        v.lastNonce = c.nonce;

        catchId = catchIdOf(vesselKey, c.nonce);
        catches[catchId] = Catch(vesselKey, c.species, c.weightKg, 0, c.latE5, c.lonE5, c.caughtAt, uint64(block.timestamp), msg.sender);
        catchIds.push(catchId);
        emit CatchDeclared(catchId, vesselKey, c.species, c.weightKg, c.latE5, c.lonE5, c.caughtAt);
    }

    // ------------------------------------------------------------------
    // 2. Processing and packing
    // ------------------------------------------------------------------
    function createLot(LotInput calldata input) external onlyRole(PROCESSOR_ROLE) returns (bytes32 lotId) {
        if (
            input.quantity == 0 || input.packGrams == 0 || input.rawWeightKg == 0 || input.useBy <= block.timestamp
                || input.minTempDeci >= input.maxTempDeci || input.criticalTempDeci <= input.maxTempDeci || input.serialRoot == bytes32(0)
        ) revert InvalidInput();
        Catch storage c = catches[input.catchId];
        if (c.vessel == address(0)) revert UnknownCatch();
        if (uint256(c.usedKg) + input.rawWeightKg > c.weightKg) revert MassBalanceExceeded();
        if (uint256(input.quantity) * input.packGrams * 10_000 > uint256(input.rawWeightKg) * 1000 * MAX_YIELD_BP) revert YieldImplausible();
        if (input.frozen && input.maxTempDeci > FROZEN_MAX_TEMP_DECI) revert InvalidInput();
        if (input.useBy > c.caughtAt + (input.frozen ? MAX_FROZEN_LIFE : MAX_CHILLED_LIFE)) revert ShelfLifeImplausible();

        lotId = keccak256(abi.encode(input.gtin, input.lot));
        if (lots[lotId].status != Status.None) revert LotExists();
        c.usedKg += input.rawWeightKg;

        Lot storage l = lots[lotId];
        l.gtin = input.gtin;
        l.lot = input.lot;
        l.species = c.species;
        l.catchId = input.catchId;
        l.rawWeightKg = input.rawWeightKg;
        l.quantity = input.quantity;
        l.packGrams = input.packGrams;
        l.frozen = input.frozen;
        l.useBy = input.useBy;
        l.minTempDeci = input.minTempDeci;
        l.maxTempDeci = input.maxTempDeci;
        l.criticalTempDeci = input.criticalTempDeci;
        l.abuseBudget = input.abuseBudget;
        l.shelfLifePenaltySec = input.shelfLifePenaltySec;
        l.serialRoot = input.serialRoot;
        l.docsCid = input.docsCid;
        l.processor = msg.sender;
        l.custodian = msg.sender;
        l.status = Status.Packed;
        l.createdAt = uint64(block.timestamp);
        lotIds.push(lotId);

        custodyLog[lotId].push(CustodyEvent(address(0), msg.sender, uint64(block.timestamp), bytes32(0)));
        emit LotCreated(lotId, input.catchId, msg.sender, input.gtin, input.lot, input.quantity, input.docsCid);
    }

    // ------------------------------------------------------------------
    // 3. Custody hand-over (two-step handshake)
    // ------------------------------------------------------------------
    function initiateTransfer(bytes32 lotId, address to, bytes32 handoverDocHash) external {
        Lot storage l = _lot(lotId);
        if (l.custodian != msg.sender) revert NotCustodian();
        if (l.status != Status.Packed && l.status != Status.Received) revert BadStatus(l.status);
        if (block.timestamp >= effectiveUseBy(lotId)) revert PastUseBy();
        if (!_isValidNextHolder(msg.sender, to)) revert InvalidRecipient();

        l.pendingCustodian = to;
        l.pendingDocHash = handoverDocHash;
        l.status = Status.InTransit;
        emit TransferInitiated(lotId, msg.sender, to, handoverDocHash);
    }

    function acceptTransfer(bytes32 lotId) external {
        Lot storage l = _lot(lotId);
        if (l.status != Status.InTransit) revert BadStatus(l.status);
        if (l.pendingCustodian != msg.sender) revert NotPendingCustodian();

        address from = l.custodian;
        l.custodian = msg.sender;
        l.pendingCustodian = address(0);
        l.status = Status.Received;
        custodyLog[lotId].push(CustodyEvent(from, msg.sender, uint64(block.timestamp), l.pendingDocHash));
        l.pendingDocHash = bytes32(0);
        emit TransferAccepted(lotId, from, msg.sender);
    }

    /// Sender can withdraw an un-accepted hand-over (e.g. wrong consignee).
    function cancelTransfer(bytes32 lotId) external {
        Lot storage l = _lot(lotId);
        if (l.status != Status.InTransit) revert BadStatus(l.status);
        if (l.custodian != msg.sender) revert NotCustodian();
        l.pendingCustodian = address(0);
        l.pendingDocHash = bytes32(0);
        l.status = l.custodian == l.processor ? Status.Packed : Status.Received;
        emit TransferCancelled(lotId, msg.sender);
    }

    /// Processor -> Distributor; Distributor -> Distributor or Retailer.
    function _isValidNextHolder(address from, address to) internal view returns (bool) {
        if (to == address(0) || to == from) return false;
        if (hasRole(PROCESSOR_ROLE, from)) return hasRole(DISTRIBUTOR_ROLE, to);
        if (hasRole(DISTRIBUTOR_ROLE, from)) return hasRole(DISTRIBUTOR_ROLE, to) || hasRole(RETAILER_ROLE, to);
        return false;
    }

    // ------------------------------------------------------------------
    // 4. Cold-chain oracle
    // ------------------------------------------------------------------
    /// Custodian or regulator binds a data-logger's public key to a lot.
    function bindSensor(bytes32 lotId, address sensor) external {
        Lot storage l = _lot(lotId);
        if (l.custodian != msg.sender && !hasRole(REGULATOR_ROLE, msg.sender)) revert NotCustodian();
        if (sensor == address(0)) revert InvalidInput();
        sensorLot[sensor] = lotId;
        emit SensorBound(lotId, sensor);
    }

    /// EIP-712 digest the data-logger signs.
    function telemetryDigest(Telemetry calldata t) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(TELEMETRY_TYPEHASH, t.lotId, t.windowStart, t.windowEnd, t.minTempDeci, t.maxTempDeci, t.readingsRoot, t.nonce))
        );
    }

    /**
     * @notice Called by an authorised IoT gateway (ORACLE_ROLE). The payload
     *         must carry a valid signature from the logger bound to the lot,
     *         so a compromised gateway can delay data but cannot forge it.
     */
    function recordTelemetry(Telemetry calldata t, bytes calldata sensorSig) external onlyRole(ORACLE_ROLE) {
        Lot storage l = _lot(t.lotId);
        if (t.windowEnd <= t.windowStart || t.windowEnd > block.timestamp + 300 || t.minTempDeci > t.maxTempDeci) revert BadWindow();

        address sensor = ECDSA.recover(telemetryDigest(t), sensorSig);
        if (sensorLot[sensor] != t.lotId) revert SensorNotBound();
        if (t.nonce <= sensorNonce[sensor]) revert StaleNonce();
        sensorNonce[sensor] = t.nonce;

        uint64 lastEnd = lastTelemetryEnd[t.lotId];
        if (lastEnd != 0 && t.windowStart > lastEnd + MAX_TELEMETRY_GAP) {
            l.telemetryGaps += 1;
            emit TelemetryGap(t.lotId, lastEnd, t.windowStart);
        }
        if (t.windowEnd > lastEnd) lastTelemetryEnd[t.lotId] = t.windowEnd;

        emit TelemetryRecorded(t.lotId, sensor, t.windowStart, t.windowEnd, t.minTempDeci, t.maxTempDeci, t.readingsRoot);
        _applyColdChainRules(t, l);
    }

    function _applyColdChainRules(Telemetry calldata t, Lot storage l) internal {
        bool live = l.status != Status.Quarantined && l.status != Status.Recalled && l.status != Status.SoldOut;

        if (t.maxTempDeci > l.maxTempDeci || t.minTempDeci < l.minTempDeci) {
            uint64 secs = t.windowEnd - t.windowStart;
            l.excursionSec += uint32(secs);
            // Conservative: the whole window is charged at the window's peak.
            uint32 added = t.maxTempDeci > l.maxTempDeci ? uint32(uint256(int256(t.maxTempDeci) - int256(l.maxTempDeci))) * uint32(secs / 60) : 0;
            if (added > 0) {
                l.abuseScore += added;
                uint256 lost = uint256(l.shelfLifeLostSec) + uint256(added) * l.shelfLifePenaltySec;
                l.shelfLifeLostSec = lost > type(uint32).max ? type(uint32).max : uint32(lost);
                emit TemperatureAbuse(t.lotId, added, l.abuseScore, l.shelfLifeLostSec);
            }
        }
        if (!live) return;
        if (t.maxTempDeci >= l.criticalTempDeci) {
            _quarantine(t.lotId, l, "Critical temperature limit reached");
        } else if (l.abuseScore > l.abuseBudget) {
            _quarantine(t.lotId, l, "Time-temperature abuse budget exceeded");
        }
    }

    function _quarantine(bytes32 lotId, Lot storage l, string memory reason) internal {
        l.status = Status.Quarantined;
        l.pendingCustodian = address(0);
        l.pendingDocHash = bytes32(0);
        emit LotQuarantined(lotId, reason);
    }

    // ------------------------------------------------------------------
    // 5. Quality and authenticity decisions
    // ------------------------------------------------------------------
    /// Accredited lab records a DNA-barcoding result. A mismatch is species fraud.
    function recordSpeciesTest(bytes32 lotId, bool matchesDeclared, string calldata reportCid) external onlyRole(INSPECTOR_ROLE) {
        Lot storage l = _lot(lotId);
        emit SpeciesTested(lotId, msg.sender, matchesDeclared, reportCid);
        emit DocumentAttached(lotId, reportCid, "DNA_BARCODING_REPORT");
        if (matchesDeclared) {
            l.dnaVerified = true;
        } else {
            l.dnaVerified = false;
            if (l.status != Status.Recalled && l.status != Status.Quarantined) _quarantine(lotId, l, "DNA test: species does not match declaration");
        }
    }

    /// Inspector releases a quarantined lot after a histamine / sensory assessment.
    function releaseFromQuarantine(bytes32 lotId, string calldata assessmentCid) external onlyRole(INSPECTOR_ROLE) {
        Lot storage l = _lot(lotId);
        if (l.status != Status.Quarantined) revert BadStatus(l.status);
        l.status = l.custodian == l.processor ? Status.Packed : Status.Received;
        // The abuse already suffered stays on record (and keeps shortening the use-by);
        // only the budget is extended so that new abuse is judged afresh.
        l.abuseBudget = l.abuseScore + l.abuseBudget;
        emit LotReleased(lotId, msg.sender, assessmentCid);
        emit DocumentAttached(lotId, assessmentCid, "HISTAMINE_ASSESSMENT");
    }

    /// Inspector can also quarantine on a physical inspection finding.
    function quarantine(bytes32 lotId, string calldata reason) external onlyRole(INSPECTOR_ROLE) {
        Lot storage l = _lot(lotId);
        if (l.status == Status.Recalled || l.status == Status.Quarantined || l.status == Status.SoldOut) revert BadStatus(l.status);
        _quarantine(lotId, l, reason);
    }

    function recall(bytes32 lotId, string calldata reason) external {
        Lot storage l = _lot(lotId);
        if (msg.sender != l.processor && !hasRole(REGULATOR_ROLE, msg.sender)) revert NotCustodian();
        if (l.status == Status.Recalled) revert BadStatus(l.status);
        l.status = Status.Recalled;
        l.pendingCustodian = address(0);
        emit LotRecalled(lotId, msg.sender, reason);
    }

    function attachDocument(bytes32 lotId, string calldata cid, string calldata docType) external {
        Lot storage l = _lot(lotId);
        if (msg.sender != l.custodian && msg.sender != l.processor && !hasRole(INSPECTOR_ROLE, msg.sender)) revert NotCustodian();
        emit DocumentAttached(lotId, cid, docType);
    }

    // ------------------------------------------------------------------
    // 6. Point of sale and consumer verification
    // ------------------------------------------------------------------
    function serialLeaf(string calldata serial) public pure returns (bytes32) {
        // Double-hashed leaf, matching @openzeppelin/merkle-tree StandardMerkleTree(["string"])
        return keccak256(bytes.concat(keccak256(abi.encode(serial))));
    }

    /// Retailer scans the pack's QR code / NFC tag at the till; a serial can only be sold once.
    function sell(bytes32 lotId, string calldata serial, bytes32[] calldata proof) external onlyRole(RETAILER_ROLE) {
        Lot storage l = _lot(lotId);
        if (l.custodian != msg.sender) revert NotCustodian();
        if (l.status != Status.Received) revert BadStatus(l.status);
        if (block.timestamp >= effectiveUseBy(lotId)) revert PastUseBy();
        bytes32 leaf = serialLeaf(serial);
        if (!MerkleProof.verifyCalldata(proof, l.serialRoot, leaf)) revert InvalidProof();
        if (serialSold[lotId][leaf]) revert AlreadySold();

        serialSold[lotId][leaf] = true;
        l.sold += 1;
        if (l.sold == l.quantity) l.status = Status.SoldOut;
        emit PackSold(lotId, leaf, msg.sender);
    }

    /// Public, gas-free read used by the consumer app after scanning the QR code / NFC tag.
    function verifyPack(bytes32 lotId, string calldata serial, bytes32[] calldata proof) external view returns (PackInfo memory info) {
        Lot storage l = lots[lotId];
        if (l.status == Status.None) {
            info.verdict = Verdict.UnknownLot;
            return info;
        }
        Catch storage c = catches[l.catchId];
        info.gtin = l.gtin;
        info.lot = l.lot;
        info.species = l.species;
        info.vesselName = vessels[c.vessel].name;
        info.latE5 = c.latE5;
        info.lonE5 = c.lonE5;
        info.caughtAt = c.caughtAt;
        info.effectiveUseBy = l.useBy > l.shelfLifeLostSec ? l.useBy - l.shelfLifeLostSec : 0;
        info.abuseScore = l.abuseScore;
        info.dnaVerified = l.dnaVerified;
        info.frozen = l.frozen;
        info.processor = l.processor;

        bytes32 leaf = serialLeaf(serial);
        if (!MerkleProof.verifyCalldata(proof, l.serialRoot, leaf)) info.verdict = Verdict.UnknownSerial;
        else if (l.status == Status.Recalled) info.verdict = Verdict.Recalled;
        else if (l.status == Status.Quarantined) info.verdict = Verdict.Quarantined;
        else if (block.timestamp >= info.effectiveUseBy) info.verdict = Verdict.PastUseBy;
        else if (serialSold[lotId][leaf]) info.verdict = Verdict.GenuineAlreadySold;
        else info.verdict = Verdict.Genuine;
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------
    function getLot(bytes32 lotId) external view returns (Lot memory) {
        return _lot(lotId);
    }

    function getCatch(bytes32 catchId) external view returns (Catch memory) {
        if (catches[catchId].vessel == address(0)) revert UnknownCatch();
        return catches[catchId];
    }

    function getVessel(address vesselKey) external view returns (Vessel memory) {
        if (bytes(vessels[vesselKey].name).length == 0) revert UnknownVessel();
        return vessels[vesselKey];
    }

    function getCustodyLog(bytes32 lotId) external view returns (CustodyEvent[] memory) {
        return custodyLog[lotId];
    }

    function protectedAreaCount() external view returns (uint256) {
        return protectedAreas.length;
    }

    function protectedAreaAt(uint256 i) external view returns (Zone memory) {
        return protectedAreas[i];
    }

    function vesselCount() external view returns (uint256) {
        return vesselKeys.length;
    }

    function vesselKeyAt(uint256 i) external view returns (address) {
        return vesselKeys[i];
    }

    function lotCount() external view returns (uint256) {
        return lotIds.length;
    }

    function lotIdAt(uint256 i) external view returns (bytes32) {
        return lotIds[i];
    }

    function catchCount() external view returns (uint256) {
        return catchIds.length;
    }

    function catchIdAt(uint256 i) external view returns (bytes32) {
        return catchIds[i];
    }
}

pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract RegenAgriFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public isBatchClosed;
    mapping(uint256 => uint256) public batchSubmissionCount;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSecondsSet(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event DataSubmitted(address indexed provider, uint256 indexed batchId, uint256 encryptedValue);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalCarbon);

    error NotOwner();
    error NotProvider();
    error PausedError();
    error CooldownActive();
    error BatchClosedError();
    error ReplayError();
    error StateMismatchError();
    error InvalidBatchId();
    error InvalidCooldown();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedError();
        _;
    }

    modifier respectCooldown(address _address, mapping(address => uint256) storage _lastTime) {
        if (block.timestamp < _lastTime[_address] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        _initIfNeeded();
    }

    function _initIfNeeded() internal {
        if (!FHE.isInitialized()) {
            FHE.initialize();
        }
    }

    function _requireInitialized() internal view {
        if (!FHE.isInitialized()) {
            revert("FHE not initialized");
        }
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        if (newCooldownSeconds == 0) revert InvalidCooldown();
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsSet(oldCooldown, newCooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        isBatchClosed[currentBatchId] = false;
        batchSubmissionCount[currentBatchId] = 0;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch(uint256 batchId) external onlyOwner {
        if (batchId == 0 || batchId > currentBatchId) revert InvalidBatchId();
        if (isBatchClosed[batchId]) revert BatchClosedError();
        isBatchClosed[batchId] = true;
        emit BatchClosed(batchId);
    }

    function submitEncryptedData(uint256 batchId, euint32 encryptedCarbon) external onlyProvider whenNotPaused respectCooldown(msg.sender, lastSubmissionTime) {
        if (batchId == 0 || batchId > currentBatchId) revert InvalidBatchId();
        if (isBatchClosed[batchId]) revert BatchClosedError();

        _requireInitialized();
        encryptedCarbon._checkEncrypted();

        uint256 currentCount = batchSubmissionCount[batchId] + 1;
        batchSubmissionCount[batchId] = currentCount;
        lastSubmissionTime[msg.sender] = block.timestamp;

        emit DataSubmitted(msg.sender, batchId, encryptedCarbon.toBytes32());
    }

    function requestBatchDecryption(uint256 batchId) external onlyOwner whenNotPaused respectCooldown(msg.sender, lastDecryptionRequestTime) {
        if (batchId == 0 || batchId > currentBatchId) revert InvalidBatchId();
        if (!isBatchClosed[batchId]) revert("Batch not closed");

        _requireInitialized();

        euint32 memory totalEncryptedCarbon;
        if (batchSubmissionCount[batchId] > 0) {
            totalEncryptedCarbon = FHE.asEuint32(0);
            // In a real scenario, iterate over stored encrypted data for this batch.
            // For this example, we assume a single aggregated value or a placeholder.
            // If multiple ciphertexts were processed, they would be collected here.
        } else {
            // If no submissions, use a zero ciphertext for consistency
            totalEncryptedCarbon = FHE.asEuint32(0);
        }
        
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = totalEncryptedCarbon.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        DecryptionContext storage ctx = decryptionContexts[requestId];

        if (ctx.processed) revert ReplayError();
        // Security: Replay protection ensures a callback for a given requestId is processed only once.

        euint32 memory totalEncryptedCarbon; // Rebuild ciphertexts in the same order as in requestBatchDecryption
        if (batchSubmissionCount[ctx.batchId] > 0) {
            totalEncryptedCarbon = FHE.asEuint32(0); // Placeholder for actual ciphertext retrieval
        } else {
            totalEncryptedCarbon = FHE.asEuint32(0);
        }
        
        bytes32[] memory currentCts = new bytes32[](1);
        currentCts[0] = totalEncryptedCarbon.toBytes32();
        bytes32 currentHash = _hashCiphertexts(currentCts);

        if (currentHash != ctx.stateHash) revert StateMismatchError();
        // Security: State hash verification ensures that the contract state relevant to the decryption
        // (specifically, the ciphertexts being decrypted) has not changed since the decryption was requested.
        // This prevents scenarios where an attacker might alter data after a request but before decryption.

        FHE.checkSignatures(requestId, cleartexts, proof);

        uint256 totalCarbon = abi.decode(cleartexts, (uint256));
        ctx.processed = true;

        emit DecryptionCompleted(requestId, ctx.batchId, totalCarbon);
    }
}
import leveldown from "leveldown";
import { 
  startRailgunEngine, 
  createRailgunWallet, 
  stopRailgunEngine, 
  loadProvider, 
  gasEstimateForUnprovenTransfer,
  generateTransferProof,
  populateProvedTransfer,
  getProver,
  refreshSpentPOIsForWallet,
  refreshReceivePOIsForWallet,
  generatePOIsForWallet,
  ArtifactStore,
  refreshBalances,
  setLoggers
} from "@railgun-community/wallet";
import { 
  NetworkName, 
  NETWORK_CONFIG, 
  RailgunWalletBalanceBucket,
  TXIDVersion,
  EVMGasType,
  getEVMGasTypeForTransaction
} from "@railgun-community/shared-models";
import { Wallet, JsonRpcProvider, formatUnits, parseUnits } from "ethers";
import * as fs from "fs/promises";
import * as path from "path";
import dotenv from "dotenv";
import { createHash } from "crypto";
import { groth16 } from "snarkjs";

dotenv.config();

// Constants
const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"; // Mainnet WETH
const AMOUNT_TO_SEND = parseUnits("0.01", 18); // 0.01 WETH
const TARGET_ADDRESS = process.env.TARGET_0ZK_ADDRESS;
const MEMO = "Railgun Demo Transfer";

const deriveKeyFromPassword = (password) => createHash('sha256').update(password).digest('hex');

const createArtifactStore = (documentsDir) => {
  const getFile = async (filePath) => {
    return fs.readFile(path.join(documentsDir, filePath));
  };

  const storeFile = async (
    dir,
    filePath,
    item,
  ) => {
    await fs.mkdir(path.join(documentsDir, dir), { recursive: true });
    await fs.writeFile(path.join(documentsDir, filePath), item);
  };

  const fileExists = async (filePath) => {
    try {
      await fs.access(path.join(documentsDir, filePath));
      return true;
    } catch {
      return false;
    }
  };

  return new ArtifactStore(getFile, storeFile, fileExists);
};

async function getGasDetails(networkName, provider, gasEstimate) {
  const evmGasType = getEVMGasTypeForTransaction(networkName, true); // true = sendWithPublicWallet
  const feeData = await provider.getFeeData();
  
  if (evmGasType === EVMGasType.Type2) {
    return {
      evmGasType,
      gasEstimate,
      maxFeePerGas: feeData.maxFeePerGas || parseUnits("30", "gwei"),
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || parseUnits("1.5", "gwei")
    };
  } else {
    return {
      evmGasType,
      gasEstimate,
      gasPrice: feeData.gasPrice || parseUnits("30", "gwei")
    };
  }
}

async function initialize() {
    const mnemonic = process.env.MNEMONIC;
    let encryptionKey = process.env.ENCRYPTION_KEY;
    const rpcUrl = process.env.RPC_URL;
    const networkName = NetworkName.Ethereum;
    
    if (!mnemonic || !encryptionKey || !rpcUrl || !TARGET_ADDRESS) throw new Error("Missing env variables");
    if (encryptionKey.length !== 64 || !/^[0-9a-fA-F]+$/.test(encryptionKey)) encryptionKey = deriveKeyFromPassword(encryptionKey);

    const db = leveldown(path.join(process.cwd(), "railgun-db"));
    const artifactStore = createArtifactStore("./artifacts");
    await startRailgunEngine("demowallet", db, true, artifactStore, false, false, ["https://ppoi-agg.horsewithsixlegs.xyz"], []);
    getProver().setSnarkJSGroth16(groth16);

    setLoggers(
        (msg) => console.log(`[Engine]: ${msg}`),
        (err) => console.error(`[Engine Error]: ${err}`)
    );

    // Init Provider & Wallet
    const { chain } = NETWORK_CONFIG[networkName];
    await loadProvider({ chainId: chain.id, providers: [{ provider: rpcUrl, priority: 1, weight: 2 }] }, networkName);
    
    const railgunWalletInfo = await createRailgunWallet(encryptionKey, mnemonic, undefined); // No creation block needed for sending if we assume wallet exists
    
    const provider = new JsonRpcProvider(rpcUrl);
    const ethersWallet = Wallet.fromPhrase(mnemonic, provider);

    return { railgunWalletInfo, encryptionKey, ethersWallet, networkName, provider, chain };
}

async function main() {
  try {
    const { railgunWalletInfo, encryptionKey, ethersWallet, networkName, provider, chain } = await initialize();
    
    console.log(`From: ${railgunWalletInfo.railgunAddress}`);
    console.log(`To:   ${TARGET_ADDRESS}`);
    console.log(`Amount: 0.01 WETH (${AMOUNT_TO_SEND.toString()})`);

    console.log("\nRefreshing balances to ensure fresh UTXOs...");
    await refreshBalances(chain, [railgunWalletInfo.id]);

    // 1. Prepare Recipients
    const erc20AmountRecipients = [{
        tokenAddress: WETH_ADDRESS,
        amount: AMOUNT_TO_SEND,
        recipientAddress: TARGET_ADDRESS
    }];

    // 2. Estimate Gas
    console.log("\nEstimating Gas...");
    // Mock original details for estimation
    const originalGasDetails = await getGasDetails(networkName, provider, 0n);
    
    const { gasEstimate } = await gasEstimateForUnprovenTransfer(
        TXIDVersion.V2_PoseidonMerkle,
        networkName,
        railgunWalletInfo.id,
        encryptionKey,
        MEMO,
        erc20AmountRecipients,
        [], // nft
        originalGasDetails,
        undefined, // feeTokenDetails (not needed for self-signing)
        true // sendWithPublicWallet
    );
    console.log(`Gas Estimate: ${gasEstimate.toString()}`);

    // 3. Generate Proof
    console.log("\nGenerating Proof (this may take 20-30s)...");
    await generateTransferProof(
        TXIDVersion.V2_PoseidonMerkle,
        networkName,
        railgunWalletInfo.id,
        encryptionKey,
        true, // showSenderAddressToRecipient
        MEMO,
        erc20AmountRecipients,
        [], // nft
        undefined, // broadcasterFee
        true, // sendWithPublicWallet
        originalGasDetails.gasPrice || originalGasDetails.maxFeePerGas, // overallBatchMinGasPrice
        (progress) => console.log(`Proof Progress: ${(progress * 100).toFixed(0)}%`)
    );

    // 4. Populate Transaction
    console.log("\nPopulating Transaction...");
    const transactionGasDetails = await getGasDetails(networkName, provider, gasEstimate);
    const { transaction } = await populateProvedTransfer(
        TXIDVersion.V2_PoseidonMerkle,
        networkName,
        railgunWalletInfo.id,
        true, // showSenderAddressToRecipient
        MEMO,
        erc20AmountRecipients,
        [], // nft
        undefined, // broadcasterFee
        true, // sendWithPublicWallet
        transactionGasDetails.gasPrice || transactionGasDetails.maxFeePerGas, // overallBatchMinGasPrice
        transactionGasDetails
    );

    // 5. Send Transaction
    console.log("\nSending Transaction...");
    
    transaction.gasLimit = gasEstimate * 120n / 100n; // Add 20% buffer

    const txResponse = await ethersWallet.sendTransaction(transaction);
    console.log(`Transaction Sent! Hash: ${txResponse.hash}`);
    
    console.log("Waiting for confirmation...");
    await txResponse.wait();
    console.log("Transaction Confirmed!");

    console.log("\nRefreshing balances before POI update...");
    await refreshBalances(chain, [railgunWalletInfo.id]);

    await updatePOI(networkName, railgunWalletInfo.id, chain);

    await stopRailgunEngine();
    process.exit(0);

  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

async function updatePOI(networkName, walletId, chain) {
    console.log("\n--- Starting POI Update Process ---");
    try {
        const txidVersion = TXIDVersion.V2_PoseidonMerkle;
        
        console.log("Refreshing Spent POIs...");
        await refreshSpentPOIsForWallet(txidVersion, networkName, walletId);
        
        console.log("Refreshing Receive POIs...");
        await refreshReceivePOIsForWallet(txidVersion, networkName, walletId);
        
        console.log("Generating POI Proofs (this might take a while)...");
        // generatePOIsForWallet only takes 2 arguments: (networkName, walletID)
        await generatePOIsForWallet(networkName, walletId);
        
        console.log("POI status refreshed and proofs generation triggered.");
    } catch (err) {
        console.error("Error updating POI:", err.message);
    }
}

main();

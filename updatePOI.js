import leveldown from "leveldown";
import { 
  startRailgunEngine, 
  createRailgunWallet, 
    stopRailgunEngine,
    loadProvider,
      refreshSpentPOIsForWallet,
      refreshReceivePOIsForWallet,
      generatePOIsForWallet,
      refreshBalances,
      ArtifactStore,      getProver,
      setLoggers
    } from "@railgun-community/wallet";
import { 
  NetworkName, 
  NETWORK_CONFIG, 
  TXIDVersion 
} from "@railgun-community/shared-models";
import * as fs from "fs/promises";
import * as path from "path";
import dotenv from "dotenv";
import { createHash } from "crypto";
import { groth16 } from "snarkjs";

dotenv.config();

const deriveKeyFromPassword = (password) => createHash('sha256').update(password).digest('hex');

const createArtifactStore = (documentsDir) => {
  const getFile = async (filePath) => {
    return fs.readFile(path.join(documentsDir, filePath));
  };
  const storeFile = async (dir, filePath, item) => {
    await fs.mkdir(path.join(documentsDir, dir), { recursive: true });
    await fs.writeFile(path.join(documentsDir, filePath), item);
  };
  const fileExists = async (filePath) => {
    try { await fs.access(path.join(documentsDir, filePath)); return true; } catch { return false; }
  };
  return new ArtifactStore(getFile, storeFile, fileExists);
};

async function initialize() {
    const mnemonic = process.env.MNEMONIC;
    let encryptionKey = process.env.ENCRYPTION_KEY;
    const rpcUrl = process.env.RPC_URL;
    const networkName = NetworkName.Ethereum;

    if (!mnemonic || !encryptionKey || !rpcUrl) throw new Error("Missing env variables");
    if (encryptionKey.length !== 64 || !/^[0-9a-fA-F]+$/.test(encryptionKey)) encryptionKey = deriveKeyFromPassword(encryptionKey);

    const db = leveldown(path.join(process.cwd(), "railgun-db"));
    const artifactStore = createArtifactStore("./artifacts");
    const poiNodeURLs = ["https://ppoi-agg.horsewithsixlegs.xyz"];

    console.log("Starting Engine...");
    await startRailgunEngine("demowallet", db, true, artifactStore, false, false, poiNodeURLs, []);
    getProver().setSnarkJSGroth16(groth16);
    
    setLoggers(
        (msg) => console.log(`[Engine]: ${msg}`),
        (err) => console.error(`[Engine Error]: ${err}`)
    );

    const { chain } = NETWORK_CONFIG[networkName];
    console.log("Loading Provider...");
    await loadProvider({ chainId: chain.id, providers: [{ provider: rpcUrl, priority: 1, weight: 2 }] }, networkName);
    
    console.log("Loading Wallet...");
    // Assuming wallet already exists in DB, passing undefined creation block is faster but requires existing sync
    const railgunWalletInfo = await createRailgunWallet(encryptionKey, mnemonic, undefined);
    
    return { railgunWalletInfo, chain, networkName };
}

async function main() {
  try {
    const { railgunWalletInfo, chain, networkName } = await initialize();
    console.log(`Wallet loaded: ${railgunWalletInfo.railgunAddress}`);

    const txidVersion = TXIDVersion.V2_PoseidonMerkle;
    const walletId = railgunWalletInfo.id;

    await refreshBalances(chain, [walletId]);

    await refreshSpentPOIsForWallet(txidVersion, networkName, walletId);
    console.log("Spent POIs refreshed.");

    await refreshReceivePOIsForWallet(txidVersion, networkName, walletId);
    console.log("Receive POIs refreshed.");

    await generatePOIsForWallet(networkName, walletId);
    console.log("POI Proofs generation triggered.");
    

  } catch (error) {
    console.error("Error during POI update:", error);
  } finally {
    await stopRailgunEngine();
    process.exit(0);
  }
}

main();

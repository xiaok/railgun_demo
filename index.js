import leveldown from "leveldown";
import { 
  startRailgunEngine, 
  createRailgunWallet, 
  stopRailgunEngine, 
  loadProvider, 
  refreshBalances, 
  setOnBalanceUpdateCallback,
  setOnUTXOMerkletreeScanCallback,
  setOnTXIDMerkletreeScanCallback,
  getProver
} from "@railgun-community/wallet";
import { NetworkName, NETWORK_CONFIG, RailgunWalletBalanceBucket } from "@railgun-community/shared-models";
import * as fs from "fs/promises";
import * as path from "path";
import dotenv from "dotenv";
import { createHash } from "crypto";
import { groth16 } from "snarkjs";

dotenv.config();

const deriveKeyFromPassword = (password) => {
  return createHash('sha256').update(password).digest('hex');
};

const createArtifactStore = (dir) => ({
  artifactExists: async (p) => { try { await fs.access(path.join(dir, p)); return true; } catch { return false; } },
  get: async (p) => { try { return await fs.readFile(path.join(dir, p)); } catch { return undefined; } },
  storeArtifact: async (p, d) => { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, p), d); },
  removeArtifact: async (p) => { try { await fs.unlink(path.join(dir, p)); } catch {} },
});

async function initializeRailgun() {
    const mnemonic = process.env.MNEMONIC;
    let encryptionKey = process.env.ENCRYPTION_KEY;
    const rpcUrl = process.env.RPC_URL;
    const networkName = NetworkName.Ethereum;
    const creationBlock = parseInt(process.env.CREATION_BLOCK || "0");

    if (!mnemonic || !encryptionKey || !rpcUrl) {
        throw new Error("Missing required env variables");
    }

    if (encryptionKey.length !== 64 || !/^[0-9a-fA-F]+$/.test(encryptionKey)) {
        encryptionKey = deriveKeyFromPassword(encryptionKey);
    }

    const dbPath = path.join(process.cwd(), "railgun-db");
    const db = leveldown(dbPath);
    const artifactStore = createArtifactStore("./artifacts");
    const poiNodeURLs = ["https://ppoi-agg.horsewithsixlegs.xyz"];
    
    await startRailgunEngine("demowallet", db, true, artifactStore, false, false, poiNodeURLs, []);
    
    getProver().setSnarkJSGroth16(groth16);

    const { chain } = NETWORK_CONFIG[networkName];
    await loadProvider({
        chainId: chain.id,
        providers: [{ provider: rpcUrl, priority: 1, weight: 2 }]
    }, networkName);

    console.log("Creating/Restoring wallet from mnemonic...");
    const creationBlockNumbers = { [networkName]: creationBlock };
    const railgunWalletInfo = await createRailgunWallet(encryptionKey, mnemonic, creationBlockNumbers);

    return { 
        walletInfo: railgunWalletInfo, 
        chain: chain 
    };
}

function setupScanCallbacks(chain) {
    setOnUTXOMerkletreeScanCallback((event) => {
        // console.log(`UTXO Scan: ${(event.progress * 100).toFixed(1)}%`);
    });
    
    setOnTXIDMerkletreeScanCallback((event) => {
        // console.log(`TXID Scan: ${(event.progress * 100).toFixed(1)}%`);
    });
}

async function fetchBalances(walletInfo, chain) {
    const balances = {};
    
    setOnBalanceUpdateCallback((balancesEvent) => {
        if (balancesEvent.chain.id !== chain.id) return;
        if (balancesEvent.railgunWalletID !== walletInfo.id) return;
        
        balances[balancesEvent.balanceBucket] = balancesEvent.erc20Amounts;
        console.log(`Balance update for ${balancesEvent.balanceBucket}: ${balancesEvent.erc20Amounts.length} tokens found`);
    });

    console.log("Triggering balance refresh...");
    await refreshBalances(chain, [walletInfo.id]);
    
    return balances;
}

const main = async () => {
  try {
    const { walletInfo, chain } = await initializeRailgun();
    
    console.log(`0zk Address: ${walletInfo.railgunAddress}`);

    setupScanCallbacks(chain);
    
    console.log("Scanning balances (this may take time)...");
    const finalBalances = await fetchBalances(walletInfo, chain);

    console.log("\n--- Final Balances ---");
    const buckets = [
        RailgunWalletBalanceBucket.Spendable,
        RailgunWalletBalanceBucket.ShieldPending,
        RailgunWalletBalanceBucket.ShieldBlocked
    ];

    buckets.forEach(bucket => {
        const amounts = finalBalances[bucket] || [];
        if (amounts.length > 0) {
            console.log(`[${bucket}]`);
            amounts.forEach(t => {
                if (BigInt(t.amount) > 0n) {
                    console.log(`  Token: ${t.tokenAddress}`);
                    console.log(`  Amount: ${t.amount.toString()} (wei)`);
                }
            });
        }
    });

    await stopRailgunEngine();
    process.exit(0);

  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
};

main();

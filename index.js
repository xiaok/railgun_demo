import leveldown from "leveldown";
import RailgunWallet from "@railgun-community/wallet";
import { NetworkName, NETWORK_CONFIG } from "@railgun-community/shared-models";
import * as fs from "fs/promises";
import * as path from "path";
import dotenv from "dotenv";
import { createHash } from "crypto";

const {
  startRailgunEngine,
  createRailgunWallet,
  stopRailgunEngine,
  loadProvider,
  refreshBalances,
  setOnBalanceUpdateCallback
} = RailgunWallet;

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
    
    await startRailgunEngine("demowallet", db, false, artifactStore, false, false, poiNodeURLs, []);

    const { chain } = NETWORK_CONFIG[networkName];
    await loadProvider({
        chainId: chain.id,
        providers: [{ provider: rpcUrl, priority: 1, weight: 2 }]
    }, networkName);

    const creationBlockNumbers = { [networkName]: creationBlock };
    const railgunWalletInfo = await createRailgunWallet(encryptionKey, mnemonic, creationBlockNumbers);

    return { 
        walletInfo: railgunWalletInfo, 
        chain: chain 
    };
}

async function fetchBalances(walletInfo, chain) {
    return new Promise((resolve, reject) => {
        let balancesByBucket = {};
        let completionTimer = null;

        const finish = () => {
            if (completionTimer) clearTimeout(completionTimer);
            resolve(balancesByBucket);
        };

        setOnBalanceUpdateCallback((balancesEvent) => {
            if (balancesEvent.chain.id !== chain.id) return;

            const { erc20Amounts, balanceBucket } = balancesEvent;
            const positiveBalances = erc20Amounts.filter(t => BigInt(t.amount) > 0n);

            if (positiveBalances.length > 0) {
                balancesByBucket[balanceBucket] = positiveBalances;
                if (completionTimer) clearTimeout(completionTimer);
                completionTimer = setTimeout(finish, 5000);
            }
        });

        refreshBalances(chain, [walletInfo.id]).catch(reject);
    });
}

const main = async () => {
  try {
    const { walletInfo, chain } = await initializeRailgun();
    
    console.log(`0zk Address: ${walletInfo.railgunAddress}`);

    console.log("Fetching balances...may cost many times first time");

    const finalBalances = await fetchBalances(walletInfo, chain);

    Object.keys(finalBalances).forEach(bucket => {
        console.log(`\n[${bucket}]`);
        finalBalances[bucket].forEach(t => {
            console.log(`  ${t.tokenAddress}: ${t.amount.toString()} (wei)`);
        });
    });

    await stopRailgunEngine();
    process.exit(0);

  } catch (error) {
    console.error(error);
    process.exit(1);
  }
};

main();

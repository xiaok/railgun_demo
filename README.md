# railgun demo 

index.js - init 0zk wallet and refresh token balances  
private_tx.js - send weth from 0zk address to another 0zk address (including update poi)  
updatePOI.js - update poi, standalone updatePOI interface that can run independently.  

## 遇到的坑 
0. 不要使用 eth 测试网的 railgun 合约测试，因为版本问题已经停止运行很久了，可以直接使用主网的 railgun 合约或者 polygon 主网的合约  
1. 第一次启动程序同步 railgun 数据需要很久，本 demo 已经做了持久化储存，第二次就很快了，本地测试可以把 CREATION_BLOCK 设置成测试钱包的创建区块来提速，生产环境需要设置为对应链的 railgun 合约的部署区块  
2. 对钱包做的任何修改（包括收到钱，包括 update poi）都需要同步余额（refreshBalances）避免报错  
3. railgun 的 ENCRYPTION_KEY 类似于 btc 钱包的设计；即助记词 + 任意 ENCRYPTION_KEY 都会生成固定的 0zk 地址，ENCRYPTION_KEY 作为 walletdb 的 “密码” 存在。这里对于 ETH 开发者来说可能会产生误导，特此提及。所以，在 updatePOI 中，看似 generatePOIsForWallet(networkName, walletId) 只提供了 walletId 一个参数，实际上的需求是 需要 walletdb + ENCRYPTION_KEY，本质上还是需要助记词才能运行。  

## 0zk 地址资金互转和 sheild 的 poi 不同点：

1. 0zk 地址互转： 发送 tx -> 立即生成 poi 证明 -> to 方资金可用
2. sheild 资金： 发送 tx -> 等待一个小时 -> 生成 poi 证明 -> to 方资金可用

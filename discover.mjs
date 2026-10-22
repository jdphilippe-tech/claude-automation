import { ethers } from 'ethers';
const A = '0xF3841e27b27B6bC78Ea4ad2dC9a1882D04F39f93';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const POOL = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
const p = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
const T = ethers.id('Transfer(address,address,uint256)');
const pad = a => ethers.zeroPadValue(a, 32);
const latest = await p.getBlockNumber();
console.log('latest', latest);
const pool = new ethers.Contract(POOL, ['function getReserveData(address) view returns (tuple(uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128))'], p);
const rd = await pool.getReserveData(USDC); const aTok = rd[8];
console.log('aUSDC', aTok);
const erc = ['function balanceOf(address) view returns (uint256)'];
console.log('USDC bal of A', (await new ethers.Contract(USDC, erc, p).balanceOf(A)).toString());
console.log('aUSDC bal of A', (await new ethers.Contract(aTok, erc, p).balanceOf(A)).toString());
console.log('code at A bytes', ((await p.getCode(A)).length - 2) / 2);
const seen = new Set();
const step = 2000;
for (let to = latest; to > latest - 120000; to -= step) {
  const from = to - step + 1;
  for (const [label, topics] of [['IN', [T, null, pad(A)]], ['OUT', [T, pad(A)]]]) {
    try {
      const logs = await p.getLogs({ fromBlock: from, toBlock: to, topics });
      for (const l of logs) {
        const key = l.transactionHash + l.index; if (seen.has(key)) continue; seen.add(key);
        const f = ethers.getAddress('0x' + l.topics[1].slice(26)), t2 = ethers.getAddress('0x' + l.topics[2].slice(26));
        console.log(label, l.blockNumber, 'token', l.address, 'from', f, 'to', t2, 'raw', BigInt(l.data).toString(), 'tx', l.transactionHash);
      }
    } catch (e) { console.log('logs err', from, to, e.message.slice(0, 100)); break; }
  }
  if (seen.size > 30) break;
}

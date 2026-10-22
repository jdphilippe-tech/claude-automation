import { ethers } from 'ethers';
const A = '0xF3841e27b27B6bC78Ea4ad2dC9a1882D04F39f93';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const AUSDC = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB';
const FACTORY = '0xC49B1438c8639AB48953e9091E5277D4C65003f0';
const p = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
const f = new ethers.Contract(FACTORY, ['function calculateYieldModuleAddress(address) view returns (address)', 'function implementation() view returns (address)'], p);
try { console.log('impl', await f.implementation()); } catch (e) { console.log('impl err', e.shortMessage ?? e.message); }
let m;
try { m = await f.calculateYieldModuleAddress(A); console.log('module', m); } catch (e) { console.log('calc err', e.shortMessage ?? e.message); }
if (m) {
  console.log('module code bytes', ((await p.getCode(m)).length - 2) / 2);
  const mod = new ethers.Contract(m, ['function effectiveBalance(address) view returns (uint)', 'function protocolBalance(address) view returns (uint)', 'function effectiveProtocolBalance(address) view returns (uint)', 'function calculateServiceFee(address) view returns (uint)', 'function owner() view returns (address)'], p);
  for (const fn of ['effectiveBalance', 'protocolBalance', 'effectiveProtocolBalance', 'calculateServiceFee']) {
    try { console.log(fn, (await mod[fn](USDC)).toString()); } catch (e) { console.log(fn, 'err', e.shortMessage ?? e.message); }
  }
  try { console.log('owner', await mod.owner()); } catch (e) { console.log('owner err', e.shortMessage ?? e.message); }
  const erc = ['function balanceOf(address) view returns (uint256)'];
  console.log('aUSDC of module', (await new ethers.Contract(AUSDC, erc, p).balanceOf(m)).toString());
  console.log('USDC of module', (await new ethers.Contract(USDC, erc, p).balanceOf(m)).toString());
}

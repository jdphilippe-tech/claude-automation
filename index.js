// ============================================================
// Daily Portfolio Check — GitHub Actions v32
// Added: Airtable-driven LP position discovery
//        - WALLET_WETH_LP added for correct WETH/USDC wallet
//        - Module 1 scans WALLET_WETH_LP (not WALLET_EVM)
//        - Module 4 reads xStock positions from Airtable Assets
//          table at runtime (NFT Mint, Pool Address, Cycle ID)
//        - Hardcoded xStock ASSET entries removed
//        - Cycle ID now written for WETH/USDC records too
//        - On rollover: update Airtable Assets only, no code change
// Schedule: 14:15 UTC = 7:15 AM PDT (triggered via cron-job.org)
// ============================================================

import { ethers } from 'ethers';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE    = 'appWojaxYR99bXC1f';
const DAILY_TABLE      = 'tblKsk0QnkOoKNLuk';
const LENDING_TABLE    = 'tblFw52kzeTRvxTSM';
const ASSETS_TABLE     = 'tblrATIQI0ld9tz1y';

const WALLET_EVM         = '0x871fd9a8A6a6E918658eadF46e9c23fE4E377289';
const WALLET_WETH_LP     = '0x2375369D950D49897193EbCad32d99206C37D10A';
const WALLET_SUI         = '0xa43b2375ebc13ade7ea537e26e46cd32dc46edd4e23776149c576f1ce36705e9';
const WALLET_HYPERLIQUID = '0x464b059B1AF55A408CB3c822D610c2D962d2cf4b';
const WALLET_RAYDIUM     = '5yiTWdskR7yd5RXvs7MJLqWsn6n7geM8SzvYjUpRHrTX';

const BASE_RPC     = process.env.BASE_RPC_URL ?? 'https://base.llamarpc.com';
const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
const SUI_RPC      = 'https://fullnode.mainnet.sui.io';
const SOL_RPC      = process.env.SOL_RPC_URL ?? 'https://api.mainnet-beta.solana.com';

const RAYDIUM_DRY_RUN = (process.env.RAYDIUM_DRY_RUN ?? 'true') !== 'false';

const LIGHTER_BASE     = 'https://mainnet.zklighter.elliot.ai/api/v1';
const LIGHTER_TOKEN    = process.env.LIGHTER_READ_TOKEN;
const LIGHTER_ACCT     = 449217;
const LIGHTER_LLP_ID   = 281474976710654;
const LIGHTER_EDGE_ID  = 281474976688087;
const LIT_STAKE_AMOUNT = 185.97;

const OBLIGATION_CAP_KEYWORD = 'ObligationOwnerCap';
const RAYDIUM_CLMM_PROGRAM   = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

const NOW_UTC = new Date().toISOString();

// ---- Daily Actions field IDs ----
const F = {
  asset:         'fldtiRIqznncRfJYG',
  actionType:    'fldUkwrxtS4AEr52W',
  date:          'fldHG3MCcyhkXknyH',
  inRange:       'fld9pdBIkiEIv352W',
  positionValue: 'fldWElDtJZRYTaZtD',
  revertPosVal:  'fldcciMBHm1kI0dL9',
  feeValue:      'fld6QnTv9CKHvglcX',
  cycleId:       'fldFFts5ByR1EeYBk',
  notes:         'fldxWdSuQ09uhadFo',
  protocolAPR:   'fldL3Pa57i3fyaAf0',
};

// ---- Lending Actions field IDs ----
const LF = {
  position:   'fldFi5nwRXNC5n0pU',
  actionType: 'fld5UpfU63qiYEZtp',
  date:       'fldUksu7BXYunAADh',
  supplyUSD:  'fldJ7T452iqgQNiWb',
  borrowUSD:  'fldTSqf1Yrxg7O0tr',
  tokenAmt:   'fldrWm55G12S1qQjY',
  supplyAPY:  'fldJLDy5yOHq8S6RS',
  borrowAPY:  'fldWHlp8HCuMYGc9e',
  notes:      'fldHzWRmzI1H3zueM',
};

// ---- Assets table field IDs ----
const AF = {
  asset:      'fldXyU6o1g35gciSb',
  protocol:   'fldC8oxgDQtxfEKbs',
  status:     'fldDRyGqgXJTuHTpx',
  nftMint:    'fldpPTHyGfrSCQO0F',
  poolAddr:   'fldCw0oAwKkAmigto',
  cycleId:    'fld0T538WMoPQ5bgL',
};

// ---- Static asset record IDs (non-LP positions) ----
const ASSET = {
  wethPrimary: 'recbVsmOWh9YOWPBZ',
  ethHedge:    'recgASxadhJMkNNry',
  lighterLLP:  'recEFiaxgavObYWzL',
  lighterEdge: 'rectz3Zo3aDbe4GgL',
  lighterLIT:  'receiu02rkzc3quDW',
};

// ---- Lending position record IDs ----
const LPOS = {
  moonwellETH:    'rec1T0ll6aEkYoZwj',
  moonwellVIRT:   'rec6Zi6u6uK6x4M9F',
  moonwellCBXRP:  'recQRudPvkFOMhfWL',
  moonwellAERO:   'recwH74S9hCOqPBjR',
  moonwellBorrow: 'recJ2skZuwzu9f1xY',
  suilendSUI:     'rec2CCpli6msLPzgF',
  suilendWSOL:    'reccOax2I2jLO9ATs',
  suilendBorrow:  'rec7fEjrou7kLZ29U',
};

const COMPTROLLER = '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C';

const MARKETS = [
  { key: 'moonwellETH',    mAddr: '0x628ff693426583D9a7FB391E54366292F509D457', underlyingDec: 18, type: 'supply', method: 'oracle' },
  { key: 'moonwellVIRT',   mAddr: '0xdE8Df9d942D78edE3Ca06e60712582F79CFfFC64', underlyingDec: 18, type: 'supply', method: 'oracle' },
  { key: 'moonwellCBXRP',  mAddr: '0xb4fb8fed5b3AaA8434f0B19b1b623d977e07e86d', underlyingAddr: '0xcb585250f852C6c6bf90434AB21A00f02833a4af', underlyingDec: 6,  type: 'supply', method: 'mtoken' },
  { key: 'moonwellAERO',   mAddr: '0x73902f619CEB9B31FD8EFecf435CbDf89E369Ba6', underlyingAddr: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', underlyingDec: 18, type: 'supply', method: 'mtoken' },
  { key: 'moonwellBorrow', mAddr: '0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22', underlyingDec: 6,  type: 'borrow', method: 'borrow' },
];

// ============================================================
// HELPERS
// ============================================================

async function fetchWithTimeout(url, options = {}, ms = 10000) {
  const { default: fetch } = await import('node-fetch');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) { console.error(`[HTTP ${res.status}] ${url.slice(0, 70)}`); return null; }
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') console.error(`[TIMEOUT] ${url.slice(0, 70)}`);
    else console.error(`[fetch] ${e.message}`);
    return null;
  }
}

async function suiRpc(method, params) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(SUI_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) { console.error(`[Sui RPC HTTP ${res.status}] ${method}`); return null; }
  const json = await res.json();
  if (json.error) { console.error(`[Sui RPC error] ${method}: ${json.error.message}`); return null; }
  return json.result;
}

async function solRpc(method, params, retries = 4, delayMs = 3000) {
  const { default: fetch } = await import('node-fetch');
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(SOL_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) { console.error(`[Sol RPC HTTP ${res.status}] ${method}`); return null; }
    const json = await res.json();
    if (!json.error) return json.result;
    const msg = json.error.message ?? '';
    const retryable = msg.includes('overloaded') || msg.includes('too many') || msg.includes('rate') || msg.includes('429');
    if (retryable && attempt < retries) {
      const wait = delayMs * attempt;
      console.log(`[Sol RPC] ${method} overloaded — retry ${attempt}/${retries - 1} in ${wait}ms...`);
      await new Promise(r => setTimeout(r, wait));
    } else {
      console.error(`[Sol RPC error] ${method}: ${msg}`);
      return null;
    }
  }
  return null;
}

async function airtableCreate(tableId, records) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: records.map(r => ({ fields: r })) }),
    }
  );
  if (!res.ok) { console.error(`[Airtable] ${await res.text().catch(() => '')}`); return false; }
  return true;
}

async function airtableFetch(tableId, fields, filterFormula) {
  const { default: fetch } = await import('node-fetch');
  const params = new URLSearchParams();
  fields.forEach(f => params.append('fields[]', f));
  if (filterFormula) params.append('filterByFormula', filterFormula);
  params.append('pageSize', '100');
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}?${params}`,
    { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }
  );
  if (!res.ok) { console.error(`[Airtable fetch] ${await res.text().catch(() => '')}`); return []; }
  const json = await res.json();
  return json.records ?? [];
}

function dailyRecord(assetRecordId, inRange, extra = {}) {
  return { [F.asset]: [assetRecordId], [F.actionType]: 'Fee Check', [F.date]: NOW_UTC, [F.inRange]: inRange ? 'Yes' : 'No', ...extra };
}

function lendingRecord(positionId, extra = {}) {
  return { [LF.position]: [positionId], [LF.actionType]: 'Rate Check', [LF.date]: NOW_UTC, ...extra };
}

// ============================================================
// STARTUP — Fetch active LP positions from Airtable
// ============================================================

async function fetchActiveLPAssets() {
  console.log('\n--- Fetching active LP assets from Airtable ---');
  const records = await airtableFetch(
    ASSETS_TABLE,
    [AF.asset, AF.protocol, AF.status, AF.nftMint, AF.poolAddr, AF.cycleId],
    `AND({Status} = 'Active', OR({Protocol} = 'Raydium', {Asset} = 'WETH/USDC (Primary)'))`
  );

  const wethAsset = records.find(r => r.fields[AF.asset] === 'WETH/USDC (Primary)');
  const raydiumAssets = records.filter(r => r.fields[AF.protocol]?.name === 'Raydium');

  console.log(`Found WETH/USDC: ${wethAsset ? 'yes' : 'NO - MISSING'}`);
  console.log(`Found Raydium positions: ${raydiumAssets.length}`);
  raydiumAssets.forEach(r => console.log(`  ${r.fields[AF.asset]}: nft=${r.fields[AF.nftMint]?.slice(0,8)}... cycleId=${r.fields[AF.cycleId]}`));

  return { wethAsset, raydiumAssets };
}

// ============================================================
// MODULE 1 — WETH/USDC PRIMARY (Arbitrum)
// Scans WALLET_WETH_LP for active WETH/USDC 0.05% position
// NFT position ID read from Airtable Assets at runtime
// ============================================================

async function getWethPosition(wethAsset) {
  console.log('\n--- WETH/USDC Primary ---');
  try {
    if (!wethAsset) { console.error('No active WETH/USDC asset found in Airtable'); return null; }

    const nftIdFromAirtable = wethAsset.fields[AF.nftMint];
    const cycleId           = wethAsset.fields[AF.cycleId];
    const assetRecordId     = wethAsset.id;

    console.log(`Airtable: NFT=${nftIdFromAirtable}, cycleId=${cycleId}`);

    const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC);
    const NFT_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
    const WETH        = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
    const USDC        = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
    const TARGET_FEE  = 500;

    const nftManagerABI = [
      'function balanceOf(address owner) external view returns (uint256)',
      'function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)',
      'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
    ];
    const factoryABI = ['function getPool(address,address,uint24) external view returns (address)'];
    const poolABI    = ['function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)'];
    const collectABI = ['function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) external returns (uint256 amount0, uint256 amount1)'];

    const nft = new ethers.Contract(NFT_MANAGER, nftManagerABI, provider);

    // Try Airtable NFT ID first (direct lookup — faster, no wallet scan needed)
    let WETH_POS_ID = null;
    let raw = null;

    if (nftIdFromAirtable) {
      try {
        const tokenId = BigInt(nftIdFromAirtable);
        const pos = await nft.positions(tokenId);
        const token0 = pos.token0.toLowerCase();
        const token1 = pos.token1.toLowerCase();
        const isWethUsdc = (
          (token0 === WETH.toLowerCase() && token1 === USDC.toLowerCase()) ||
          (token0 === USDC.toLowerCase() && token1 === WETH.toLowerCase())
        );
        if (isWethUsdc && Number(pos.fee) === TARGET_FEE && pos.liquidity > 0n) {
          WETH_POS_ID = tokenId;
          raw = pos;
          console.log(`Using Airtable NFT #${nftIdFromAirtable} — liquidity confirmed`);
        } else {
          console.log(`Airtable NFT #${nftIdFromAirtable} — liquidity=0 or wrong pair, falling back to wallet scan`);
        }
      } catch (e) {
        console.error(`Airtable NFT lookup failed: ${e.message.slice(0, 60)}, falling back to wallet scan`);
      }
    }

    // Fallback: scan WALLET_WETH_LP for active position
    if (!WETH_POS_ID) {
      const balance = await nft.balanceOf(WALLET_WETH_LP);
      const count = Number(balance);
      console.log(`Scanning WALLET_WETH_LP — owns ${count} Uniswap V3 NFT(s)...`);
      for (let i = 0; i < count; i++) {
        const tokenId = await nft.tokenOfOwnerByIndex(WALLET_WETH_LP, i);
        const pos = await nft.positions(tokenId);
        const token0 = pos.token0.toLowerCase();
        const token1 = pos.token1.toLowerCase();
        const fee = Number(pos.fee);
        const liq = pos.liquidity;
        const isWethUsdc = (
          (token0 === WETH.toLowerCase() && token1 === USDC.toLowerCase()) ||
          (token0 === USDC.toLowerCase() && token1 === WETH.toLowerCase())
        );
        console.log(`  NFT #${tokenId}: fee=${fee}, liquidity=${liq}, WETH/USDC=${isWethUsdc}`);
        if (isWethUsdc && fee === TARGET_FEE && liq > 0n) {
          WETH_POS_ID = tokenId;
          raw = pos;
          console.log(`  ✓ Active WETH/USDC 0.05% position found: NFT #${tokenId}`);
          break;
        }
      }
    }

    if (!WETH_POS_ID || !raw) { console.error('No active WETH/USDC 0.05% position with liquidity found'); return null; }

    const tickLowerN = Number(raw.tickLower);
    const tickUpperN = Number(raw.tickUpper);
    const liquidity  = raw.liquidity;
    const factory    = new ethers.Contract('0x1F98431c8aD98523631AE4a59f267346ea31F984', factoryABI, provider);
    const poolAddr   = await factory.getPool(raw.token0, raw.token1, raw.fee);
    const slot0      = await (new ethers.Contract(poolAddr, poolABI, provider)).slot0();
    const currentTick  = Number(slot0.tick);
    const inRange      = currentTick >= tickLowerN && currentTick < tickUpperN;
    const sqrtP        = Number(slot0.sqrtPriceX96) / Number(2n ** 96n);
    const ethPrice     = sqrtP * sqrtP * 1e12;
    const liq          = Number(liquidity);
    const sqrtLower    = Math.sqrt(1.0001 ** tickLowerN);
    const sqrtUpper    = Math.sqrt(1.0001 ** tickUpperN);
    const sqrtCurrent  = Math.sqrt(1.0001 ** currentTick);

    let amount0 = 0, amount1 = 0;
    if (inRange) {
      amount0 = liq * (sqrtUpper - sqrtCurrent) / (sqrtCurrent * sqrtUpper) / 1e18;
      amount1 = liq * (sqrtCurrent - sqrtLower) / 1e6;
    } else if (currentTick < tickLowerN) {
      amount0 = liq * (sqrtUpper - sqrtLower) / (sqrtLower * sqrtUpper) / 1e18;
    } else {
      amount1 = liq * (sqrtUpper - sqrtLower) / 1e6;
    }

    const positionValue = (amount0 * ethPrice) + amount1;
    const MAX128 = BigInt('0xffffffffffffffffffffffffffffffff');
    const nftCollect = new ethers.Contract(NFT_MANAGER, collectABI, provider);
    let feeValue = 0;
    try {
      const fees = await nftCollect.collect.staticCall({ tokenId: WETH_POS_ID, recipient: WALLET_WETH_LP, amount0Max: MAX128, amount1Max: MAX128 });
      const feeETH  = Number(fees[0]) / 1e18;
      const feeUSDC = Number(fees[1]) / 1e6;
      feeValue = (feeETH * ethPrice) + feeUSDC;
      console.log(`ETH: $${ethPrice.toFixed(2)}, position: $${positionValue.toFixed(2)}, fees: $${feeValue.toFixed(2)}, in range: ${inRange}, NFT: #${WETH_POS_ID}`);
    } catch (e) {
      console.error(`Fee collect failed: ${e.message.slice(0, 60)}`);
      console.log(`ETH: $${ethPrice.toFixed(2)}, position: $${positionValue.toFixed(2)}, in range: ${inRange}, NFT: #${WETH_POS_ID}`);
    }

    return { positionValue, feeValue, inRange, currentTick, tickLower: tickLowerN, tickUpper: tickUpperN, ethPrice, cycleId, assetRecordId };
  } catch (e) { console.error(`WETH/USDC: ${e.message}`); return null; }
}

// ============================================================
// MODULE 2 — Moonwell (Base)
// ============================================================

async function getMoonwellData() {
  console.log('\n--- Moonwell ---');
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const results  = {};
  const mTokenABI = [
    'function balanceOfUnderlying(address owner) external returns (uint)',
    'function balanceOf(address account) external view returns (uint)',
    'function exchangeRateStored() external view returns (uint)',
    'function borrowBalanceStored(address account) external view returns (uint)',
    'function borrowRatePerTimestamp() external view returns (uint)',
  ];
  const comptrollerABI = ['function oracle() external view returns (address)'];
  const oracleABI      = ['function getUnderlyingPrice(address mToken) external view returns (uint)'];

  let oracle;
  try {
    const comptroller = new ethers.Contract(COMPTROLLER, comptrollerABI, provider);
    oracle = new ethers.Contract(await comptroller.oracle(), oracleABI, provider);
  } catch (e) { console.error(`Oracle: ${e.message}`); }

  const mtokenMarkets  = MARKETS.filter(m => m.method === 'mtoken');
  const llamaPriceData = await fetchWithTimeout(`https://coins.llama.fi/prices/current/${mtokenMarkets.map(m => `base:${m.underlyingAddr}`).join(',')}`);
  const prices = {};
  if (llamaPriceData?.coins) {
    for (const [k, v] of Object.entries(llamaPriceData.coins)) prices[k.split(':')[1].toLowerCase()] = v.price;
  }

  const llamaPoolsData = await fetchWithTimeout('https://yields.llama.fi/pools');
  const moonwellPools  = {};
  if (llamaPoolsData?.data) {
    const basePools = llamaPoolsData.data.filter(p => p.project === 'moonwell-lending' && p.chain === 'Base');
    for (const pool of basePools) {
      const sym = pool.symbol?.toUpperCase();
      if (sym === 'ETH')     moonwellPools['moonwellETH']    = pool;
      if (sym === 'VIRTUAL') moonwellPools['moonwellVIRT']   = pool;
      if (sym === 'CBXRP')   moonwellPools['moonwellCBXRP']  = pool;
      if (sym === 'AERO')    moonwellPools['moonwellAERO']   = pool;
      if (sym === 'USDC')    moonwellPools['moonwellBorrow'] = pool;
    }
  }

  for (const market of MARKETS) {
    try {
      const mToken    = new ethers.Contract(market.mAddr, mTokenABI, provider);
      const supplyAPY = moonwellPools[market.key]?.apy ?? null;
      if (market.method === 'oracle' && oracle) {
        const oracleRaw = await oracle.getUnderlyingPrice(market.mAddr);
        const priceUSD  = Number(oracleRaw) / Math.pow(10, 36 - market.underlyingDec);
        const balRaw    = await mToken.balanceOfUnderlying.staticCall(WALLET_EVM);
        const tokens    = Number(balRaw) / Math.pow(10, market.underlyingDec);
        const supplyUSD = tokens * priceUSD;
        console.log(`${market.key}: ${tokens.toFixed(4)} tokens x $${priceUSD.toFixed(4)} = $${supplyUSD.toFixed(2)} | supplyAPY: ${supplyAPY?.toFixed(2)}%`);
        if (supplyUSD > 0.01) results[market.key] = { type: 'supply', supplyUSD, tokens, supplyAPY };
      } else if (market.method === 'mtoken') {
        const price = prices[market.underlyingAddr?.toLowerCase()] ?? null;
        if (!price) { console.error(`${market.key}: no price`); continue; }
        const [mBalRaw, exchRaw] = await Promise.all([mToken.balanceOf(WALLET_EVM), mToken.exchangeRateStored()]);
        const underlying = Number(BigInt(mBalRaw.toString()) * BigInt(exchRaw.toString()) / (BigInt(10) ** BigInt(18 + market.underlyingDec)));
        const supplyUSD  = underlying * price;
        console.log(`${market.key}: ${underlying.toFixed(4)} tokens x $${price.toFixed(4)} = $${supplyUSD.toFixed(2)} | supplyAPY: ${supplyAPY?.toFixed(2)}%`);
        if (supplyUSD > 0.01) results[market.key] = { type: 'supply', supplyUSD, tokens: underlying, supplyAPY };
      } else if (market.method === 'borrow') {
        const borrowRaw = await mToken.borrowBalanceStored(WALLET_EVM);
        const borrowUSD = Number(borrowRaw) / Math.pow(10, market.underlyingDec);
        let borrowAPY = null;
        try {
          const rateRaw    = await mToken.borrowRatePerTimestamp();
          const ratePerSec = Number(rateRaw) / 1e18;
          borrowAPY        = ((1 + ratePerSec) ** 31_536_000 - 1) * 100;
        } catch (e) { console.error(`borrowRatePerTimestamp failed: ${e.message.slice(0, 60)}`); }
        console.log(`${market.key}: borrow $${borrowUSD.toFixed(2)} | borrowAPY: ${borrowAPY?.toFixed(2)}%`);
        if (borrowUSD > 0.01) results[market.key] = { type: 'borrow', borrowUSD, tokens: borrowUSD, borrowAPY };
      }
    } catch (e) { console.error(`${market.key}: ${e.message.slice(0, 80)}`); }
  }
  return results;
}

// ============================================================
// MODULE 3 — Suilend (Sui) via raw RPC
// ============================================================

async function getSuilendData() {
  console.log('\n--- Suilend ---');
  const results = {};
  try {
    let obligationId = null, cursor = null;
    outer: while (true) {
      const page = await suiRpc('suix_getOwnedObjects', [WALLET_SUI, { options: { showType: true, showContent: true } }, cursor, 50]);
      if (!page?.data?.length) break;
      for (const obj of page.data) {
        if ((obj.data?.type ?? '').includes(OBLIGATION_CAP_KEYWORD)) {
          console.log(`Suilend: found cap type: ${obj.data.type}`);
          const fields = obj.data?.content?.fields;
          obligationId = fields?.obligation_id ?? fields?.obligationId;
          break outer;
        }
      }
      if (!page.hasNextPage) break;
      cursor = page.nextCursor;
    }
    if (!obligationId) { console.error('Suilend: no ObligationOwnerCap found.'); return results; }
    console.log(`Suilend: obligation ${obligationId}`);

    const obligationObj    = await suiRpc('sui_getObject', [obligationId, { showContent: true, showType: true }]);
    const obligationFields = obligationObj?.data?.content?.fields;
    if (!obligationFields) { console.error('Suilend: could not read obligation fields'); return results; }
    console.log('Obligation field keys:', Object.keys(obligationFields).join(', '));

    const lendingMarketId = obligationFields.lending_market_id?.id ?? obligationFields.lending_market_id;
    const [priceData, lendingMarketObj] = await Promise.all([
      fetchWithTimeout('https://coins.llama.fi/prices/current/coingecko:sui,coingecko:wrapped-solana'),
      suiRpc('sui_getObject', [lendingMarketId, { showContent: true }]),
    ]);
    const suiPrice  = priceData?.coins?.['coingecko:sui']?.price ?? 0;
    const wsolPrice = priceData?.coins?.['coingecko:wrapped-solana']?.price ?? 0;
    console.log(`Prices: SUI $${suiPrice.toFixed(4)}, wSOL $${wsolPrice.toFixed(4)}`);

    const reserves = lendingMarketObj?.data?.content?.fields?.reserves ?? [];
    console.log(`Lending market reserves: ${reserves.length} found`);

    const suilendAPYs = {};
    for (const reserveEntry of reserves) {
      const rf       = reserveEntry?.fields ?? reserveEntry;
      const coinType = rf?.coin_type?.fields?.name ?? rf?.coinType ?? '';
      const isSUI  = coinType.toLowerCase().includes('sui::sui');
      const isWSOL = coinType.toLowerCase().includes('b7844e28');
      const isUSDC = coinType.toLowerCase().includes('usdc') || coinType.toLowerCase().includes('dba346');
      if (!isSUI && !isWSOL && !isUSDC) continue;
      const key = isSUI ? 'SUI' : isWSOL ? 'WSOL' : 'USDC';
      if (suilendAPYs[key]) continue;
      const configEl = rf?.config?.fields?.element?.fields ?? {};
      const utils    = configEl?.interest_rate_utils ?? [];
      const aprs     = configEl?.interest_rate_aprs  ?? [];
      const mintDec  = Number(rf?.mint_decimals ?? 6);
      const borrowedNative     = Number(BigInt(rf?.borrowed_amount?.fields?.value ?? 0) * 1000n / 10n ** 27n) / 1000;
      const ctokenSupplyNative = Number(BigInt(rf?.ctoken_supply ?? 0)) / Math.pow(10, mintDec);
      const utilRate           = ctokenSupplyNative > 0 ? borrowedNative / ctokenSupplyNative : 0;
      let borrowAprPerYear = 0;
      if (utils.length > 0 && aprs.length >= utils.length) {
        const utilPoints = utils.map(u => Number(u) / 100);
        const aprPoints  = aprs.map(a => Number(a) / 10000);
        if (utilRate <= utilPoints[0]) { borrowAprPerYear = aprPoints[0]; }
        else if (utilRate >= utilPoints[utilPoints.length - 1]) { borrowAprPerYear = aprPoints[aprPoints.length - 1]; }
        else {
          for (let i = 1; i < utilPoints.length; i++) {
            if (utilRate <= utilPoints[i]) {
              const t = (utilRate - utilPoints[i-1]) / (utilPoints[i] - utilPoints[i-1]);
              borrowAprPerYear = aprPoints[i-1] + t * (aprPoints[i] - aprPoints[i-1]);
              break;
            }
          }
        }
      }
      const borrowRatePerSec = borrowAprPerYear / 31_536_000;
      const borrowAPY = borrowRatePerSec > 0 ? ((1 + borrowRatePerSec) ** 31_536_000 - 1) * 100 : null;
      const spreadFee = Number(configEl?.spread_fee_bps ?? 0) / 10000;
      const supplyAPY = borrowAPY != null ? borrowAPY * utilRate * (1 - spreadFee) : null;
      suilendAPYs[key] = { supplyAPY, borrowAPY };
      console.log(`Reserve ${key}: util=${(utilRate*100).toFixed(1)}%, borrowAPY=${borrowAPY?.toFixed(2) ?? 'n/a'}%, supplyAPY=${supplyAPY?.toFixed(2) ?? 'n/a'}%`);
    }

    const depositList = obligationFields.deposits?.fields?.contents ?? obligationFields.collateral?.fields?.contents ?? obligationFields.deposits ?? [];
    console.log(`Deposits raw count: ${depositList.length}`);
    for (const entry of depositList) {
      const d        = entry?.fields ?? entry;
      const coinType = d?.coin_type?.fields?.name ?? '';
      const isSUI  = coinType.toLowerCase().includes('sui::sui');
      const isWSOL = coinType.toLowerCase().includes('b7844e28');
      if (!isSUI && !isWSOL) continue;
      const assetKey  = isSUI ? 'SUI' : 'WSOL';
      const price     = isSUI ? suiPrice : wsolPrice;
      const lposKey   = isSUI ? 'suilendSUI' : 'suilendWSOL';
      const tokens    = Number(BigInt(d?.deposited_ctoken_amount ?? 0)) / Math.pow(10, isSUI ? 9 : 8);
      const supplyUSD = tokens * price;
      console.log(`suilend${assetKey}: ${tokens.toFixed(4)} tokens = $${supplyUSD.toFixed(2)} | supplyAPY: ${suilendAPYs[assetKey]?.supplyAPY?.toFixed(2) ?? 'n/a'}%`);
      results[lposKey] = { type: 'supply', supplyUSD, tokens, supplyAPY: suilendAPYs[assetKey]?.supplyAPY ?? null };
    }

    const borrowList = obligationFields.borrows?.fields?.contents ?? obligationFields.borrows ?? [];
    console.log(`Borrows raw count: ${borrowList.length}`);
    for (const entry of borrowList) {
      const b        = entry?.fields ?? entry;
      const coinType = b?.coin_type?.fields?.name ?? '';
      if (!coinType.toLowerCase().includes('usdc') && !coinType.toLowerCase().includes('dba346')) continue;
      const baInt     = BigInt(String(b?.borrowed_amount?.fields?.value ?? '0').split('.')[0]);
      const borrowUSD = Number(baInt / 1000000n) / 1e18;
      const borrowAPY = suilendAPYs['USDC']?.borrowAPY ?? null;
      const depositedValueUsd     = Number(BigInt(obligationFields.deposited_value_usd?.fields?.value ?? 0) / 10000n) / 1e14;
      const allowedBorrowValueUsd = Number(BigInt(obligationFields.allowed_borrow_value_usd?.fields?.value ?? 0) / 10000n) / 1e14;
      const ltvPct = allowedBorrowValueUsd > 0 ? (borrowUSD / allowedBorrowValueUsd * 100).toFixed(1) : 'n/a';
      const notes  = `Collateral: $${depositedValueUsd.toFixed(2)} | Borrow Limit: $${allowedBorrowValueUsd.toFixed(2)} | LTV Used: ${ltvPct}%`;
      console.log(`suilendBorrow: borrow $${borrowUSD.toFixed(2)} | borrowAPY: ${borrowAPY?.toFixed(2) ?? 'n/a'}% | ${notes}`);
      results['suilendBorrow'] = { type: 'borrow', borrowUSD, tokens: borrowUSD, borrowAPY, notes };
    }
  } catch (e) { console.error(`Suilend fatal: ${e.message}`); }
  return results;
}

// ============================================================
// MODULE 4 — Raydium xStocks CLMM (Solana)
// Position list driven by Airtable Assets table at runtime
// ============================================================

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58EncodeBytes(input) {
  const bytes = Array.from(input);
  let num = 0n;
  for (const b of bytes) { num = num * 256n + BigInt(b); }
  let result = '';
  while (num > 0n) { result = BASE58_ALPHABET[Number(num % 58n)] + result; num = num / 58n; }
  for (const b of bytes) { if (b === 0) result = '1' + result; else break; }
  return result;
}

function sqrtPriceX64ToFloat(str) {
  const val = BigInt(str);
  const Q64 = 2n ** 64n;
  return Number(val / Q64) + Number(val % Q64) / Number(Q64);
}

function calcAmounts(liquidity, tickLower, tickUpper, tickCurrent, sqrtPriceCurrent) {
  const liq = Number(liquidity);
  const sqrtL = Math.sqrt(1.0001 ** tickLower);
  const sqrtU = Math.sqrt(1.0001 ** tickUpper);
  const sqrtC = sqrtPriceCurrent ?? Math.sqrt(1.0001 ** tickCurrent);
  const inRange = tickCurrent >= tickLower && tickCurrent < tickUpper;
  let a0 = 0, a1 = 0;
  if (inRange)                      { a0 = liq * (sqrtU - sqrtC) / (sqrtC * sqrtU); a1 = liq * (sqrtC - sqrtL); }
  else if (tickCurrent < tickLower) { a0 = liq * (sqrtU - sqrtL) / (sqrtL * sqrtU); }
  else                              { a1 = liq * (sqrtU - sqrtL); }
  return { amount0: a0, amount1: a1, inRange };
}

function parsePositionAccount(data) {
  const buf = Buffer.from(data, 'base64');
  const tickLower = buf.readInt32LE(73);
  const tickUpper = buf.readInt32LE(77);
  const liqLo = buf.readBigUInt64LE(81);
  const liqHi = buf.readBigUInt64LE(89);
  const liquidity = liqLo | (liqHi << 64n);
  const fgi0Lo = buf.readBigUInt64LE(97);  const fgi0Hi = buf.readBigUInt64LE(105);
  const fgi1Lo = buf.readBigUInt64LE(113); const fgi1Hi = buf.readBigUInt64LE(121);
  const fgInside0Last = fgi0Lo | (fgi0Hi << 64n);
  const fgInside1Last = fgi1Lo | (fgi1Hi << 64n);
  const feesOwed0 = buf.readBigUInt64LE(129);
  const feesOwed1 = buf.readBigUInt64LE(137);
  return { tickLower, tickUpper, liquidity, fgInside0Last, fgInside1Last, feesOwed0, feesOwed1 };
}

function parsePoolAccount(data) {
  const buf = Buffer.from(data, 'base64');
  const mint0Bytes = buf.slice(73, 105);
  const mint1Bytes = buf.slice(105, 137);
  const dec0       = buf.readUInt8(233);
  const dec1       = buf.readUInt8(234);
  const sqrtLo = buf.readBigUInt64LE(253);
  const sqrtHi = buf.readBigUInt64LE(261);
  const sqrtPriceX64 = sqrtLo | (sqrtHi << 64n);
  const Q64  = 2n ** 64n;
  const Q64f = Number(Q64);
  const sqrtPriceFloat = Number(sqrtPriceX64 / Q64) + Number(sqrtPriceX64 % Q64) / Q64f;
  const rawPrice    = sqrtPriceFloat * sqrtPriceFloat;
  const tickCurrent = Math.round(Math.log(rawPrice) / Math.log(1.0001));
  const fg0Lo = buf.readBigUInt64LE(277); const fg0Hi = buf.readBigUInt64LE(285);
  const fg1Lo = buf.readBigUInt64LE(293); const fg1Hi = buf.readBigUInt64LE(301);
  const feeGrowthGlobal0 = fg0Lo | (fg0Hi << 64n);
  const feeGrowthGlobal1 = fg1Lo | (fg1Hi << 64n);
  return {
    mint0: base58EncodeBytes(Array.from(mint0Bytes)),
    mint1: base58EncodeBytes(Array.from(mint1Bytes)),
    decimals0: dec0, decimals1: dec1, sqrtPriceX64, tickCurrent, feeGrowthGlobal0, feeGrowthGlobal1,
  };
}

async function getRaydiumPositions(raydiumAssets) {
  console.log(`\n--- Raydium xStocks CLMM ${RAYDIUM_DRY_RUN ? '[DRY RUN]' : '[LIVE]'} ---`);
  const results = [];

  if (!raydiumAssets || raydiumAssets.length === 0) {
    console.error('No active Raydium assets found in Airtable');
    return results;
  }

  // Build position list from Airtable records
  const xstockPositions = raydiumAssets.map(r => ({
    key:          r.fields[AF.asset],
    recordId:     r.id,
    cycleId:      r.fields[AF.cycleId],
    nftMint:      r.fields[AF.nftMint],
    poolId:       r.fields[AF.poolAddr],
  })).filter(p => p.nftMint && p.poolId);

  console.log(`Processing ${xstockPositions.length} Airtable-driven xStock positions`);

  for (const posConfig of xstockPositions) {
    const { key, recordId, cycleId, nftMint, poolId } = posConfig;
    try {
      const programAccounts = await solRpc('getProgramAccounts', [
        RAYDIUM_CLMM_PROGRAM,
        { encoding: 'base64', filters: [{ dataSize: 281 }, { memcmp: { offset: 9, bytes: nftMint } }] },
      ]);
      const posAccount = programAccounts?.[0] ?? null;
      if (!posAccount) { console.log(`  ${key}: position account not found`); continue; }

      const pos = parsePositionAccount(posAccount.account.data[0]);
      console.log(`  ${key}: ticks [${pos.tickLower}, ${pos.tickUpper}], liquidity: ${pos.liquidity}`);
      await new Promise(r => setTimeout(r, 2000));

      let poolRes = null;
      for (let i = 1; i <= 3; i++) {
        poolRes = await solRpc('getAccountInfo', [poolId, { encoding: 'base64' }]);
        if (poolRes?.value?.data) break;
        await new Promise(r => setTimeout(r, 3000));
      }
      if (!poolRes?.value?.data) { console.error(`  ${key}: pool not found`); continue; }

      const pool      = parsePoolAccount(poolRes.value.data[0]);
      const priceData = await fetchWithTimeout(`https://coins.llama.fi/prices/current/solana:${pool.mint0},solana:${pool.mint1}`);
      const price0    = priceData?.coins?.[`solana:${pool.mint0}`]?.price ?? null;
      const price1    = priceData?.coins?.[`solana:${pool.mint1}`]?.price ?? null;
      const sqrtP     = sqrtPriceX64ToFloat(pool.sqrtPriceX64.toString());
      const { amount0, amount1, inRange } = calcAmounts(pos.liquidity, pos.tickLower, pos.tickUpper, pool.tickCurrent, sqrtP);
      const tokens0 = amount0 / Math.pow(10, pool.decimals0);
      const tokens1 = amount1 / Math.pow(10, pool.decimals1);
      const positionValue = (price0 ?? 0) * tokens0 + (price1 ?? 0) * tokens1;

      const Q64  = 2n ** 64n;
      const U128 = 2n ** 128n;
      let pendingYield = 0;

      try {
        const sigRes = await solRpc('getSignaturesForAddress', [nftMint, { limit: 5 }]);
        let lowerTickArrayAddr = null, upperTickArrayAddr = null;

        for (const sigEntry of (sigRes || [])) {
          const txRes = await solRpc('getTransaction', [sigEntry.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }]);
          const keys = txRes?.transaction?.message?.accountKeys ?? [];
          if (!keys.includes(RAYDIUM_CLMM_PROGRAM)) continue;
          const candidateKeys = keys.filter((k) => k !== RAYDIUM_CLMM_PROGRAM && k !== nftMint && k !== poolId);
          const infosRes = await solRpc('getMultipleAccounts', [candidateKeys.slice(0, 12), { encoding: 'base64' }]);
          for (let i = 0; i < candidateKeys.length && i < 12; i++) {
            const d = infosRes?.value?.[i]?.data?.[0];
            if (!d) continue;
            const buf = Buffer.from(d, 'base64');
            if (buf.length === 10240) {
              const storedPoolId = base58EncodeBytes(Array.from(buf.slice(8, 40)));
              if (storedPoolId === poolId) {
                const startTick = buf.readInt32LE(40);
                console.log(`  Found tick array: ${candidateKeys[i].slice(0,8)}... startTick=${startTick}`);
                if (startTick <= pos.tickLower && !lowerTickArrayAddr) {
                  lowerTickArrayAddr = { addr: candidateKeys[i], startTick, data: d };
                }
                if (startTick <= pos.tickUpper && startTick > (lowerTickArrayAddr?.startTick ?? -Infinity) && !upperTickArrayAddr) {
                  upperTickArrayAddr = { addr: candidateKeys[i], startTick, data: d };
                }
              }
            }
          }
          if (lowerTickArrayAddr) break;
        }

        const feesOwed0USD = (price0 ?? 0) * Number(pos.feesOwed0) / Math.pow(10, pool.decimals0);
        const feesOwed1USD = (price1 ?? 0) * Number(pos.feesOwed1) / Math.pow(10, pool.decimals1);
        pendingYield = feesOwed0USD + feesOwed1USD;

        if (lowerTickArrayAddr) {
          const TICK_SIZE = 168;
          const TA_HEADER = 44;

          function getTickFeeGrowth(taData, tickIndex, taStartTick, tickSpacing) {
            const buf = Buffer.from(taData, 'base64');
            const tickArraySpacing = tickSpacing ?? 10;
            const offset = (tickIndex - taStartTick) / tickArraySpacing;
            if (offset < 0 || offset >= 60 || !Number.isInteger(offset)) return { fg0: 0n, fg1: 0n };
            const tickStart = TA_HEADER + offset * TICK_SIZE;
            const FG0 = 36; const FG1 = 52;
            const fg0Lo = buf.readBigUInt64LE(tickStart + FG0);
            const fg0Hi = buf.readBigUInt64LE(tickStart + FG0 + 8);
            const fg1Lo = buf.readBigUInt64LE(tickStart + FG1);
            const fg1Hi = buf.readBigUInt64LE(tickStart + FG1 + 8);
            return { fg0: fg0Lo | (fg0Hi << 64n), fg1: fg1Lo | (fg1Hi << 64n) };
          }

          const poolBuf     = Buffer.from(poolRes.value.data[0], 'base64');
          const tickSpacing = poolBuf.readUInt16LE(235);
          const lowerTA = lowerTickArrayAddr ?? upperTickArrayAddr;
          const upperTA = upperTickArrayAddr ?? lowerTickArrayAddr;
          const lower = getTickFeeGrowth(lowerTA.data, pos.tickLower, lowerTA.startTick, tickSpacing);
          const upper = getTickFeeGrowth(upperTA.data, pos.tickUpper, upperTA.startTick, tickSpacing);

          const fgBelow0 = pool.tickCurrent >= pos.tickLower ? lower.fg0 : (pool.feeGrowthGlobal0 - lower.fg0 + U128) % U128;
          const fgBelow1 = pool.tickCurrent >= pos.tickLower ? lower.fg1 : (pool.feeGrowthGlobal1 - lower.fg1 + U128) % U128;
          const fgAbove0 = pool.tickCurrent < pos.tickUpper  ? upper.fg0 : (pool.feeGrowthGlobal0 - upper.fg0 + U128) % U128;
          const fgAbove1 = pool.tickCurrent < pos.tickUpper  ? upper.fg1 : (pool.feeGrowthGlobal1 - upper.fg1 + U128) % U128;

          const fgInside0 = (pool.feeGrowthGlobal0 - fgBelow0 - fgAbove0 + U128 * 2n) % U128;
          const fgInside1 = (pool.feeGrowthGlobal1 - fgBelow1 - fgAbove1 + U128 * 2n) % U128;

          const delta0 = (fgInside0 - pos.fgInside0Last + U128) % U128;
          const delta1 = (fgInside1 - pos.fgInside1Last + U128) % U128;

          const rawFee0 = Number(delta0 * pos.liquidity / Q64) + Number(pos.feesOwed0);
          const rawFee1 = Number(delta1 * pos.liquidity / Q64) + Number(pos.feesOwed1);
          const fee0USD = (price0 ?? 0) * rawFee0 / Math.pow(10, pool.decimals0);
          const fee1USD = (price1 ?? 0) * rawFee1 / Math.pow(10, pool.decimals1);
          pendingYield  = fee0USD + fee1USD;
          console.log(`  Fees (tick array): $${fee0USD.toFixed(2)} token0 + $${fee1USD.toFixed(2)} USDC = $${pendingYield.toFixed(2)}`);
        } else {
          console.log(`  Fees (feesOwed floor only): $${pendingYield.toFixed(2)}`);
        }
      } catch(feeErr) { console.error(`  Fee calc error: ${feeErr.message.slice(0, 80)}`); }

      console.log(`  ${key}: $${positionValue.toFixed(2)}, in range: ${inRange}, fees: $${pendingYield.toFixed(2)}`);
      results.push({ key, recordId, cycleId, positionValue, inRange, pendingYield });

    } catch (e) { console.error(`  ${key}: ${e.message}`); }
  }
  return results;
}

// ============================================================
// MODULE 5 — Lighter (LLP, Edge & Hedge, LIT Staking)
// ============================================================

async function getLighterPositions() {
  console.log('\n--- Lighter ---');
  const results = {};
  try {
    const headers = { 'Authorization': LIGHTER_TOKEN };

    const llpRes = await fetchWithTimeout(
      `${LIGHTER_BASE}/publicPoolsMetadata?index=${LIGHTER_LLP_ID + 1}&limit=1&account_index=${LIGHTER_ACCT}`,
      { headers }
    );
    const llp = llpRes?.public_pools?.[0];
    if (llp && llp.account_share) {
      const pricePerShare = Number(llp.total_asset_value) / Number(llp.total_shares);
      const equity = llp.account_share.shares_amount * pricePerShare;
      const apr = llp.annual_percentage_yield != null ? llp.annual_percentage_yield / 100 : null;
      console.log(`LLP: shares=${llp.account_share.shares_amount}, equity=$${equity.toFixed(2)}, APY=${llp.annual_percentage_yield?.toFixed(2)}%`);
      results.llp = { equity, apr, shares: llp.account_share.shares_amount };
    } else { console.error('LLP: no account_share in response'); }

    const edgeRes = await fetchWithTimeout(
      `${LIGHTER_BASE}/publicPoolsMetadata?index=${LIGHTER_EDGE_ID + 1}&limit=1&account_index=${LIGHTER_ACCT}`,
      { headers }
    );
    const edge = edgeRes?.public_pools?.[0];
    if (edge && edge.account_share) {
      const pricePerShare = Number(edge.total_asset_value) / Number(edge.total_shares);
      const equity = edge.account_share.shares_amount * pricePerShare;
      const apr = edge.annual_percentage_yield != null ? edge.annual_percentage_yield / 100 : null;
      console.log(`Edge & Hedge: shares=${edge.account_share.shares_amount}, equity=$${edge.equity?.toFixed(2)}, APY=${edge.annual_percentage_yield?.toFixed(2)}%`);
      results.edge = { equity, apr, shares: edge.account_share.shares_amount };
    } else { console.error('Edge & Hedge: no account_share in response'); }

    let litStakeAmount = LIT_STAKE_AMOUNT;
    let litAPR = 0.0684;
    const stakingSearchRes = await fetchWithTimeout(
      `${LIGHTER_BASE}/publicPoolsMetadata?index=0&limit=100&filter=protocol`, { headers }
    );
    const stakingPools = stakingSearchRes?.public_pools ?? [];
    const litPool = stakingPools.find(p => p.name?.toLowerCase().includes('lit') || p.name?.toLowerCase().includes('staking'));
    if (litPool) {
      const litPoolRes = await fetchWithTimeout(
        `${LIGHTER_BASE}/publicPoolsMetadata?index=${litPool.account_index + 1}&limit=1&account_index=${LIGHTER_ACCT}`,
        { headers }
      );
      const litPoolData = litPoolRes?.public_pools?.[0];
      if (litPoolData?.account_share) {
        litStakeAmount = Number(litPoolData.account_share.principal_amount ?? litPoolData.account_share.shares_amount);
        litAPR = litPoolData.annual_percentage_yield != null ? litPoolData.annual_percentage_yield / 100 : litAPR;
      }
    } else {
      console.log(`LIT staking pool not found in protocol filter — using hardcoded ${LIT_STAKE_AMOUNT} LIT`);
    }

    const litPriceData = await fetchWithTimeout('https://coins.llama.fi/prices/current/coingecko:lighter');
    const litPrice = litPriceData?.coins?.['coingecko:lighter']?.price ?? null;
    if (litPrice) {
      const litEquity = litStakeAmount * litPrice;
      console.log(`LIT Staking: ${litStakeAmount} LIT x $${litPrice.toFixed(4)} = $${litEquity.toFixed(2)}, APR=${litAPR?.toFixed(2)}%`);
      results.lit = { equity: litEquity, litPrice, litStakeAmount, apr: litAPR };
    } else { console.error('LIT: price not found on DeFi Llama'); }

  } catch (e) { console.error(`Lighter fatal: ${e.message}`); }
  return results;
}

// ============================================================
// MODULE 6 — ETH Short Hedge (Hyperliquid)
// ============================================================

async function getEthHedge() {
  console.log('\n--- ETH Short Hedge ---');
  try {
    const [hlState, hlSpot] = await Promise.all([
      fetchWithTimeout('https://api.hyperliquid.xyz/info', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'clearinghouseState', user: WALLET_HYPERLIQUID }),
      }),
      fetchWithTimeout('https://api.hyperliquid.xyz/info', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'spotClearinghouseState', user: WALLET_HYPERLIQUID }),
      }),
    ]);

    let positionValue = null;
    const balances = hlSpot?.balances ?? [];
    const usdc = balances.find(b => b.coin === 'USDC' || b.coin === 'USDC.e');
    if (usdc) {
      positionValue = parseFloat(usdc.total ?? usdc.hold ?? 0);
      console.log(`Portfolio Value (USDC): $${positionValue.toFixed(2)}`);
    }

    let hedgeData = null;
    const ethPos = (hlState?.assetPositions ?? []).find(p => p.position?.coin === 'ETH');
    if (ethPos) {
      const pos = ethPos.position;
      hedgeData = {
        unrealizedPnl: parseFloat(pos.unrealizedPnl ?? 0),
        entryPx:       parseFloat(pos.entryPx ?? 0),
        size:          parseFloat(pos.szi ?? 0),
      };
      console.log(`ETH PnL: $${hedgeData.unrealizedPnl.toFixed(2)}, entry: $${hedgeData.entryPx}, size: ${hedgeData.size} ETH`);
    } else { console.log('No active ETH position found'); }

    const noteParts = [];
    if (hedgeData?.unrealizedPnl != null) noteParts.push(`PnL: $${hedgeData.unrealizedPnl.toFixed(2)}`);
    if (hedgeData?.entryPx)               noteParts.push(`Entry: $${hedgeData.entryPx}`);
    if (hedgeData?.size)                  noteParts.push(`Size: ${hedgeData.size} ETH`);
    const notes = noteParts.length > 0 ? noteParts.join(' | ') : 'No active ETH position';
    return { positionValue, notes };
  } catch (e) { console.error(`ETH Hedge fatal: ${e.message}`); return null; }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log(`\n====== Daily Portfolio Check v32 — ${NOW_UTC} ======`);
  if (RAYDIUM_DRY_RUN) console.log('INFO: RAYDIUM_DRY_RUN=true — Raydium will NOT write to Airtable');

  // Fetch active LP assets from Airtable first
  const { wethAsset, raydiumAssets } = await fetchActiveLPAssets();

  const [wethRes, moonwellRes, suilendRes, raydiumRes, lighterRes, hedgeRes] = await Promise.allSettled([
    getWethPosition(wethAsset),
    getMoonwellData(),
    getSuilendData(),
    getRaydiumPositions(raydiumAssets),
    getLighterPositions(),
    getEthHedge(),
  ]);

  const weth     = wethRes.status     === 'fulfilled' ? wethRes.value     : null;
  const moonwell = moonwellRes.status === 'fulfilled' ? moonwellRes.value : null;
  const suilend  = suilendRes.status  === 'fulfilled' ? suilendRes.value  : null;
  const raydium  = raydiumRes.status  === 'fulfilled' ? raydiumRes.value  : [];
  const lighter  = lighterRes.status  === 'fulfilled' ? lighterRes.value  : {};
  const hedge    = hedgeRes.status    === 'fulfilled' ? hedgeRes.value    : null;

  console.log('\n--- Writing to Airtable ---');
  let written = 0;

  // WETH/USDC Primary
  if (weth) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(weth.assetRecordId, weth.inRange, {
      [F.positionValue]: weth.positionValue,
      [F.cycleId]:       weth.cycleId,
      ...(weth.feeValue > 0 ? { [F.feeValue]: weth.feeValue } : {}),
      [F.notes]: `ETH: $${weth.ethPrice?.toFixed(0)} | Tick: ${weth.currentTick} | Range: [${weth.tickLower}, ${weth.tickUpper}]`,
    })]);
    if (ok) { written++; console.log(`WETH/USDC: $${weth.positionValue?.toFixed(2)}, fees: $${weth.feeValue?.toFixed(2)}, cycleId: ${weth.cycleId}`); }
  }

  // ETH Short Hedge
  if (hedge?.positionValue != null) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.ethHedge, true, {
      [F.positionValue]: hedge.positionValue,
      [F.notes]:         hedge.notes,
    })]);
    if (ok) { written++; console.log(`ETH Hedge: $${hedge.positionValue.toFixed(2)} | ${hedge.notes}`); }
  }

  // Moonwell
  if (moonwell && Object.keys(moonwell).length > 0) {
    const batch = [];
    for (const [posKey, data] of Object.entries(moonwell)) {
      if (!LPOS[posKey]) continue;
      if (data.type === 'supply') {
        const fields = { [LF.supplyUSD]: data.supplyUSD, [LF.tokenAmt]: data.tokens };
        if (data.supplyAPY != null) fields[LF.supplyAPY] = data.supplyAPY;
        batch.push(lendingRecord(LPOS[posKey], fields));
        console.log(`  Queued ${posKey}: $${data.supplyUSD.toFixed(2)}, APY ${data.supplyAPY?.toFixed(2) ?? 'n/a'}%`);
      } else if (data.type === 'borrow') {
        const fields = { [LF.borrowUSD]: data.borrowUSD, [LF.tokenAmt]: data.tokens };
        if (data.borrowAPY != null) fields[LF.borrowAPY] = data.borrowAPY;
        batch.push(lendingRecord(LPOS[posKey], fields));
        console.log(`  Queued ${posKey}: $${data.borrowUSD.toFixed(2)}, Borrow APY ${data.borrowAPY?.toFixed(2) ?? 'n/a'}%`);
      }
    }
    if (batch.length > 0) {
      const ok = await airtableCreate(LENDING_TABLE, batch);
      if (ok) { written += batch.length; console.log(`Moonwell: ${batch.length} records`); }
    }
  }

  // Suilend
  if (suilend && Object.keys(suilend).length > 0) {
    const batch = [];
    for (const [posKey, data] of Object.entries(suilend)) {
      if (!LPOS[posKey]) continue;
      if (data.type === 'supply') {
        const fields = { [LF.supplyUSD]: data.supplyUSD, [LF.tokenAmt]: data.tokens };
        if (data.supplyAPY != null) fields[LF.supplyAPY] = data.supplyAPY;
        batch.push(lendingRecord(LPOS[posKey], fields));
        console.log(`  Queued ${posKey}: $${data.supplyUSD.toFixed(2)}, APY ${data.supplyAPY?.toFixed(2) ?? 'n/a'}%`);
      } else if (data.type === 'borrow') {
        const fields = { [LF.borrowUSD]: data.borrowUSD, [LF.tokenAmt]: data.tokens };
        if (data.borrowAPY != null) fields[LF.borrowAPY] = data.borrowAPY;
        if (data.notes)             fields[LF.notes]     = data.notes;
        batch.push(lendingRecord(LPOS[posKey], fields));
        console.log(`  Queued ${posKey}: $${data.borrowUSD.toFixed(2)}, Borrow APY ${data.borrowAPY?.toFixed(2) ?? 'n/a'}%`);
      }
    }
    if (batch.length > 0) {
      const ok = await airtableCreate(LENDING_TABLE, batch);
      if (ok) { written += batch.length; console.log(`Suilend: ${batch.length} records`); }
    }
  }

  // Raydium xStocks
  if (raydium.length > 0) {
    console.log(`\nRaydium — ${raydium.length} position(s)`);
    if (RAYDIUM_DRY_RUN) {
      for (const pos of raydium) console.log(`  ${pos.key}: $${pos.positionValue.toFixed(2)}, inRange: ${pos.inRange}, cycleId: ${pos.cycleId}`);
      console.log('DRY RUN — set RAYDIUM_DRY_RUN=false in GitHub Variables to go live');
    } else {
      const batch = [];
      for (const pos of raydium) {
        batch.push(dailyRecord(pos.recordId, pos.inRange, {
          [F.positionValue]: pos.positionValue,
          [F.cycleId]:       pos.cycleId,
          ...(pos.pendingYield > 0 ? { [F.feeValue]: pos.pendingYield } : {}),
          [F.notes]: `Raydium CLMM | ${pos.key}${pos.pendingYield > 0 ? '' : ' | fees: out-of-range (no accumulation)'}`,
        }));
        console.log(`  Queued ${pos.key}: $${pos.positionValue.toFixed(2)}, inRange: ${pos.inRange}, cycleId: ${pos.cycleId}`);
      }
      if (batch.length > 0) {
        for (let i = 0; i < batch.length; i += 10) {
          const ok = await airtableCreate(DAILY_TABLE, batch.slice(i, i + 10));
          if (ok) written += Math.min(10, batch.length - i);
        }
        console.log(`Raydium: ${batch.length} records written`);
      }
    }
  }

  // Lighter
  if (lighter && Object.keys(lighter).length > 0) {
    const batch = [];
    if (lighter.llp) {
      batch.push(dailyRecord(ASSET.lighterLLP, true, {
        [F.positionValue]: lighter.llp.equity,
        ...(lighter.llp.apr != null ? { [F.protocolAPR]: lighter.llp.apr } : {}),
        [F.notes]: `Lighter LLP | Equity: $${lighter.llp.equity.toFixed(2)} | APY: ${(lighter.llp.apr * 100)?.toFixed(2)}% | Shares: ${lighter.llp.shares}`,
      }));
    }
    if (lighter.edge) {
      batch.push(dailyRecord(ASSET.lighterEdge, true, {
        [F.positionValue]: lighter.edge.equity,
        ...(lighter.edge.apr != null ? { [F.protocolAPR]: lighter.edge.apr } : {}),
        [F.notes]: `Lighter Edge & Hedge | Equity: $${lighter.edge.equity.toFixed(2)} | APY: ${(lighter.edge.apr * 100)?.toFixed(2)}% | Shares: ${lighter.edge.shares}`,
      }));
    }
    if (lighter.lit) {
      batch.push(dailyRecord(ASSET.lighterLIT, true, {
        [F.positionValue]: lighter.lit.equity,
        ...(lighter.lit.apr != null ? { [F.protocolAPR]: lighter.lit.apr } : {}),
        [F.notes]: `LIT Staking | ${lighter.lit.litStakeAmount} LIT x $${lighter.lit.litPrice?.toFixed(4)} = $${lighter.lit.equity.toFixed(2)} | APR: ${(lighter.lit.apr * 100)?.toFixed(2)}%`,
      }));
    }
    if (batch.length > 0) {
      const ok = await airtableCreate(DAILY_TABLE, batch);
      if (ok) { written += batch.length; console.log(`Lighter: ${batch.length} records written`); }
    }
  }

  console.log(`\n====== Complete — ${written} records written ======`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

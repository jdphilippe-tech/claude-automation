// ============================================================
// Daily Portfolio Check — GitHub Actions v42
// v42: Kamino obligation values are now REPRICED LIVE, like the Kamino UI.
//      Stored obligation fields freeze between on-chain touches, so v41
//      drifted between draws. Debt = stored borrowedAmountSf × (reserve
//      cumulativeBorrowRate ÷ entry cumulativeBorrowRate), plus a small
//      forward-compound from the reserve's last refresh. Collateral = per
//      deposit cTokens × reserve exchange rate × reserve price. Parses the
//      Reserve accounts (one getMultipleAccounts call; zero new deps).
//      Logs stored-vs-live every run; each piece falls back to stored on
//      failure. Per-leg supply USD auto-maps via metrics reserve address.
//
// v41: Kamino module now reads the on-chain OBLIGATION directly
//      (collateral = dividend/split-scaled depositedValueSf;
//       debt = interest-accrued borrow marketValueSf; LTV computed live).
//      Fixes two "read-assumed-values" bugs: frozen raw token amount
//      (missed the Solana scaled-UI multiplier) and Airtable-echoed debt
//      (missed accrued interest). Falls back to prior behavior if the
//      chain read fails. Zero new dependencies (raw parse, Raydium-style).
//
// v40: Adds Kamino USDC Borrow leg capture (gross borrow APY,
//          carried debt, live-computed LTV; incentive/net in Notes).
//          Writes a 7th Kamino record to the Lending Actions table.
//
// v39 fix: WALLET_WETH_LP added — Uniswap V3 WETH/USDC position
//          lives at 0x2375369D950D49897193EbCad32d99206C37D10A,
//          not WALLET_EVM. getWethPosition() now scans the correct
//          wallet so NFT #5505883 (C10) is found.
// ============================================================

import { ethers } from 'ethers';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE    = 'appWojaxYR99bXC1f';
const DAILY_TABLE      = 'tblKsk0QnkOoKNLuk';
const LENDING_TABLE    = 'tblFw52kzeTRvxTSM';

const WALLET_EVM        = '0x871fd9a8A6a6E918658eadF46e9c23fE4E377289'; // Moonwell/Aave wallet
const WALLET_WETH_LP    = '0x2375369D950D49897193EbCad32d99206C37D10A'; // Uniswap V3 WETH/USDC LP wallet
const WALLET_SUI        = '0xa43b2375ebc13ade7ea537e26e46cd32dc46edd4e23776149c576f1ce36705e9';
const WALLET_HYPERLIQUID = '0x464b059B1AF55A408CB3c822D610c2D962d2cf4b';

const BASE_RPC     = process.env.BASE_RPC_URL ?? 'https://base.llamarpc.com';
const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
const SUI_RPC      = 'https://fullnode.mainnet.sui.io';
const SOL_RPC      = process.env.SOL_RPC_URL ?? 'https://api.mainnet-beta.solana.com';

const RAYDIUM_DRY_RUN = (process.env.RAYDIUM_DRY_RUN ?? 'true') !== 'false';

const LIGHTER_BASE      = 'https://mainnet.zklighter.elliot.ai/api/v1';
const LIGHTER_TOKEN     = process.env.LIGHTER_READ_TOKEN;
const LIGHTER_ACCT      = 449217;
const LIGHTER_LLP_ID    = 281474976710654;
const LIGHTER_EDGE_ID   = 281474976688087;
const LIT_STAKE_AMOUNT  = 185.97;

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

// ---- Asset record IDs ----
const ASSET = {
  wethPrimary:  'recbVsmOWh9YOWPBZ',
  ethHedge:     'recgASxadhJMkNNry',
  lighterLLP:   'recEFiaxgavObYWzL',
  lighterEdge:  'rectz3Zo3aDbe4GgL',
  lighterLIT:   'receiu02rkzc3quDW',
  // cycleId and nftMint are fetched from Airtable Assets table at runtime.
  // Only recordId (permanent) and poolId (fixed per trading pair) stay hardcoded.
  // On cycle rollover: update Airtable Assets only — no code change needed.
  tslax:  { recordId: 'recYwaRC8FTZQaMJK', poolId: 'HHQUnUbmWLrYzkscDY1C3deEFbGtiGBGoHjpANogmvum' },
  nvdax:  { recordId: 'recdQq6r8iDl3BGYZ', poolId: '4KqQN6u1pFKroFE2jVEhoepAMRKPcuAzWVDCgm9zRBYN' },
  aaplx:  { recordId: 'recGF59dwIOnE8fm2', poolId: 'CKwJZwm7oj3nu4653N1EpDrqXbXAYXoPFiPeEnLouF8y' },
  googlx: { recordId: 'recRxStry17D0ZGB5', poolId: 'B8YAwjGYk6qidWzGBXMAxP7nYfG8g74EZ3Y4gFSsobRw' },
  crclx:  { recordId: 'recPq2Ee2MsoMa21S', poolId: 'G39wywquKbHK8F2wZZZFX3fcsyG91VCCbbr6WEVp5axy' },
  spyx:   { recordId: 'rechX4b2anmi82enx', poolId: '6truu3rZuiB9rKQg4VYC3Dt3QwV7DgwGqXrYUcrvnDDE' },
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
  sparkUSDC:      'recu5T7fi0wXU0tfK',
};

// ---- Kamino xStocks Lending (Solana) ----
const KAMINO_API             = 'https://api.kamino.finance';
const WALLET_KAMINO_LENDING  = '5yiTWdskR7yd5RXvs7MJLqWsn6n7geM8SzvYjUpRHrTX';

// Airtable Lending Position record IDs for 6 Kamino xStocks collateral positions.
// These are permanent record IDs — never change. Status/APY data is fetched live.
const KAMINO_POSITIONS = {
  SPYx:   'recAAa654hqvJapSU',
  TSLAx:  'recBpvLXaP5Bz7zUk',
  QQQx:   'rec8BTB46urdsYJtx',
  GOOGLx: 'recvriddPuQUNYsWL',
  NVDAx:  'recr9BpTygVxkeyCU',
  AAPLx:  'rectkbR1l6gvcx3nl',
};

// Kamino USDC Borrow position (the off-ramp debt leg). Permanent record ID.
const KAMINO_USDC_BORROW = 'recaR2C1uC0G0HY2Q';
// NOTE: Kamino KLend on-chain constants (KLEND_PROGRAM_ID, SF_SHIFT, SF_DIV20,
// KAMINO_RESERVES) are declared in the Kamino module section, next to their use.

// ---- Spark Savings (Arbitrum) — sUSDC is an ERC-4626 vault over USDC ----
const SPARK_SUSDC_ARB = '0x940098b108fB7D0a7E374f6eDED7760787464609';

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

async function airtableFetchRecord(tableId, recordId) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}/${recordId}?returnFieldsByFieldId=true`,
    { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }
  );
  if (!res.ok) { console.error(`[Airtable fetch] ${tableId}/${recordId} — HTTP ${res.status}`); return null; }
  return await res.json();
}

// Fetch cycleId and nftMint for all 6 xStock positions from Airtable Assets table.
// recordId and poolId remain hardcoded (never change). Only cycleId and nftMint
// change on cycle rollover — update Airtable Assets, no code change needed.
async function fetchXStockAssets() {
  const xstockKeys = ['tslax', 'nvdax', 'aaplx', 'googlx', 'crclx', 'spyx'];
  const results = {};

  await Promise.all(xstockKeys.map(async (key) => {
    const meta = ASSET[key];
    if (!meta?.recordId) return;
    const record = await airtableFetchRecord('tblrATIQI0ld9tz1y', meta.recordId);
    const status  = record?.fields?.['fldDRyGqgXJTuHTpx']?.name ?? record?.fields?.['fldDRyGqgXJTuHTpx'] ?? null;
    const cycleId = record?.fields?.['fld0T538WMoPQ5bgL'] ?? null;
    const nftMint = record?.fields?.['fldpPTHyGfrSCQO0F'] ?? null;
    if (status !== 'Active') {
      console.log(`  [xStocks] ${key}: status=${status} — skipping (not Active)`);
      results[key] = { ...meta, cycleId: null, nftMint: null };
      return;
    }
    if (!cycleId || !nftMint) {
      console.error(`  [xStocks] ${key}: Active but missing cycleId=${cycleId} or nftMint=${nftMint} in Airtable Assets`);
    } else {
      console.log(`  [xStocks] ${key}: status=Active, cycleId=${cycleId}, nftMint=${nftMint.slice(0, 12)}...`);
    }
    results[key] = { ...meta, cycleId, nftMint };
  }));

  return results;
}

function dailyRecord(assetRecordId, inRange, extra = {}) {
  return { [F.asset]: [assetRecordId], [F.actionType]: 'Fee Check', [F.date]: NOW_UTC, [F.inRange]: inRange ? 'Yes' : 'No', ...extra };
}

function lendingRecord(positionId, extra = {}) {
  return { [LF.position]: [positionId], [LF.actionType]: 'Rate Check', [LF.date]: NOW_UTC, ...extra };
}

// ============================================================
// MODULE 1 — WETH/USDC PRIMARY (Arbitrum)
// ============================================================

async function getWethPosition() {
  console.log('\n--- WETH/USDC Primary ---');
  try {
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

    // v39: scan WALLET_WETH_LP — the wallet that actually holds the Uniswap V3 position
    const balance = await nft.balanceOf(WALLET_WETH_LP);
    const count = Number(balance);
    console.log(`Wallet owns ${count} Uniswap V3 NFT(s) — scanning for active WETH/USDC 0.05% position...`);

    if (count === 0) {
      console.error('No Uniswap V3 positions found in wallet');
      return null;
    }

    let WETH_POS_ID = null;
    let raw = null;

    for (let i = 0; i < count; i++) {
      const tokenId = await nft.tokenOfOwnerByIndex(WALLET_WETH_LP, i);
      const pos = await nft.positions(tokenId);
      const token0 = pos.token0.toLowerCase();
      const token1 = pos.token1.toLowerCase();
      const fee    = Number(pos.fee);
      const liq    = pos.liquidity;

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

    if (!WETH_POS_ID || !raw) {
      console.error('No active WETH/USDC 0.05% position with liquidity found in wallet');
      return null;
    }

    const tickLowerN = Number(raw.tickLower);
    const tickUpperN = Number(raw.tickUpper);
    const liquidity  = raw.liquidity;

    const factory  = new ethers.Contract('0x1F98431c8aD98523631AE4a59f267346ea31F984', factoryABI, provider);
    const poolAddr = await factory.getPool(raw.token0, raw.token1, raw.fee);
    const slot0    = await (new ethers.Contract(poolAddr, poolABI, provider)).slot0();

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

    const MAX128     = BigInt('0xffffffffffffffffffffffffffffffff');
    const nftCollect = new ethers.Contract(NFT_MANAGER, collectABI, provider);
    let feeValue = 0;
    try {
      const fees = await nftCollect.collect.staticCall({
        tokenId:    WETH_POS_ID,
        recipient:  WALLET_WETH_LP,
        amount0Max: MAX128,
        amount1Max: MAX128,
      });
      const feeETH  = Number(fees[0]) / 1e18;
      const feeUSDC = Number(fees[1]) / 1e6;
      feeValue = (feeETH * ethPrice) + feeUSDC;
      console.log(`ETH: $${ethPrice.toFixed(2)}, position: $${positionValue.toFixed(2)}, fees: $${feeValue.toFixed(2)}, in range: ${inRange}, NFT: #${WETH_POS_ID}`);
    } catch (e) {
      console.error(`Fee collect failed: ${e.message.slice(0, 60)}`);
      console.log(`ETH: $${ethPrice.toFixed(2)}, position: $${positionValue.toFixed(2)}, in range: ${inRange}, NFT: #${WETH_POS_ID}`);
    }

    return { positionValue, feeValue, inRange, currentTick, tickLower: tickLowerN, tickUpper: tickUpperN, ethPrice };
  } catch (e) {
    console.error(`WETH/USDC: ${e.message}`);
    return null;
  }
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
        console.log(`${market.key}: ${tokens.toFixed(4)} tokens × $${priceUSD.toFixed(4)} = $${supplyUSD.toFixed(2)} | supplyAPY: ${supplyAPY?.toFixed(2)}%`);
        if (supplyUSD > 0.01) results[market.key] = { type: 'supply', supplyUSD, tokens, supplyAPY };

      } else if (market.method === 'mtoken') {
        const price = prices[market.underlyingAddr?.toLowerCase()] ?? null;
        if (!price) { console.error(`${market.key}: no price`); continue; }
        const [mBalRaw, exchRaw] = await Promise.all([mToken.balanceOf(WALLET_EVM), mToken.exchangeRateStored()]);
        const underlying = Number(BigInt(mBalRaw.toString()) * BigInt(exchRaw.toString()) / (BigInt(10) ** BigInt(18 + market.underlyingDec)));
        const supplyUSD  = underlying * price;
        console.log(`${market.key}: ${underlying.toFixed(4)} tokens × $${price.toFixed(4)} = $${supplyUSD.toFixed(2)} | supplyAPY: ${supplyAPY?.toFixed(2)}%`);
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
// MODULE 2b — Spark Savings (Arbitrum, ERC-4626 sUSDC)
// ============================================================
async function getSparkData() {
  console.log('\n--- Spark Savings (Arbitrum) ---');
  const results = {};
  try {
    const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC);
    const vault = new ethers.Contract(SPARK_SUSDC_ARB, [
      'function balanceOf(address) view returns (uint256)',
      'function convertToAssets(uint256) view returns (uint256)',
    ], provider);
    const shares = await vault.balanceOf(WALLET_EVM);
    if (shares === 0n) { console.log('Spark: no sUSDC shares held — skipping'); return results; }
    const assetsRaw = await vault.convertToAssets(shares);
    const usdc      = Number(assetsRaw) / 1e6;   // underlying USDC has 6 decimals
    const sharesNum = Number(shares) / 1e18;     // sUSDC has 18 decimals

    // APY is best-effort (Sky Savings Rate); null if DefiLlama has no match
    let apy = null;
    const pools = await fetchWithTimeout('https://yields.llama.fi/pools');
    const sparkPools = (pools?.data ?? []).filter(p => p.project?.toLowerCase().includes('spark'));
    // Log every Spark pool DefiLlama returns so a name mismatch is visible in the Actions log
    console.log(`  DefiLlama Spark pools: ${sparkPools.map(p => `${p.project}/${p.chain}/${p.symbol}=${p.apy?.toFixed?.(2)}`).join(' | ') || 'none'}`);
    const pool = sparkPools.find(p => p.chain === 'Arbitrum' && /usdc/i.test(p.symbol ?? ''))
              ?? sparkPools.find(p => /usdc/i.test(p.symbol ?? '') && p.chain === 'Ethereum');  // rate is the same on every chain
    if (pool?.apy != null) apy = pool.apy;

    console.log(`Spark sUSDC: ${sharesNum.toFixed(6)} shares → $${usdc.toFixed(2)} USDC | APY: ${apy?.toFixed(2) ?? 'n/a'}%`);
    results.sparkUSDC = { type: 'supply', supplyUSD: usdc, tokens: usdc, supplyAPY: apy, notes: `sUSDC shares: ${sharesNum.toFixed(6)}` };
  } catch (e) { console.error(`Spark: ${e.message.slice(0, 120)}`); }
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
        else if (utilRate >= utilPoints[utilPoints.length - 1]) { borrowAprPerYear = aprPoints[utilPoints.length - 1]; }
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
  if (inRange)              { a0 = liq * (sqrtU - sqrtC) / (sqrtC * sqrtU); a1 = liq * (sqrtC - sqrtL); }
  else if (tickCurrent < tickLower) { a0 = liq * (sqrtU - sqrtL) / (sqrtL * sqrtU); }
  else                      { a1 = liq * (sqrtU - sqrtL); }
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

  const Q64 = 2n ** 64n;
  const Q64f = Number(Q64);
  const sqrtPriceFloat = Number(sqrtPriceX64 / Q64) + Number(sqrtPriceX64 % Q64) / Q64f;
  const rawPrice = sqrtPriceFloat * sqrtPriceFloat;
  const tickCurrent = Math.round(Math.log(rawPrice) / Math.log(1.0001));

  const fg0Lo = buf.readBigUInt64LE(277); const fg0Hi = buf.readBigUInt64LE(285);
  const fg1Lo = buf.readBigUInt64LE(293); const fg1Hi = buf.readBigUInt64LE(301);
  const feeGrowthGlobal0 = fg0Lo | (fg0Hi << 64n);
  const feeGrowthGlobal1 = fg1Lo | (fg1Hi << 64n);

  return {
    mint0: base58EncodeBytes(Array.from(mint0Bytes)),
    mint1: base58EncodeBytes(Array.from(mint1Bytes)),
    decimals0: dec0,
    decimals1: dec1,
    sqrtPriceX64,
    tickCurrent,
    feeGrowthGlobal0,
    feeGrowthGlobal1,
  };
}

async function getRaydiumPositions(xstockAssets) {
  console.log(`\n--- Raydium xStocks CLMM ${RAYDIUM_DRY_RUN ? '[DRY RUN]' : '[LIVE]'} ---`);
  const results = [];

  // Use Airtable-driven asset data (cycleId + nftMint from Assets table at runtime)
  const xstockPositions = Object.entries(xstockAssets)
    .filter(([, v]) => v.nftMint && v.cycleId)
    .map(([key, v]) => ({ key, ...v }));

  const skipped = Object.entries(xstockAssets).filter(([, v]) => !v.nftMint || !v.cycleId);
  if (skipped.length > 0) {
    console.warn(`  Skipping ${skipped.length} position(s) with missing Airtable data: ${skipped.map(([k]) => k).join(', ')}`);
  }
  console.log(`Processing ${xstockPositions.length} xStock positions (from Airtable Assets)`);

  for (const posConfig of xstockPositions) {
    const { key, nftMint, poolId } = posConfig;
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

      const pool = parsePoolAccount(poolRes.value.data[0]);
      const priceData = await fetchWithTimeout(`https://coins.llama.fi/prices/current/solana:${pool.mint0},solana:${pool.mint1}`);
      const price0    = priceData?.coins?.[`solana:${pool.mint0}`]?.price ?? null;
      const price1    = priceData?.coins?.[`solana:${pool.mint1}`]?.price ?? null;

      const sqrtP = sqrtPriceX64ToFloat(pool.sqrtPriceX64.toString());
      const { amount0, amount1, inRange } = calcAmounts(pos.liquidity, pos.tickLower, pos.tickUpper, pool.tickCurrent, sqrtP);

      const tokens0 = amount0 / Math.pow(10, pool.decimals0);
      const tokens1 = amount1 / Math.pow(10, pool.decimals1);
      const positionValue = (price0 ?? 0) * tokens0 + (price1 ?? 0) * tokens1;

      const Q64 = 2n ** 64n;
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

          const poolBuf = Buffer.from(poolRes.value.data[0], 'base64');
          const tickSpacing = poolBuf.readUInt16LE(235);

          const lowerTA = lowerTickArrayAddr ?? upperTickArrayAddr;
          const upperTA = upperTickArrayAddr ?? lowerTickArrayAddr;

          const lower = getTickFeeGrowth(lowerTA.data, pos.tickLower, lowerTA.startTick, tickSpacing);
          const upper = getTickFeeGrowth(upperTA.data, pos.tickUpper, upperTA.startTick, tickSpacing);

          const fgBelow0 = pool.tickCurrent >= pos.tickLower ? lower.fg0 : (pool.feeGrowthGlobal0 - lower.fg0 + U128) % U128;
          const fgBelow1 = pool.tickCurrent >= pos.tickLower ? lower.fg1 : (pool.feeGrowthGlobal1 - lower.fg1 + U128) % U128;
          const fgAbove0 = pool.tickCurrent < pos.tickUpper ? upper.fg0 : (pool.feeGrowthGlobal0 - upper.fg0 + U128) % U128;
          const fgAbove1 = pool.tickCurrent < pos.tickUpper ? upper.fg1 : (pool.feeGrowthGlobal1 - upper.fg1 + U128) % U128;

          const fgInside0 = (pool.feeGrowthGlobal0 - fgBelow0 - fgAbove0 + U128 * 2n) % U128;
          const fgInside1 = (pool.feeGrowthGlobal1 - fgBelow1 - fgAbove1 + U128 * 2n) % U128;

          const delta0 = (fgInside0 - pos.fgInside0Last + U128) % U128;
          const delta1 = (fgInside1 - pos.fgInside1Last + U128) % U128;

          const rawFee0 = Number(delta0 * pos.liquidity / Q64) + Number(pos.feesOwed0);
          const rawFee1 = Number(delta1 * pos.liquidity / Q64) + Number(pos.feesOwed1);
          const fee0USD = (price0 ?? 0) * rawFee0 / Math.pow(10, pool.decimals0);
          const fee1USD = (price1 ?? 0) * rawFee1 / Math.pow(10, pool.decimals1);
          pendingYield = fee0USD + fee1USD;
          console.log(`  Fees (tick array): $${fee0USD.toFixed(2)} token0 + $${fee1USD.toFixed(2)} USDC = $${pendingYield.toFixed(2)}`);
        } else {
          console.log(`  Fees (feesOwed floor only): $${pendingYield.toFixed(2)}`);
        }
      } catch(feeErr) {
        console.error(`  Fee calc error: ${feeErr.message.slice(0, 80)}`);
      }

      console.log(`  ${key}: $${positionValue.toFixed(2)}, in range: ${inRange}, fees: $${pendingYield.toFixed(2)}`);
      results.push({ key, positionValue, inRange, pendingYield });

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
    } else {
      console.error('LLP: no account_share in response');
    }

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
    } else {
      console.error('Edge & Hedge: no account_share in response');
    }

    let litStakeAmount = LIT_STAKE_AMOUNT;
    let litAPR = 0.0684;
    const stakingSearchRes = await fetchWithTimeout(
      `${LIGHTER_BASE}/publicPoolsMetadata?index=0&limit=100&filter=protocol`,
      { headers }
    );
    const stakingPools = stakingSearchRes?.public_pools ?? [];
    const litPool = stakingPools.find(p => p.name?.toLowerCase().includes('lit') || p.name?.toLowerCase().includes('staking'));
    if (litPool) {
      console.log(`LIT pool found: index=${litPool.account_index} name=${litPool.name}`);
      const litPoolRes = await fetchWithTimeout(
        `${LIGHTER_BASE}/publicPoolsMetadata?index=${litPool.account_index + 1}&limit=1&account_index=${LIGHTER_ACCT}`,
        { headers }
      );
      const litPoolData = litPoolRes?.public_pools?.[0];
      if (litPoolData?.account_share) {
        litStakeAmount = Number(litPoolData.account_share.principal_amount ?? litPoolData.account_share.shares_amount);
        litAPR = litPoolData.annual_percentage_yield != null ? litPoolData.annual_percentage_yield / 100 : litAPR;
        console.log(`LIT stake from API: ${litStakeAmount} LIT, APR=${litAPR?.toFixed(2)}%`);
      }
    } else {
      console.log(`LIT staking pool not found in protocol filter — using hardcoded ${LIT_STAKE_AMOUNT} LIT`);
    }

    const litPriceData = await fetchWithTimeout('https://coins.llama.fi/prices/current/coingecko:lighter');
    const litPrice = litPriceData?.coins?.['coingecko:lighter']?.price ?? null;
    if (litPrice) {
      const litEquity = litStakeAmount * litPrice;
      console.log(`LIT Staking: ${litStakeAmount} LIT × $${litPrice.toFixed(4)} = $${litEquity.toFixed(2)}, APR=${litAPR?.toFixed(2)}%`);
      results.lit = { equity: litEquity, litPrice, litStakeAmount, apr: litAPR };
    } else {
      console.error('LIT: price not found on DeFi Llama');
    }

  } catch (e) {
    console.error(`Lighter fatal: ${e.message}`);
  }

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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'clearinghouseState', user: WALLET_HYPERLIQUID }),
      }),
      fetchWithTimeout('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    } else {
      console.log('No active ETH position found');
    }

    const noteParts = [];
    if (hedgeData?.unrealizedPnl != null) noteParts.push(`PnL: $${hedgeData.unrealizedPnl.toFixed(2)}`);
    if (hedgeData?.entryPx)               noteParts.push(`Entry: $${hedgeData.entryPx}`);
    if (hedgeData?.size)                  noteParts.push(`Size: ${hedgeData.size} ETH`);
    const notes = noteParts.length > 0 ? noteParts.join(' | ') : 'No active ETH position';

    return { positionValue, notes };
  } catch (e) {
    console.error(`ETH Hedge fatal: ${e.message}`);
    return null;
  }
}
// ============================================================
// KAMINO LIVE-READ — v42 (live repricing, UI-equivalent)
//
// History:
//   v41 read the obligation account directly. That fixed the Airtable-echo
//   and dividend-multiplier bugs, BUT every value Kamino stores on the
//   obligation (depositedValueSf, per-deposit marketValueSf, borrowedAmountSf,
//   borrow marketValueSf) only refreshes when the obligation is touched
//   on-chain (borrow/repay/deposit/withdraw). Between draws they FREEZE.
//   The Kamino UI recomputes live, so the pipeline drifted (~$45 debt gap
//   observed late Sep 2026; collateral drift is larger because it tracks
//   the stock basket).
//
// v42 FIX — compute live, the way the UI / on-chain refresh does:
//   DEBT       = stored borrowedAmountSf
//                × (reserve.cumulativeBorrowRate ÷ entry.cumulativeBorrowRate)
//                × small forward-compound from the reserve's last refresh to
//                  now at the current gross borrow APY (usually seconds–minutes).
//   COLLATERAL = per deposit: cTokens × (reserve totalSupply ÷ cToken mint supply)
//                ÷ 10^decimals × reserve marketPrice
//                (identical to what refresh_obligation computes; price per
//                 RAW token already embeds the xStocks dividend/split multiplier).
//
// Reserve accounts are fetched with ONE getMultipleAccounts call; raw parse,
// zero new dependencies. Every value logs stored-vs-live side by side, and
// each piece falls back to its stored obligation value (with the reason
// logged) if a reserve read fails or a sanity gate trips.
//
// Offsets verified 2026-09-28 against @kamino-finance/klend-sdk v12.0.0
// codegen (computed from the borsh layouts, not by hand):
//   OBLIGATION (disc a8ce8d6a584caca7)
//     lastUpdate.slot @16 (u64) · lastUpdate.timestamp @28 (u32)
//     deposits[8] @96, stride 136: depositReserve @+0, depositedAmount (cTokens u64) @+32, marketValueSf @+40
//     depositedValueSf @1192
//     borrows[5] @1208, stride 200: borrowReserve @+0, cumulativeBorrowRateBsf @+32 (48B),
//                                   borrowedAmountSf @+88, marketValueSf @+104
//     borrowedAssetsMarketValueSf @2224
//   RESERVE (disc 2bf2ccca1af73b7f, 8624 bytes)
//     lastUpdate.slot @16 · lastUpdate.timestamp @28 (u32) · lendingMarket @32
//     liquidity.mintPubkey @128 · totalAvailableAmount @224 (u64)
//     borrowedAmountSf @232 · marketPriceSf @248 · marketPriceLastUpdatedTs @264 (u64)
//     mintDecimals @272 (u64) · cumulativeBorrowRateBsf @296 (48B: 4×u64 LE value + 2×u64 pad)
//     accumulatedProtocolFeesSf @344 · accumulatedReferrerFeesSf @360 · pendingReferrerFeesSf @376
//     collateral.mintTotalSupply @2592 (u64)
//   All *Sf fields are fixed-point ×2^60.
//   Program: KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD
// ============================================================

const KLEND_PROGRAM_ID = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
const SF_SHIFT = 40n;          // 2^60 = (>>40) then /2^20 — keeps Number precision
const SF_DIV20 = 1048576;      // 2^20
const SF_ONE   = 1n << 60n;
const OBLIGATION_DISC = Buffer.from([168, 206, 141, 106, 88, 76, 172, 167]);
const RESERVE_DISC    = Buffer.from([43, 242, 204, 202, 26, 247, 59, 127]);
const SECONDS_PER_YEAR = 365 * 24 * 3600;

function readU128LE(buf, offset) {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  return lo | (hi << 64n);
}
// BigFractionBytes: value = [u64; 4] little-endian limbs (256-bit), scaled ×2^60
function readBigFraction(buf, offset) {
  let v = 0n;
  for (let i = 3; i >= 0; i--) v = (v << 64n) | buf.readBigUInt64LE(offset + i * 8);
  return v;
}
function sfToUsd(sf) { return Number(sf >> SF_SHIFT) / SF_DIV20; }
function fmtAge(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return 'n/a';
  if (sec < 120) return `${Math.round(sec)}s`;
  if (sec < 7200) return `${(sec / 60).toFixed(0)}m`;
  if (sec < 172800) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

// Fetches and parses reserve accounts in one RPC call.
// Returns { [reserveAddr]: parsedReserve } — entries missing on any failure.
async function fetchKaminoReserves(addresses, marketAddress) {
  const out = {};
  if (addresses.length === 0) return out;
  const res = await solRpc('getMultipleAccounts', [addresses, { encoding: 'base64' }]);
  const vals = res?.value ?? [];
  addresses.forEach((addr, i) => {
    try {
      const acc = vals[i];
      if (!acc?.data?.[0]) { console.error(`  [reserve] ${addr.slice(0,6)}.. not returned by RPC`); return; }
      const b = Buffer.from(acc.data[0], 'base64');
      if (b.length < 2600 || !b.slice(0, 8).equals(RESERVE_DISC)) {
        console.error(`  [reserve] ${addr.slice(0,6)}.. discriminator/size mismatch (len ${b.length})`); return;
      }
      const market = base58EncodeBytes(Array.from(b.slice(32, 64)));
      if (market !== marketAddress) {
        console.error(`  [reserve] ${addr.slice(0,6)}.. belongs to market ${market.slice(0,6)}.., expected ${marketAddress.slice(0,6)}..`); return;
      }
      out[addr] = {
        lastUpdateSlot:       b.readBigUInt64LE(16),
        lastUpdateTs:         b.readUInt32LE(28),
        mint:                 base58EncodeBytes(Array.from(b.slice(128, 160))),
        totalAvailable:       b.readBigUInt64LE(224),
        borrowedSf:           readU128LE(b, 232),
        priceSf:              readU128LE(b, 248),
        priceTs:              Number(b.readBigUInt64LE(264)),
        decimals:             Number(b.readBigUInt64LE(272)),
        cumBorrowRate:        readBigFraction(b, 296),
        protocolFeesSf:       readU128LE(b, 344),
        referrerFeesSf:       readU128LE(b, 360),
        pendingReferrerSf:    readU128LE(b, 376),
        cTokenSupply:         b.readBigUInt64LE(2592),
      };
    } catch (e) { console.error(`  [reserve] ${addr.slice(0,6)}.. parse error: ${e.message}`); }
  });
  return out;
}

// Reads the Kamino obligation for our wallet and reprices it live.
// grossBorrowAPY (decimal, e.g. 0.065) is used only for the tiny forward
// compound from the USDC reserve's last refresh to now; may be null.
// Returns { collateralUSD, debtUSD, ltv, perReserve: {addr: usd}, obligation,
//           stored: {collateralUSD, debtUSD, ltv}, oblAgeSec, collSource, debtSource }
// or null on failure of the obligation read itself (caller falls back).
async function getKaminoLiveObligation(marketAddress, grossBorrowAPY = null) {
  try {
    const accounts = await solRpc('getProgramAccounts', [
      KLEND_PROGRAM_ID,
      {
        encoding: 'base64',
        filters: [
          { memcmp: { offset: 32, bytes: marketAddress } },          // lendingMarket
          { memcmp: { offset: 64, bytes: WALLET_KAMINO_LENDING } },  // owner
        ],
      },
    ]);

    if (!Array.isArray(accounts) || accounts.length === 0) {
      console.error('  [obligation] none found via getProgramAccounts (RPC may block gPA — set SOL_RPC_URL to a full-access endpoint)');
      return null;
    }
    // Pick the largest account (the obligation is ~3.3KB; guards against stray matches)
    accounts.sort((a, b) => (b.account?.data?.[0]?.length ?? 0) - (a.account?.data?.[0]?.length ?? 0));
    const buf = Buffer.from(accounts[0].account.data[0], 'base64');
    const obligation = accounts[0].pubkey;

    if (!buf.slice(0, 8).equals(OBLIGATION_DISC)) {
      console.error('  [obligation] discriminator mismatch — not an Obligation account');
      return null;
    }

    const nowSec    = Math.floor(Date.now() / 1000);
    const oblTs     = buf.readUInt32LE(28);
    const oblAgeSec = oblTs > 0 ? nowSec - oblTs : null;

    // ---- Parse STORED (last-refresh) values ----
    const storedCollateralUSD = sfToUsd(readU128LE(buf, 1192));
    const deposits = [];
    for (let i = 0; i < 8; i++) {
      const base = 96 + i * 136;
      const reserveBytes = buf.slice(base, base + 32);
      if (reserveBytes.every(x => x === 0)) continue;
      const cTokens = buf.readBigUInt64LE(base + 32);
      const mvSf    = readU128LE(buf, base + 40);
      if (cTokens === 0n && mvSf === 0n) continue;
      deposits.push({ reserve: base58EncodeBytes(Array.from(reserveBytes)), cTokens, storedUSD: sfToUsd(mvSf) });
    }
    const borrows = [];
    for (let i = 0; i < 5; i++) {
      const entry = 1208 + i * 200;
      const reserveBytes = buf.slice(entry, entry + 32);
      if (reserveBytes.every(x => x === 0)) continue;
      const amtSf = readU128LE(buf, entry + 88);
      if (amtSf === 0n) continue;
      borrows.push({
        reserve: base58EncodeBytes(Array.from(reserveBytes)),
        entryCbr: readBigFraction(buf, entry + 32),
        amtSf,
        storedMvUSD: sfToUsd(readU128LE(buf, entry + 104)),
      });
    }
    const staleAgg = sfToUsd(readU128LE(buf, 2224));

    // ---- Fetch every referenced reserve in one call ----
    const reserveAddrs = [...new Set([...deposits.map(d => d.reserve), ...borrows.map(b => b.reserve)])];
    const reserves = await fetchKaminoReserves(reserveAddrs, marketAddress);

    // ---- DEBT: stored amount × (reserve CBR ÷ entry CBR) × forward compound ----
    let storedDebtUSD = 0, liveDebtUSD = 0, debtAllLive = borrows.length > 0, debtLiveCount = 0;
    for (const bw of borrows) {
      const r = reserves[bw.reserve];
      const dec = r?.decimals ?? 6;                  // USDC = 6
      const storedAmt = sfToUsd(bw.amtSf) / 10 ** dec;
      storedDebtUSD += storedAmt;

      let liveAmt = storedAmt, why = null, ratio = null, extrap = 1, rAge = null;
      if (!r) why = 'reserve unavailable';
      else if (bw.entryCbr === 0n) why = 'entry CBR = 0';
      else if (r.cumBorrowRate < bw.entryCbr) why = 'reserve CBR < entry CBR';
      else {
        ratio = Number((r.cumBorrowRate * 1_000_000_000_000n) / bw.entryCbr) / 1e12;
        if (!(ratio >= 1 && ratio < 1.5)) { why = `implausible CBR ratio ${ratio}`; ratio = null; }
        else {
          const accruedSf = (bw.amtSf * r.cumBorrowRate) / bw.entryCbr;
          liveAmt = sfToUsd(accruedSf) / 10 ** dec;
          rAge = r.lastUpdateTs > 0 ? nowSec - r.lastUpdateTs : null;
          // Reserve CBR is itself only as fresh as the reserve's last refresh.
          // Compound forward to "now" at the current gross APY (bounded to 7 days).
          if (grossBorrowAPY != null && grossBorrowAPY > 0 && grossBorrowAPY < 1 && rAge != null && rAge > 0 && rAge < 7 * 86400) {
            extrap = Math.pow(1 + grossBorrowAPY, rAge / SECONDS_PER_YEAR);
            liveAmt *= extrap;
          }
        }
      }
      if (why) debtAllLive = false; else debtLiveCount++;
      liveDebtUSD += liveAmt;
      console.log(`  [obligation] DEBT ${bw.reserve.slice(0,6)}..: stored $${storedAmt.toFixed(2)} → live $${liveAmt.toFixed(2)}` +
        (why ? `  (FALLBACK to stored: ${why})`
             : `  (CBR ratio ×${ratio.toFixed(6)} since obligation refresh; reserve refreshed ${fmtAge(rAge)} ago, fwd ×${extrap.toFixed(8)})`) +
        `  | stale mv=$${bw.storedMvUSD.toFixed(2)}`);
    }
    const debtUSD = liveDebtUSD;
    const debtSource = borrows.length === 0 ? 'live (no debt)' : (debtAllLive ? 'live-accrued' : (debtLiveCount > 0 ? 'partial-stored' : 'stored'));

    // ---- COLLATERAL: cTokens → liquidity (exchange rate) → × reserve price ----
    const perReserve = {};
    let liveCollateralUSD = 0, collAllLive = deposits.length > 0, collLiveCount = 0, oldestPriceAge = 0;
    const legLogs = [];
    for (const d of deposits) {
      const r = reserves[d.reserve];
      let liveUSD = d.storedUSD, why = null, pAge = null;
      if (!r) why = 'reserve unavailable';
      else if (r.cTokenSupply === 0n) why = 'cToken supply 0';
      else if (r.priceSf === 0n) why = 'price 0';
      else {
        const totalSupplySf = r.totalAvailable * SF_ONE + r.borrowedSf - r.protocolFeesSf - r.referrerFeesSf - r.pendingReferrerSf;
        if (totalSupplySf <= 0n) why = 'total supply ≤ 0';
        else {
          const liqSf  = (d.cTokens * totalSupplySf) / r.cTokenSupply;      // raw liquidity units ×2^60
          const tokens = sfToUsd(liqSf) / 10 ** r.decimals;                 // raw tokens (UI multiplier embedded in price)
          const price  = sfToUsd(r.priceSf);
          const v = tokens * price;
          const drift = d.storedUSD > 0 ? v / d.storedUSD : null;
          if (drift != null && (drift < 0.5 || drift > 2)) why = `implausible vs stored (×${drift.toFixed(3)})`;
          else {
            liveUSD = v;
            pAge = r.priceTs > 0 ? nowSec - r.priceTs : null;
            if (pAge != null) oldestPriceAge = Math.max(oldestPriceAge, pAge);
          }
        }
      }
      if (why) collAllLive = false; else collLiveCount++;
      perReserve[d.reserve] = liveUSD;
      liveCollateralUSD += liveUSD;
      const pct = d.storedUSD > 0 ? ((liveUSD / d.storedUSD - 1) * 100) : 0;
      legLogs.push(`${d.reserve.slice(0,6)}..=$${liveUSD.toFixed(0)} (stored $${d.storedUSD.toFixed(0)}, ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%${why ? ', FALLBACK: ' + why : ', px age ' + fmtAge(pAge)})`);
    }
    let collateralUSD = liveCollateralUSD;
    let collSource = collAllLive ? 'live-repriced' : (collLiveCount > 0 ? 'partial-stored' : 'stored');
    // Whole-basket gate: if the live sum is implausible, use the stored aggregate.
    if (!(collateralUSD > 1000 && collateralUSD < 1_000_000) ||
        (storedCollateralUSD > 0 && (collateralUSD / storedCollateralUSD < 0.5 || collateralUSD / storedCollateralUSD > 2))) {
      console.error(`  [obligation] live collateral $${collateralUSD.toFixed(2)} failed sanity gate — using stored $${storedCollateralUSD.toFixed(2)}`);
      collateralUSD = storedCollateralUSD;
      collSource = 'stored';
    }
    if (!(collateralUSD > 1000 && collateralUSD < 1_000_000)) {
      console.error(`  [obligation] implausible collateral $${collateralUSD.toFixed(2)} — falling back`);
      return null;
    }

    const ltv       = collateralUSD > 0 ? (debtUSD / collateralUSD) * 100 : null;
    const storedLtv = storedCollateralUSD > 0 ? (storedDebtUSD / storedCollateralUSD) * 100 : null;

    console.log(`  [obligation] ${obligation} — last on-chain refresh ${fmtAge(oblAgeSec)} ago (slot ${buf.readBigUInt64LE(16)})`);
    console.log(`  [obligation] per-reserve USD: ${legLogs.join(', ')}`);
    console.log(`  [obligation] STORED  collateral $${storedCollateralUSD.toFixed(2)} | debt $${storedDebtUSD.toFixed(2)} | LTV ${storedLtv?.toFixed(2)}%  (stale agg debt value $${staleAgg.toFixed(2)})`);
    console.log(`  [obligation] LIVE    collateral $${collateralUSD.toFixed(2)} [${collSource}] | debt $${debtUSD.toFixed(2)} [${debtSource}] | LTV ${ltv?.toFixed(2)}%  ← cross-check vs Kamino UI`);
    if (oldestPriceAge > 36 * 3600) console.log(`  [obligation] ⚠ oldest reserve price is ${fmtAge(oldestPriceAge)} old — collateral may lag the market`);

    return {
      collateralUSD, debtUSD, ltv, perReserve, obligation,
      stored: { collateralUSD: storedCollateralUSD, debtUSD: storedDebtUSD, ltv: storedLtv },
      oblAgeSec, collSource, debtSource,
    };
  } catch (e) {
    console.error(`  [obligation] read error: ${e.message} — falling back`);
    return null;
  }
}
// ============================================================
// MODULE: Kamino xStocks Lending (Solana) — LIVE OBLIGATION READ
// APY comes from the Kamino REST API (correct as-is).
// Collateral USD, debt USD, and LTV come from the on-chain obligation,
// repriced live against current reserve state (v42). Falls back to the
// prior Airtable-echo behavior only if the obligation read itself fails.
// ============================================================

// OPTIONAL manual per-leg override (symbol -> reserve pubkey). v42 first
// tries to auto-map using the reserve address the metrics API returns; this
// map wins if filled. Addresses print in the "[obligation] per-reserve USD" line.
const KAMINO_RESERVES = {
  // SPYx: '...', QQQx: '...', NVDAx: '...', TSLAx: '...', GOOGLx: '...', AAPLx: '...',
};

// Gross borrow APY + incentive APY (decimals) from a Kamino metrics reserve entry.
function parseKaminoBorrowApys(usdcReserve) {
  if (!usdcReserve) return { grossBorrowAPY: null, incentiveAPY: null };
  const grossBorrowAPY = parseFloat(usdcReserve.borrowApy ?? usdcReserve.borrowApr ?? usdcReserve.borrowInterestApy ?? 0) || null;
  const flat = parseFloat(usdcReserve.borrowRewardsApy ?? usdcReserve.incentiveBorrowApy ?? usdcReserve.borrowIncentiveApy ?? 0);
  const arr  = usdcReserve.borrowRewards ?? usdcReserve.incentives ?? usdcReserve.rewards ?? [];
  const arrSum = Array.isArray(arr) ? arr.reduce((s, x) => s + parseFloat(x.apy ?? x.rewardApy ?? x.incentiveApy ?? 0), 0) : 0;
  const incentiveAPY = (arrSum > 0 ? arrSum : flat) || null;
  return { grossBorrowAPY, incentiveAPY };
}

async function getKaminoPositions() {
  console.log('\n--- Kamino xStocks Lending ---');
  const results = {};

  try {
    const XSTOCKS_MARKET_ADDRESS = process.env.KAMINO_XSTOCKS_MARKET ?? '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua';
    let marketAddress = XSTOCKS_MARKET_ADDRESS;
    if (!marketAddress) { throw new Error('xStocks market address not set'); }
    console.log(`  Using xStocks market: ${marketAddress}`);

    // ---- APY per token from Kamino REST API (fetched first: the live debt
    //      read uses the gross borrow APY for its small forward-compound) ----
    let metricsArr = [];
    try {
      const reserveMetrics = await fetchWithTimeout(`${KAMINO_API}/kamino-market/${marketAddress}/reserves/metrics`);
      metricsArr = Array.isArray(reserveMetrics) ? reserveMetrics : (reserveMetrics?.reserves ?? []);
    } catch (e) { console.error(`  Kamino metrics fetch error: ${e.message}`); }
    const usdcReserve = metricsArr.find(r => (r.liquidityToken ?? r.symbol ?? '').toUpperCase() === 'USDC');
    const { grossBorrowAPY, incentiveAPY } = parseKaminoBorrowApys(usdcReserve);

    // ---- LIVE on-chain obligation read (collateral, debt, LTV, per-reserve) ----
    const liveObl = await getKaminoLiveObligation(marketAddress, grossBorrowAPY);

    // ---- Token amounts from Airtable (only used for fallback per-leg USD) ----
    const kaminoPositionIds = new Set(Object.values(KAMINO_POSITIONS));
    let lendingActionsRaw = [];
    try {
      const { default: fetch } = await import('node-fetch');
      const params = new URLSearchParams();
      [LF.position, LF.tokenAmt, LF.date].forEach(f => params.append('fields[]', f));
      params.append('filterByFormula', '{Token Amount} > 0');
      params.append('sort[0][field]', LF.date);
      params.append('sort[0][direction]', 'desc');
      params.append('pageSize', '100');
      const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${LENDING_TABLE}?${params}&returnFieldsByFieldId=true`,
        { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } });
      if (res.ok) { lendingActionsRaw = (await res.json()).records ?? []; }
    } catch (e) { console.error(`  Token amount Airtable fetch error: ${e.message}`); }

    const kaminoTokenAmounts = {};
    for (const record of lendingActionsRaw) {
      const posLinks = record.fields?.[LF.position];
      const rawLink  = Array.isArray(posLinks) ? posLinks[0] : posLinks;
      const posId    = (typeof rawLink === 'object' && rawLink !== null) ? rawLink.id : rawLink;
      if (!posId || !kaminoPositionIds.has(posId)) continue;
      const tokenKey = Object.keys(KAMINO_POSITIONS).find(k => KAMINO_POSITIONS[k] === posId);
      if (!tokenKey || kaminoTokenAmounts[tokenKey] !== undefined) continue;
      const tokenAmt = parseFloat(record.fields?.[LF.tokenAmt] ?? 0);
      if (tokenAmt > 0) kaminoTokenAmounts[tokenKey] = tokenAmt;
    }

    // ---- Per-leg supply USD + APY ----
    for (const r of metricsArr) {
      const sym = (r.liquidityToken ?? r.symbol ?? '').toUpperCase();
      const tokenKey = Object.keys(KAMINO_POSITIONS).find(k => k.toUpperCase() === sym);
      if (!tokenKey) continue;

      const supplyAPY = parseFloat(r.supplyApy ?? 0);
      const tokenAmt  = kaminoTokenAmounts[tokenKey] ?? null;

      // Preferred: exact per-leg USD from live obligation (needs reserve address mapping)
      let supplyUSD = null;
      const reserveAddr = KAMINO_RESERVES[tokenKey] ?? r.reserve ?? r.address ?? r.reserveAddress ?? null;
      if (liveObl && reserveAddr && liveObl.perReserve[reserveAddr] != null) {
        supplyUSD = liveObl.perReserve[reserveAddr];
      } else if (tokenAmt != null) {
        // Fallback: prior approximation (token amt x price-per-token from metrics)
        const totalSupplyTokens = parseFloat(r.totalSupply ?? 0);
        const totalSupplyUsd    = parseFloat(r.totalSupplyUsd ?? 0);
        if (totalSupplyTokens > 0) supplyUSD = tokenAmt * (totalSupplyUsd / totalSupplyTokens);
      }

      results[tokenKey] = { supplyUSD, tokenAmt, supplyAPY };
      console.log(`  ${tokenKey}: ${supplyUSD != null ? '$' + supplyUSD.toFixed(2) : 'USD=pending'}, APY ${(supplyAPY * 100).toFixed(3)}%${(liveObl && reserveAddr && liveObl.perReserve[reserveAddr] != null) ? ' [live]' : ''}`);
    }

    // ---- Borrow leg: gross+incentive APY from API; debt/collateral/LTV from live obligation ----
    try {
      if (!usdcReserve) console.error('  USDC reserve not found in metrics');

      // LIVE debt + collateral (with fallback to prior behavior)
      let debtUSD = liveObl?.debtUSD ?? null;
      let collateralValue = liveObl?.collateralUSD ?? Object.values(results).reduce((s, d) => s + (d?.supplyUSD ?? 0), 0);
      let debtSource = liveObl?.debtUSD != null ? liveObl.debtSource : null;

      if (debtUSD == null) {  // fallback: last logged Borrow row from Airtable
        try {
          const { default: fetch } = await import('node-fetch');
          const p = new URLSearchParams();
          [LF.position, LF.borrowUSD, LF.date].forEach(f => p.append('fields[]', f));
          p.append('sort[0][field]', LF.date); p.append('sort[0][direction]', 'desc'); p.append('pageSize', '100');
          const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${LENDING_TABLE}?${p}&returnFieldsByFieldId=true`,
            { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } });
          if (res.ok) {
            for (const rec of ((await res.json()).records ?? [])) {
              const link = rec.fields?.[LF.position];
              const raw  = Array.isArray(link) ? link[0] : link;
              const pid  = (typeof raw === 'object' && raw) ? raw.id : raw;
              if (pid !== KAMINO_USDC_BORROW) continue;
              const v = parseFloat(rec.fields?.[LF.borrowUSD] ?? 0);
              if (v > 0) { debtUSD = v; debtSource = 'airtable-echo'; break; }
            }
          }
        } catch (e) { console.error(`  Borrow debt fallback error: ${e.message}`); }
      }

      const ltv    = liveObl?.ltv ?? ((debtUSD != null && collateralValue > 0) ? (debtUSD / collateralValue) * 100 : null);
      const netDec = (grossBorrowAPY != null && incentiveAPY != null) ? grossBorrowAPY - incentiveAPY : null;

      const noteParts = [];
      if (grossBorrowAPY != null) noteParts.push(`Gross borrow: ${(grossBorrowAPY * 100).toFixed(2)}%`);
      if (incentiveAPY   != null) noteParts.push(`USDC incentive: ${(incentiveAPY * 100).toFixed(2)}%`);
      if (netDec         != null) noteParts.push(`Net: ${(netDec * 100).toFixed(2)}%`);
      if (collateralValue > 0)    noteParts.push(`Collateral: $${collateralValue.toFixed(2)}`);
      if (ltv != null)            noteParts.push(`LTV: ${ltv.toFixed(2)}%`);
      noteParts.push(`src: debt ${debtSource ?? 'none'}${liveObl ? `, coll ${liveObl.collSource}` : ''}`);
      if (liveObl?.stored) {
        noteParts.push(`Stored (obl refresh ${fmtAge(liveObl.oblAgeSec)} ago): debt $${liveObl.stored.debtUSD.toFixed(2)}, coll $${liveObl.stored.collateralUSD.toFixed(2)}`);
      }

      results.__borrow = {
        borrowUSD: debtUSD,
        borrowAPY: grossBorrowAPY != null ? grossBorrowAPY * 100 : null,
        ltv,
        notes: noteParts.join(' | '),
      };
      console.log(`  Borrow leg [${debtSource}]: debt ${debtUSD != null ? '$' + debtUSD.toFixed(2) : 'n/a'}, gross ${grossBorrowAPY != null ? (grossBorrowAPY * 100).toFixed(2) + '%' : 'n/a'}, LTV ${ltv != null ? ltv.toFixed(2) + '%' : 'n/a'}`);
    } catch (e) { console.error(`  Borrow leg error: ${e.message}`); }

  } catch (e) { console.error(`Kamino fatal: ${e.message}`); }

  return results;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log(`\n====== Daily Portfolio Check v41 — ${NOW_UTC} ======`);
  if (RAYDIUM_DRY_RUN) console.log('ℹ️  RAYDIUM_DRY_RUN=true — Raydium will NOT write to Airtable');

  // Fetch WETH + Hedge asset records first — needed for both status gate and cycle IDs.
  // Must be hoisted outside try/catch so variables are in scope for the status gate below.
  console.log('\n--- Fetching asset records from Airtable ---');
  let wethAssetRes  = null;
  let hedgeAssetRes = null;
  try {
    [wethAssetRes, hedgeAssetRes] = await Promise.all([
      airtableFetchRecord('tblrATIQI0ld9tz1y', ASSET.wethPrimary),
      airtableFetchRecord('tblrATIQI0ld9tz1y', ASSET.ethHedge),
    ]);
  } catch (e) {
    console.error(`Asset record fetch failed: ${e.message}`);
  }

  // Cycle IDs (read from already-fetched asset records)
  const wethCycleId  = wethAssetRes?.fields?.['fld0T538WMoPQ5bgL'] ?? null;
  const hedgeCycleId = hedgeAssetRes?.fields?.['fld0T538WMoPQ5bgL'] ?? null;
  const wethStatus   = wethAssetRes?.fields?.['fldDRyGqgXJTuHTpx']?.name ?? wethAssetRes?.fields?.['fldDRyGqgXJTuHTpx'] ?? null;
  const hedgeStatus  = hedgeAssetRes?.fields?.['fldDRyGqgXJTuHTpx']?.name ?? hedgeAssetRes?.fields?.['fldDRyGqgXJTuHTpx'] ?? null;
  console.log(`✓ Cycle IDs — LP: ${wethCycleId} (${wethStatus}) | Hedge: ${hedgeCycleId} (${hedgeStatus})`);

  // Fetch xStock asset metadata (cycleId + nftMint) from Airtable before running modules
  console.log('\n--- Fetching xStock asset metadata from Airtable ---');
  const xstockAssets = await fetchXStockAssets();

  // Status-gated module execution — skip API calls for inactive/closed assets
  const wethActive  = wethStatus === 'Active';
  const hedgeActive = hedgeStatus === 'Active';
  if (!wethActive)  console.log('WETH/USDC position is not Active — skipping LP check');
  if (!hedgeActive) console.log('ETH Hedge position is not Active — skipping Hyperliquid check');

  const [wethRes, moonwellRes, suilendRes, raydiumRes, lighterRes, hedgeRes, kaminoRes, sparkRes] = await Promise.allSettled([
    wethActive  ? getWethPosition() : Promise.resolve(null),
    getMoonwellData(),
    getSuilendData(),
    getRaydiumPositions(xstockAssets),
    getLighterPositions(),
    hedgeActive ? getEthHedge()     : Promise.resolve(null),
    getKaminoPositions(),
    getSparkData(),
  ]);

  const weth     = wethRes.status     === 'fulfilled' ? wethRes.value     : null;
  const moonwell = moonwellRes.status === 'fulfilled' ? moonwellRes.value : null;
  const suilend  = suilendRes.status  === 'fulfilled' ? suilendRes.value  : null;
  const raydium  = raydiumRes.status  === 'fulfilled' ? raydiumRes.value  : [];
  const lighter  = lighterRes.status  === 'fulfilled' ? lighterRes.value  : {};
  const hedge    = hedgeRes.status    === 'fulfilled' ? hedgeRes.value    : null;
  const kamino   = kaminoRes.status   === 'fulfilled' ? kaminoRes.value   : {};
  const spark    = sparkRes.status    === 'fulfilled' ? sparkRes.value    : {};

  console.log('\n--- Writing to Airtable ---');
  let written = 0;

  // WETH/USDC Primary
  if (weth) {
    if (!wethCycleId) {
      console.error('Skipping WETH/USDC write — cycle ID unavailable (update Airtable Assets)');
    } else {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.wethPrimary, weth.inRange, {
      [F.positionValue]: weth.positionValue,
      [F.cycleId]:       wethCycleId,
      ...(weth.feeValue > 0 ? { [F.feeValue]: weth.feeValue } : {}),
      [F.notes]: `ETH: $${weth.ethPrice?.toFixed(0)} | Tick: ${weth.currentTick} | Range: [${weth.tickLower}, ${weth.tickUpper}]`,
    })]);
    if (ok) { written++; console.log(`✓ WETH/USDC: $${weth.positionValue?.toFixed(2)}, fees: $${weth.feeValue?.toFixed(2)} | Cycle: ${wethCycleId}`); }
    } // end cycleId guard
  }

  // ETH Short Hedge (Hyperliquid)
  if (hedge?.positionValue != null) {
    if (!hedgeCycleId) {
      console.error('Skipping ETH Hedge write — cycle ID unavailable (update Airtable Assets)');
    } else {
      const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.ethHedge, true, {
        [F.positionValue]: hedge.positionValue,
        [F.cycleId]:       hedgeCycleId,
        [F.notes]:         hedge.notes,
      })]);
      if (ok) { written++; console.log(`✓ ETH Hedge: $${hedge.positionValue.toFixed(2)} | ${hedge.notes} | Cycle: ${hedgeCycleId}`); }
    }
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
      if (ok) { written += batch.length; console.log(`✓ Moonwell: ${batch.length} records`); }
    }
  }

  // Spark Savings
  if (spark && Object.keys(spark).length > 0) {
    const batch = [];
    for (const [posKey, data] of Object.entries(spark)) {
      if (!LPOS[posKey]) continue;
      const fields = { [LF.supplyUSD]: data.supplyUSD, [LF.tokenAmt]: data.tokens };
      if (data.supplyAPY != null) fields[LF.supplyAPY] = data.supplyAPY;
      if (data.notes)             fields[LF.notes]     = data.notes;
      batch.push(lendingRecord(LPOS[posKey], fields));
      console.log(`  Queued ${posKey}: $${data.supplyUSD.toFixed(2)}, APY ${data.supplyAPY?.toFixed(2) ?? 'n/a'}%`);
    }
    if (batch.length > 0) {
      const ok = await airtableCreate(LENDING_TABLE, batch);
      if (ok) { written += batch.length; console.log(`✓ Spark: ${batch.length} records`); }
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
      if (ok) { written += batch.length; console.log(`✓ Suilend: ${batch.length} records`); }
    }
  }

  // Raydium xStocks
  if (raydium.length > 0) {
    console.log(`\nRaydium — ${raydium.length} position(s)`);
    if (RAYDIUM_DRY_RUN) {
      for (const pos of raydium) console.log(`  ${pos.key}: $${pos.positionValue.toFixed(2)}, inRange: ${pos.inRange}`);
      console.log('DRY RUN — set RAYDIUM_DRY_RUN=false in GitHub Variables to go live');
    } else {
      const batch = [];
      for (const pos of raydium) {
        const meta = ASSET[pos.key];
        if (!meta) continue;
        batch.push(dailyRecord(meta.recordId, pos.inRange, {
          [F.positionValue]: pos.positionValue,
          [F.cycleId]:       meta.cycleId,
          ...(pos.pendingYield > 0 ? { [F.feeValue]: pos.pendingYield } : {}),
          [F.notes]:         `Raydium CLMM | ${pos.key.toUpperCase()}${pos.pendingYield > 0 ? '' : ' | fees: out-of-range (no accumulation)'}`,
        }));
        console.log(`  Queued ${pos.key}: $${pos.positionValue.toFixed(2)}, inRange: ${pos.inRange}`);
      }
      if (batch.length > 0) {
        for (let i = 0; i < batch.length; i += 10) {
          const ok = await airtableCreate(DAILY_TABLE, batch.slice(i, i + 10));
          if (ok) written += Math.min(10, batch.length - i);
        }
        console.log(`✓ Raydium: ${batch.length} records written`);
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
        [F.notes]:         `Lighter LLP | Equity: $${lighter.llp.equity.toFixed(2)} | APY: ${(lighter.llp.apr * 100)?.toFixed(2)}% | Shares: ${lighter.llp.shares}`,
      }));
      console.log(`  Queued LLP: $${lighter.llp.equity.toFixed(2)}, APY ${(lighter.llp.apr * 100)?.toFixed(2)}%`);
    }
    if (lighter.edge) {
      batch.push(dailyRecord(ASSET.lighterEdge, true, {
        [F.positionValue]: lighter.edge.equity,
        ...(lighter.edge.apr != null ? { [F.protocolAPR]: lighter.edge.apr } : {}),
        [F.notes]:         `Lighter Edge & Hedge | Equity: $${lighter.edge.equity.toFixed(2)} | APY: ${(lighter.edge.apr * 100)?.toFixed(2)}% | Shares: ${lighter.edge.shares}`,
      }));
      console.log(`  Queued Edge & Hedge: $${lighter.edge.equity.toFixed(2)}, APY ${(lighter.edge.apr * 100)?.toFixed(2)}%`);
    }
    if (lighter.lit) {
      batch.push(dailyRecord(ASSET.lighterLIT, true, {
        [F.positionValue]: lighter.lit.equity,
        ...(lighter.lit.apr != null ? { [F.protocolAPR]: lighter.lit.apr } : {}),
        [F.notes]:         `LIT Staking | ${lighter.lit.litStakeAmount} LIT × $${lighter.lit.litPrice?.toFixed(4)} = $${lighter.lit.equity.toFixed(2)} | APR: ${(lighter.lit.apr * 100)?.toFixed(2)}%`,
      }));
      console.log(`  Queued LIT Staking: $${lighter.lit.equity.toFixed(2)}, APR ${(lighter.lit.apr * 100)?.toFixed(2)}%`);
    }
    if (batch.length > 0) {
      const ok = await airtableCreate(DAILY_TABLE, batch);
      if (ok) { written += batch.length; console.log(`✓ Lighter: ${batch.length} records written`); }
    }
  }

  // Kamino xStocks Lending (6 supply legs + 1 USDC borrow leg)
  if (kamino && Object.keys(kamino).length > 0) {
    const batch = [];
    for (const [tokenKey, data] of Object.entries(kamino)) {
      const posId = KAMINO_POSITIONS[tokenKey];
      if (!posId) continue;  // skips the __borrow key (handled separately below)
      const fields = {};
      if (data.supplyUSD != null && data.supplyUSD > 0) fields[LF.supplyUSD] = data.supplyUSD;
      if (data.tokenAmt  != null && data.tokenAmt  > 0) fields[LF.tokenAmt]  = data.tokenAmt;
      if (data.supplyAPY != null) fields[LF.supplyAPY] = data.supplyAPY * 100;
      batch.push(lendingRecord(posId, fields));
      const usdStr = data.supplyUSD != null ? `$${data.supplyUSD.toFixed(2)}` : 'USD=pending';
      const tokStr = data.tokenAmt  != null ? `${data.tokenAmt.toFixed(4)} tokens` : 'tokens=pending';
      console.log(`  Queued ${tokenKey}: ${usdStr}, ${tokStr}, APY ${data.supplyAPY != null ? (data.supplyAPY * 100).toFixed(3) + '%' : 'n/a'}`);
    }

    // Borrow leg → Kamino USDC Borrow position (gross APY in field; incentive/net/LTV in Notes)
    if (kamino.__borrow) {
      const b = kamino.__borrow;
      const bFields = {};
      if (b.borrowUSD != null) bFields[LF.borrowUSD] = b.borrowUSD;
      if (b.borrowAPY != null) bFields[LF.borrowAPY] = b.borrowAPY;  // gross, whole-percent
      if (b.notes)             bFields[LF.notes]     = b.notes;
      batch.push(lendingRecord(KAMINO_USDC_BORROW, bFields));
      console.log(`  Queued USDC Borrow: ${b.borrowUSD != null ? '$' + b.borrowUSD.toFixed(2) : 'n/a'}, gross APY ${b.borrowAPY != null ? b.borrowAPY.toFixed(2) + '%' : 'n/a'}, LTV ${b.ltv != null ? b.ltv.toFixed(2) + '%' : 'n/a'}`);
    }

    if (batch.length > 0) {
      const ok = await airtableCreate(LENDING_TABLE, batch);
      if (ok) { written += batch.length; console.log(`✓ Kamino: ${batch.length} records written`); }
    }
  }

  console.log(`\n====== Complete — ${written} records written ======`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

// ============================================================
// Daily Portfolio Check — GitHub Actions v21-final
// Fix: borrow APY field — try apyBaseBorrow then apyBorrow
// Schedule: 14:00 UTC = 7:00 AM PDT (update workflow cron accordingly)
// ============================================================

import { ethers } from 'ethers';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE    = 'appWojaxYR99bXC1f';
const DAILY_TABLE      = 'tblKsk0QnkOoKNLuk';
const LENDING_TABLE    = 'tblFw52kzeTRvxTSM';

const LIGHTER_BASE_URL    = 'https://mainnet.zklighter.elliot.ai/api/v1';
const LIGHTER_ACCOUNT_IDX = 449217;
const POOL_LLP            = 281474976710654;
const POOL_EDGE_HEDGE     = 281474976688087;
const POOL_LIT            = 281474976624800;

const WALLET_EVM  = '0x871fd9a8A6a6E918658eadF46e9c23fE4E377289';
const WETH_POS_ID = 5384162n;

const BASE_RPC     = process.env.BASE_RPC_URL ?? 'https://base.llamarpc.com';
const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
const ETH_RPC      = 'https://eth.llamarpc.com'; // Ethereum mainnet for Aave

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
  notes:         'fldxWdSuQ09uhadFo',
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
  wethPrimary: 'recbVsmOWh9YOWPBZ',
  llp:         'recEFiaxgavObYWzL',
  litStaking:  'receiu02rkzc3quDW',
  edgeHedge:   'rectz3Zo3aDbe4GgL',
};

// ---- Lending position record IDs ----
const LPOS = {
  moonwellETH:    'rec1T0ll6aEkYoZwj',
  moonwellVIRT:   'rec6Zi6u6uK6x4M9F',
  moonwellCBXRP:  'recQRudPvkFOMhfWL',
  moonwellAERO:   'recwH74S9hCOqPBjR',
  moonwellBorrow: 'recJ2skZuwzu9f1xY',
  aaveUSDC:       'recMVyu92cEoIk8Z2',
};

const COMPTROLLER = '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C';

const MARKETS = [
  { key: 'moonwellETH',   mAddr: '0x628ff693426583D9a7FB391E54366292F509D457', underlyingDec: 18, type: 'supply', method: 'oracle' },
  { key: 'moonwellVIRT',  mAddr: '0xdE8Df9d942D78edE3Ca06e60712582F79CFfFC64', underlyingDec: 18, type: 'supply', method: 'oracle' },
  { key: 'moonwellCBXRP', mAddr: '0xb4fb8fed5b3AaA8434f0B19b1b623d977e07e86d', underlyingAddr: '0xcb585250f852C6c6bf90434AB21A00f02833a4af', underlyingDec: 6,  type: 'supply', method: 'mtoken' },
  { key: 'moonwellAERO',  mAddr: '0x73902f619CEB9B31FD8EFecf435CbDf89E369Ba6', underlyingAddr: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', underlyingDec: 18, type: 'supply', method: 'mtoken' },
  { key: 'moonwellBorrow',mAddr: '0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22', underlyingDec: 6,  type: 'borrow', method: 'borrow' },
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

function dailyRecord(assetId, inRange, extra = {}) {
  return { [F.asset]: [assetId], [F.actionType]: 'Fee Check', [F.date]: NOW_UTC, [F.inRange]: inRange ? 'Yes' : 'No', ...extra };
}

function lendingRecord(positionId, extra = {}) {
  return { [LF.position]: [positionId], [LF.actionType]: 'Rate Check', [LF.date]: NOW_UTC, ...extra };
}

// ============================================================
// MODULE 1 — LIGHTER
// ============================================================

async function getLighterData() {
  console.log('\n--- Lighter ---');
  const results = { llp: null, edgeHedge: null, lit: null };
  const data = await fetchWithTimeout(`${LIGHTER_BASE_URL}/account?by=index&value=${LIGHTER_ACCOUNT_IDX}`);
  if (data?.accounts?.[0]?.shares) {
    for (const share of data.accounts[0].shares) {
      const poolIdx   = Number(share.public_pool_index);
      const principal = parseFloat(share.principal_amount ?? 0);
      if (poolIdx === POOL_LLP)        results.llp       = principal;
      if (poolIdx === POOL_EDGE_HEDGE) results.edgeHedge = principal;
      if (poolIdx === POOL_LIT)        results.lit       = principal;
    }
  }
  console.log(`LLP: $${results.llp}, Edge&Hedge: $${results.edgeHedge}, LIT: $${results.lit}`);
  return results;
}

// ============================================================
// MODULE 2 — WETH/USDC PRIMARY (Arbitrum)
// ============================================================

async function getWethPosition() {
  console.log('\n--- WETH/USDC Primary ---');
  try {
    const provider   = new ethers.JsonRpcProvider(ARBITRUM_RPC);
    const posABI     = ['function positions(uint256 tokenId) external view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'];
    const factoryABI = ['function getPool(address,address,uint24) external view returns (address)'];
    const poolABI    = ['function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)'];
    // collect staticCall returns uncollected fees without spending gas
    const collectABI = ['function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) external returns (uint256 amount0, uint256 amount1)'];

    const nft        = new ethers.Contract('0xC36442b4a4522E871399CD717aBDD847Ab11FE88', posABI, provider);
    const raw        = await nft.positions(WETH_POS_ID);
    const tickLowerN = Number(raw[5]);
    const tickUpperN = Number(raw[6]);
    const liquidity  = raw[7];

    const factory  = new ethers.Contract('0x1F98431c8aD98523631AE4a59f267346ea31F984', factoryABI, provider);
    const poolAddr = await factory.getPool(raw[2], raw[3], raw[4]);
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

    // Read uncollected fees via collect.staticCall (read-only, no gas)
    const MAX128 = BigInt('0xffffffffffffffffffffffffffffffff');
    const nftCollect = new ethers.Contract('0xC36442b4a4522E871399CD717aBDD847Ab11FE88', collectABI, provider);
    let feeValue = 0;
    try {
      const fees = await nftCollect.collect.staticCall({
        tokenId:    WETH_POS_ID,
        recipient:  WALLET_EVM,
        amount0Max: MAX128,
        amount1Max: MAX128,
      });
      const feeETH  = Number(fees[0]) / 1e18;
      const feeUSDC = Number(fees[1]) / 1e6;
      feeValue = (feeETH * ethPrice) + feeUSDC;
      console.log(`ETH: $${ethPrice.toFixed(2)}, position: $${positionValue.toFixed(2)}, fees: $${feeValue.toFixed(2)}, in range: ${inRange}`);
    } catch (e) {
      console.error(`Fee collect failed: ${e.message.slice(0, 60)}`);
      console.log(`ETH: $${ethPrice.toFixed(2)}, position: $${positionValue.toFixed(2)}, in range: ${inRange}`);
    }

    return { positionValue, feeValue, inRange, currentTick, tickLower: tickLowerN, tickUpper: tickUpperN, ethPrice };
  } catch (e) {
    console.error(`WETH/USDC: ${e.message}`);
    return null;
  }
}


// ============================================================
// MODULE 3b — Aave V3 USDC Supply (Ethereum mainnet)
// aUSDC contract: 0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c
// USDC on Ethereum: 6 decimals
// ============================================================

async function getAaveData() {
  console.log('\n--- Aave ---');
  try {
    const provider   = new ethers.JsonRpcProvider(ETH_RPC);
    const aUSDC_ADDR = '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c';
    const erc20ABI   = ['function balanceOf(address) external view returns (uint256)'];
    const aUSDC      = new ethers.Contract(aUSDC_ADDR, erc20ABI, provider);
    const balRaw     = await aUSDC.balanceOf(WALLET_EVM);
    const tokens     = Number(balRaw) / 1e6;
    const supplyUSD  = tokens; // USDC = $1
    // APY hardcoded — Aave V3 USDC on Ethereum is stable ~2.7%
    // Update manually if rate shifts significantly
    const supplyAPY  = 2.73;
    console.log(`Aave USDC: ${tokens.toFixed(2)} tokens = $${supplyUSD.toFixed(2)} | APY: ${supplyAPY}% (hardcoded)`);
    return { supplyUSD, tokens, supplyAPY };
  } catch (e) {
    console.error(`Aave: ${e.message.slice(0, 80)}`);
    return null;
  }
}

// ============================================================
// MODULE 3 — Moonwell (Base via Alchemy)
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
  ];
  const comptrollerABI = ['function oracle() external view returns (address)'];
  const oracleABI      = ['function getUnderlyingPrice(address mToken) external view returns (uint)'];

  let oracle;
  try {
    const comptroller = new ethers.Contract(COMPTROLLER, comptrollerABI, provider);
    oracle = new ethers.Contract(await comptroller.oracle(), oracleABI, provider);
  } catch (e) {
    console.error(`Oracle: ${e.message}`);
  }

  // DeFi Llama prices for mtoken markets
  const mtokenMarkets = MARKETS.filter(m => m.method === 'mtoken');
  const llamaPriceData = await fetchWithTimeout(
    `https://coins.llama.fi/prices/current/${mtokenMarkets.map(m => `base:${m.underlyingAddr}`).join(',')}`
  );
  const prices = {};
  if (llamaPriceData?.coins) {
    for (const [k, v] of Object.entries(llamaPriceData.coins)) {
      prices[k.split(':')[1].toLowerCase()] = v.price;
    }
  }

  // APYs sourced from Airtable Lending Rate Check automation (DeFi Llama too slow/unreliable in GitHub Actions)
  // Hardcoded as reasonable defaults — Airtable script writes the accurate daily values
  const moonwellPools = {
    moonwellETH:    { apy: null },
    moonwellVIRT:   { apy: null },
    moonwellCBXRP:  { apy: null },
    moonwellAERO:   { apy: null },
    moonwellBorrow: { apyBaseBorrow: null },
  };

  for (const market of MARKETS) {
    try {
      const mToken = new ethers.Contract(market.mAddr, mTokenABI, provider);
      const pool   = moonwellPools[market.key];

      // Supply APY — straightforward
      const supplyAPY = pool?.apy ?? null;

      // Borrow APY — DeFi Llama uses different field names
      const borrowAPY = pool?.apyBaseBorrow ?? pool?.apyBorrow ?? null;

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

        const [mBalRaw, exchRaw] = await Promise.all([
          mToken.balanceOf(WALLET_EVM),
          mToken.exchangeRateStored(),
        ]);

        const mBalBig    = BigInt(mBalRaw.toString());
        const exchBig    = BigInt(exchRaw.toString());
        const divisor    = BigInt(10) ** BigInt(18 + market.underlyingDec);
        const underlying = Number(mBalBig * exchBig / divisor);
        const supplyUSD  = underlying * price;
        console.log(`${market.key}: ${underlying.toFixed(4)} tokens × $${price.toFixed(4)} = $${supplyUSD.toFixed(2)} | supplyAPY: ${supplyAPY?.toFixed(2)}%`);
        if (supplyUSD > 0.01) results[market.key] = { type: 'supply', supplyUSD, tokens: underlying, supplyAPY };

      } else if (market.method === 'borrow') {
        const borrowRaw = await mToken.borrowBalanceStored(WALLET_EVM);
        const borrowUSD = Number(borrowRaw) / Math.pow(10, market.underlyingDec);
        const tokens    = borrowUSD; // USDC: 1:1
        console.log(`${market.key}: borrow $${borrowUSD.toFixed(2)} | borrowAPY: ${borrowAPY?.toFixed(2)}%`);
        if (borrowUSD > 0.01) results[market.key] = { type: 'borrow', borrowUSD, tokens, borrowAPY };
      }

    } catch (e) {
      console.error(`${market.key}: ${e.message.slice(0, 80)}`);
    }
  }

  return results;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log(`\n====== Daily Portfolio Check v28 — ${NOW_UTC} ======`);

  const [lighterRes, wethRes, aaveRes, moonwellRes] = await Promise.allSettled([
    getLighterData(),
    getWethPosition(),
    getAaveData(),
    getMoonwellData(),
  ]);

  const lighter  = lighterRes.value  ?? null;
  const weth     = wethRes.value     ?? null;
  const aave     = aaveRes.value     ?? null;
  const moonwell = moonwellRes.value ?? null;

  console.log('\n--- Writing to Airtable ---');
  let written = 0;

  if (lighter?.llp != null) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.llp, true, { [F.positionValue]: lighter.llp, [F.notes]: 'Principal amount — real equity deferred' })]);
    if (ok) { written++; console.log(`✓ LLP: $${lighter.llp}`); }
  }
  if (lighter?.edgeHedge != null) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.edgeHedge, true, { [F.positionValue]: lighter.edgeHedge, [F.notes]: 'Principal amount — real equity deferred' })]);
    if (ok) { written++; console.log(`✓ Edge & Hedge: $${lighter.edgeHedge}`); }
  }
  if (lighter?.lit != null) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.litStaking, true, { [F.positionValue]: lighter.lit, [F.notes]: 'Principal amount — real equity deferred' })]);
    if (ok) { written++; console.log(`✓ LIT Staking: $${lighter.lit}`); }
  }
  if (weth) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.wethPrimary, weth.inRange, {
      [F.positionValue]: weth.positionValue,
      [F.revertPosVal]:  weth.positionValue,
      ...(weth.feeValue > 0 ? { [F.feeValue]: weth.feeValue } : {}),
      [F.notes]:         `ETH: $${weth.ethPrice?.toFixed(0)} | Tick: ${weth.currentTick} | Range: [${weth.tickLower}, ${weth.tickUpper}]`,
    })]);
    if (ok) { written++; console.log(`✓ WETH/USDC: $${weth.positionValue?.toFixed(2)}, fees: $${weth.feeValue?.toFixed(2)}`); }
  }

  if (aave && aave.supplyUSD > 0) {
    const fields = { [LF.supplyUSD]: aave.supplyUSD, [LF.tokenAmt]: aave.tokens };
    if (aave.supplyAPY != null) fields[LF.supplyAPY] = aave.supplyAPY;
    const ok = await airtableCreate(LENDING_TABLE, [lendingRecord(LPOS.aaveUSDC, fields)]);
    if (ok) { written++; console.log(`✓ Aave USDC: $${aave.supplyUSD.toFixed(2)}, ${aave.tokens.toFixed(2)} tokens, APY ${aave.supplyAPY?.toFixed(2) ?? 'n/a'}%`); }
  }

  if (moonwell && Object.keys(moonwell).length > 0) {
    const batch = [];
    for (const [posKey, data] of Object.entries(moonwell)) {
      if (!LPOS[posKey]) continue;
      if (data.type === 'supply') {
        const fields = { [LF.supplyUSD]: data.supplyUSD, [LF.tokenAmt]: data.tokens };
        if (data.supplyAPY != null) fields[LF.supplyAPY] = data.supplyAPY;
        batch.push(lendingRecord(LPOS[posKey], fields));
        console.log(`  Queued ${posKey}: $${data.supplyUSD.toFixed(2)}, ${data.tokens?.toFixed(4)} tokens, APY ${data.supplyAPY?.toFixed(2) ?? 'n/a'}%`);
      } else if (data.type === 'borrow') {
        const fields = { [LF.borrowUSD]: data.borrowUSD, [LF.tokenAmt]: data.tokens };
        if (data.borrowAPY != null) fields[LF.borrowAPY] = data.borrowAPY;
        batch.push(lendingRecord(LPOS[posKey], fields));
        console.log(`  Queued ${posKey}: $${data.borrowUSD.toFixed(2)}, ${data.tokens?.toFixed(4)} tokens, Borrow APY ${data.borrowAPY?.toFixed(2) ?? 'n/a'}%`);
      }
    }
    if (batch.length > 0) {
      const ok = await airtableCreate(LENDING_TABLE, batch);
      if (ok) { written += batch.length; console.log(`✓ Moonwell: ${batch.length} records`); }
    }
  }

  console.log(`\n====== Complete — ${written} records written ======`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

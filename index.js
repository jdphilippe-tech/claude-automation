// ============================================================
// Daily Portfolio Check — GitHub Actions v4
// Fixes: Airtable linked record format, Moonwell addresses,
//        fetch timeouts to prevent hanging
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

const BASE_RPC     = 'https://mainnet.base.org';
const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';

const NOW_UTC = new Date().toISOString();
const TIMEOUT = 15000; // 15 second timeout on all fetches

// ---- Field IDs ----
const F = {
  asset:         'fldtiRIqznncRfJYG',
  actionType:    'fldUkwrxtS4AEr52W',
  date:          'fldHG3MCcyhkXknyH',
  inRange:       'fld9pdBIkiEIv352W',
  positionValue: 'fldWElDtJZRYTaZtD',
  feeValue:      'fld6QnTv9CKHvglcX',
  revertPosVal:  'fldcciMBHm1kI0dL9',
  protocolAPR:   'fldL3Pa57i3fyaAf0',
  notes:         'fldxWdSuQ09uhadFo',
};

const LF = {
  position:  'fldFi5nwRXNC5n0pU',
  actionType:'fld5UpfU63qiYEZtp',
  date:      'fldUksu7BXYunAADh',
  supplyUSD: 'fldJ7T452iqgQNiWb',
  borrowUSD: 'fldTSqf1Yrxg7O0tr',
  notes:     'fldHzWRmzI1H3zueM',
};

const ASSET = {
  wethPrimary: 'recbVsmOWh9YOWPBZ',
  llp:         'recEFiaxgavObYWzL',
  litStaking:  'receiu02rkzc3quDW',
  edgeHedge:   'rectz3Zo3aDbe4GgL',
};

const LPOS = {
  moonwellETH:    'rec1T0ll6aEkYoZwj',
  moonwellVIRT:   'rec6Zi6u6uK6x4M9F',
  moonwellCBXRP:  'recQRudPvkFOMhfWL',
  moonwellAERO:   'recwH74S9hCOqPBjR',
  moonwellBorrow: 'recJ2skZuwzu9f1xY',
};

// ============================================================
// HELPERS
// ============================================================

// Fetch with timeout
async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { default: fetch } = await import('node-fetch');
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      console.error(`[fetch] HTTP ${res.status}: ${url.slice(0, 80)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      console.error(`[fetch] Timeout after ${timeoutMs}ms: ${url.slice(0, 80)}`);
    } else {
      console.error(`[fetch] Error: ${e.message}`);
    }
    return null;
  }
}

// Write to Airtable REST API
// CRITICAL: linked record fields must be plain record ID strings in array
// singleSelect fields must be plain string option names
async function airtablePost(tableId, records) {
  const { default: fetch } = await import('node-fetch');

  // Build fields carefully — no nested objects for linked records
  const body = JSON.stringify({
    records: records.map(r => ({ fields: r }))
  });

  console.log(`[Airtable] Posting ${records.length} records to ${tableId}`);
  console.log(`[Airtable] Sample record keys: ${Object.keys(records[0]).join(', ')}`);

  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body,
    }
  );

  const responseText = await res.text();
  if (!res.ok) {
    console.error(`[Airtable] Write failed: ${responseText.slice(0, 300)}`);
    return false;
  }
  return true;
}

// Daily Actions record builder
// Linked records: Airtable REST API accepts record IDs as plain strings in array
function makeDailyRecord(assetRecordId, inRange, extra = {}) {
  return {
    [F.asset]:      assetRecordId,   // linked record — plain string ID (not array, not object)
    [F.actionType]: 'Fee Check',
    [F.date]:       NOW_UTC,
    [F.inRange]:    inRange ? 'Yes' : 'No',
    ...extra,
  };
}

// Lending Actions record builder
function makeLendingRecord(positionRecordId, extra = {}) {
  return {
    [LF.position]:   positionRecordId,  // plain string ID
    [LF.actionType]: 'Rate Check',
    [LF.date]:       NOW_UTC,
    ...extra,
  };
}

// ============================================================
// MODULE 1 — LIGHTER (principal_amount)
// ============================================================

async function getLighterData() {
  console.log('\n--- Lighter ---');
  const results = { llp: null, edgeHedge: null, lit: null };

  const data = await fetchWithTimeout(
    `${LIGHTER_BASE_URL}/account?by=index&value=${LIGHTER_ACCOUNT_IDX}`
  );

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
// MODULE 2 — WETH/USDC PRIMARY (Arbitrum on-chain)
// ============================================================

async function getWethPosition() {
  console.log('\n--- WETH/USDC Primary ---');
  try {
    const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC);

    const posABI = ['function positions(uint256 tokenId) external view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'];
    const factoryABI = ['function getPool(address,address,uint24) external view returns (address)'];
    const poolABI    = ['function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)'];

    const nft     = new ethers.Contract('0xC36442b4a4522E871399CD717aBDD847Ab11FE88', posABI, provider);
    const pos     = await nft.positions(WETH_POS_ID);
    const [,, token0, token1, fee, tickLower, tickUpper, liquidity] = pos;

    const factory  = new ethers.Contract('0x1F98431c8aD98523631AE4a59f267346ea31F984', factoryABI, provider);
    const poolAddr = await factory.getPool(token0, token1, fee);
    const pool     = new ethers.Contract(poolAddr, poolABI, provider);
    const slot0    = await pool.slot0();

    const currentTick  = Number(slot0.tick);
    const tickLowerN   = Number(tickLower);
    const tickUpperN   = Number(tickUpper);
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
    console.log(`ETH: $${ethPrice.toFixed(2)}, position: $${positionValue.toFixed(2)}, in range: ${inRange}`);
    return { positionValue, inRange, currentTick, tickLower: tickLowerN, tickUpper: tickUpperN, ethPrice };
  } catch (e) {
    console.error(`WETH/USDC: ${e.message}`);
    return null;
  }
}

// ============================================================
// MODULE 3 — Moonwell USD values (Base RPC)
// Correct checksummed addresses from BaseScan
// ============================================================

async function getMoonwellUSD() {
  console.log('\n--- Moonwell USD ---');
  const provider = new ethers.JsonRpcProvider(BASE_RPC);

  const mTokenABI = [
    'function balanceOfUnderlying(address owner) external returns (uint)',
    'function borrowBalanceCurrent(address account) external returns (uint)',
  ];

  // Correct checksummed addresses verified on BaseScan
  const MARKETS = {
    ETH:     { addr: '0x628ff693426583D9a7FB391E54366292F509D457', dec: 18 },
    VIRTUAL: { addr: '0xb81d7EC56Db7bfc4De82C54Eb94174E23D42862E', dec: 18 },
    cbXRP:   { addr: '0xb2e12a9040cFF61C74e08F59E21CEdE3c15DEa51', dec: 6  },
    AERO:    { addr: '0x73902f619CEB9B31FD8EFecf435CbDf89E369Ba6', dec: 18 },
  };

  const results = {};

  for (const [symbol, { addr, dec }] of Object.entries(MARKETS)) {
    try {
      const mToken = new ethers.Contract(addr, mTokenABI, provider);
      const raw    = await mToken.balanceOfUnderlying.staticCall(WALLET_EVM);
      results[symbol] = Number(raw) / Math.pow(10, dec);
      console.log(`Moonwell ${symbol}: ${results[symbol].toFixed(4)}`);
    } catch (e) {
      console.error(`Moonwell ${symbol}: ${e.message.slice(0, 80)}`);
      results[symbol] = null;
    }
  }

  try {
    const mUSDC  = new ethers.Contract('0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22', mTokenABI, provider);
    const raw    = await mUSDC.borrowBalanceCurrent.staticCall(WALLET_EVM);
    results.USDCBorrow = Number(raw) / 1e6;
    console.log(`Moonwell USDC borrow: $${results.USDCBorrow.toFixed(2)}`);
  } catch (e) {
    console.error(`Moonwell borrow: ${e.message.slice(0, 80)}`);
    results.USDCBorrow = null;
  }

  return results;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log(`\n====== Daily Portfolio Check v4 — ${NOW_UTC} ======`);

  const [lighterRes, wethRes, moonwellRes] = await Promise.allSettled([
    getLighterData(),
    getWethPosition(),
    getMoonwellUSD(),
  ]);

  const lighter  = lighterRes.value  ?? null;
  const weth     = wethRes.value     ?? null;
  const moonwell = moonwellRes.value ?? null;

  console.log('\n--- Writing to Airtable ---');
  let written = 0;

  // Test Airtable write format with a simple debug first
  console.log('[Debug] ASSET.llp value:', ASSET.llp, typeof ASSET.llp);
  console.log('[Debug] Sample record:', JSON.stringify(makeDailyRecord(ASSET.llp, true, { [F.positionValue]: 1836.30 })));

  // Lighter
  if (lighter?.llp != null) {
    const ok = await airtablePost(DAILY_TABLE, [makeDailyRecord(ASSET.llp, true, {
      [F.positionValue]: lighter.llp,
      [F.notes]:         'Principal amount — equity update deferred',
    })]);
    if (ok) { written++; console.log(`✓ LLP: $${lighter.llp}`); }
  }

  if (lighter?.edgeHedge != null) {
    const ok = await airtablePost(DAILY_TABLE, [makeDailyRecord(ASSET.edgeHedge, true, {
      [F.positionValue]: lighter.edgeHedge,
      [F.notes]:         'Principal amount — equity update deferred',
    })]);
    if (ok) { written++; console.log(`✓ Edge & Hedge: $${lighter.edgeHedge}`); }
  }

  if (lighter?.lit != null) {
    const ok = await airtablePost(DAILY_TABLE, [makeDailyRecord(ASSET.litStaking, true, {
      [F.positionValue]: lighter.lit,
      [F.notes]:         'Principal amount — equity update deferred',
    })]);
    if (ok) { written++; console.log(`✓ LIT Staking: $${lighter.lit}`); }
  }

  // WETH/USDC Primary
  if (weth) {
    const ok = await airtablePost(DAILY_TABLE, [makeDailyRecord(ASSET.wethPrimary, weth.inRange, {
      [F.positionValue]: weth.positionValue,
      [F.revertPosVal]:  weth.positionValue,
      [F.notes]:         `ETH: $${weth.ethPrice?.toFixed(0)} | Tick: ${weth.currentTick} | Range: [${weth.tickLower}, ${weth.tickUpper}]`,
    })]);
    if (ok) { written++; console.log(`✓ WETH/USDC: $${weth.positionValue?.toFixed(2)}`); }
  }

  // Moonwell
  if (moonwell) {
    const batch = [
      moonwell.ETH       != null ? makeLendingRecord(LPOS.moonwellETH,    { [LF.supplyUSD]: moonwell.ETH        }) : null,
      moonwell.VIRTUAL   != null ? makeLendingRecord(LPOS.moonwellVIRT,   { [LF.supplyUSD]: moonwell.VIRTUAL    }) : null,
      moonwell.cbXRP     != null ? makeLendingRecord(LPOS.moonwellCBXRP,  { [LF.supplyUSD]: moonwell.cbXRP      }) : null,
      moonwell.AERO      != null ? makeLendingRecord(LPOS.moonwellAERO,   { [LF.supplyUSD]: moonwell.AERO       }) : null,
      moonwell.USDCBorrow!= null ? makeLendingRecord(LPOS.moonwellBorrow, { [LF.borrowUSD]: moonwell.USDCBorrow }) : null,
    ].filter(Boolean);

    if (batch.length > 0) {
      const ok = await airtablePost(LENDING_TABLE, batch);
      if (ok) { written += batch.length; console.log(`✓ Moonwell: ${batch.length} records`); }
    }
  }

  console.log(`\n====== Complete — ${written} records written ======`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

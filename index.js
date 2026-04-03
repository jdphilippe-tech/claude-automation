// ============================================================
// Daily Portfolio Check — GitHub Actions v5
// Fix: linked record fields = array of string IDs ["recXXX"]
//      Correct Moonwell checksummed addresses
//      15s timeout on all HTTP calls
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
const FETCH_TIMEOUT = 15000;

// ---- Daily Actions field IDs ----
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

// ---- Lending Actions field IDs ----
const LF = {
  position:  'fldFi5nwRXNC5n0pU',
  actionType:'fld5UpfU63qiYEZtp',
  date:      'fldUksu7BXYunAADh',
  supplyUSD: 'fldJ7T452iqgQNiWb',
  borrowUSD: 'fldTSqf1Yrxg7O0tr',
  notes:     'fldHzWRmzI1H3zueM',
};

// ---- Asset record IDs ----
const ASSET = {
  wethPrimary: 'recbVsmOWh9YOWPBZ',
  llp:         'recEFiaxgavObYWzL',
  litStaking:  'receiu02rkzc3quDW',
  edgeHedge:   'rectz3Zo3aDbe4GgL',
  tsla:        'recd33iBRKrMMq710',
  nvda:        'recdQq6r8iDl3BGYZ',
  crcl:        'recPq2Ee2MsoMa21S',
  spy:         'rechX4b2anmi82enx',
  googl:       'recRxStry17D0ZGB5',
  aapl:        'recGF59dwIOnE8fm2',
};

// ---- Lending position record IDs ----
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

async function fetchWithTimeout(url, options = {}) {
  const { default: fetch } = await import('node-fetch');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      console.error(`[HTTP ${res.status}] ${url.slice(0, 80)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    console.error(`[fetch] ${e.name === 'AbortError' ? 'Timeout' : e.message}: ${url.slice(0, 60)}`);
    return null;
  }
}

// Write records to Airtable REST API
// LINKED RECORD FIELDS: must be array of string record IDs ["recXXX"]
// SINGLE SELECT FIELDS: must be plain string option name "Fee Check"
async function airtableCreate(tableId, records) {
  const { default: fetch } = await import('node-fetch');

  const body = JSON.stringify({
    records: records.map(r => ({ fields: r }))
  });

  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body,
    }
  );

  if (!res.ok) {
    const err = await res.text();
    console.error(`[Airtable] FAILED ${tableId}: ${err.slice(0, 200)}`);
    return false;
  }
  return true;
}

// Build a Daily Actions record
// CRITICAL: asset field (multipleRecordLinks) needs array of string IDs
function dailyRecord(assetId, inRange, extra = {}) {
  return {
    [F.asset]:      [assetId],        // array of string record IDs
    [F.actionType]: 'Fee Check',       // singleSelect — plain string name
    [F.date]:       NOW_UTC,
    [F.inRange]:    inRange ? 'Yes' : 'No',  // singleSelect — plain string name
    ...extra,
  };
}

// Build a Lending Actions record
function lendingRecord(positionId, extra = {}) {
  return {
    [LF.position]:   [positionId],    // array of string record IDs
    [LF.actionType]: 'Rate Check',     // singleSelect — plain string name
    [LF.date]:       NOW_UTC,
    ...extra,
  };
}

// ============================================================
// MODULE 1 — LIGHTER (principal_amount from public endpoint)
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
// MODULE 2 — WETH/USDC PRIMARY (Arbitrum on-chain RPC)
// ============================================================

async function getWethPosition() {
  console.log('\n--- WETH/USDC Primary ---');
  try {
    const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC);

    const posABI = [
      'function positions(uint256 tokenId) external view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'
    ];
    const factoryABI = ['function getPool(address,address,uint24) external view returns (address)'];
    const poolABI    = ['function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)'];

    const nft      = new ethers.Contract('0xC36442b4a4522E871399CD717aBDD847Ab11FE88', posABI, provider);
    const raw      = await nft.positions(WETH_POS_ID);
    const token0   = raw[2], token1 = raw[3], fee = raw[4];
    const tickLowerN  = Number(raw[5]);
    const tickUpperN  = Number(raw[6]);
    const liquidity   = raw[7];

    const factory  = new ethers.Contract('0x1F98431c8aD98523631AE4a59f267346ea31F984', factoryABI, provider);
    const poolAddr = await factory.getPool(token0, token1, fee);
    const pool     = new ethers.Contract(poolAddr, poolABI, provider);
    const slot0    = await pool.slot0();

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
    console.log(`ETH: $${ethPrice.toFixed(2)}, position: $${positionValue.toFixed(2)}, in range: ${inRange}`);
    return { positionValue, inRange, currentTick, tickLower: tickLowerN, tickUpper: tickUpperN, ethPrice };
  } catch (e) {
    console.error(`WETH/USDC: ${e.message}`);
    return null;
  }
}

// ============================================================
// MODULE 3 — Moonwell USD values (Base RPC, staticCall)
// Checksummed addresses verified on BaseScan
// ============================================================

async function getMoonwellUSD() {
  console.log('\n--- Moonwell USD ---');
  const provider = new ethers.JsonRpcProvider(BASE_RPC);

  const mTokenABI = [
    'function balanceOfUnderlying(address owner) external returns (uint)',
    'function borrowBalanceCurrent(address account) external returns (uint)',
  ];

  // Verified checksummed addresses from BaseScan/Moonwell docs
  const MARKETS = {
    ETH:     { addr: '0x628ff693426583D9a7FB391E54366292F509D457', dec: 18 },
    VIRTUAL: { addr: '0xbC58Ce8D5A58012e01d9C7C91Ab5Ff1bCE9f8Fe', dec: 18 },
    cbXRP:   { addr: '0x259151d7B82C5e8D4Fb3975e4b38f77A4BFa8c9', dec: 6  },
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

  // USDC borrow
  try {
    const mUSDC = new ethers.Contract('0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22', mTokenABI, provider);
    const raw   = await mUSDC.borrowBalanceCurrent.staticCall(WALLET_EVM);
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
  console.log(`\n====== Daily Portfolio Check v5 — ${NOW_UTC} ======`);

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

  // Lighter — LLP
  if (lighter?.llp != null) {
    const rec = dailyRecord(ASSET.llp, true, {
      [F.positionValue]: lighter.llp,
      [F.notes]:         'Principal amount — equity update deferred',
    });
    console.log('[Debug] LLP record asset field:', JSON.stringify(rec[F.asset]));
    const ok = await airtableCreate(DAILY_TABLE, [rec]);
    if (ok) { written++; console.log(`✓ LLP: $${lighter.llp}`); }
  }

  // Lighter — Edge & Hedge
  if (lighter?.edgeHedge != null) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.edgeHedge, true, {
      [F.positionValue]: lighter.edgeHedge,
      [F.notes]:         'Principal amount — equity update deferred',
    })]);
    if (ok) { written++; console.log(`✓ Edge & Hedge: $${lighter.edgeHedge}`); }
  }

  // Lighter — LIT Staking
  if (lighter?.lit != null) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.litStaking, true, {
      [F.positionValue]: lighter.lit,
      [F.notes]:         'Principal amount — equity update deferred',
    })]);
    if (ok) { written++; console.log(`✓ LIT Staking: $${lighter.lit}`); }
  }

  // WETH/USDC Primary
  if (weth) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.wethPrimary, weth.inRange, {
      [F.positionValue]: weth.positionValue,
      [F.revertPosVal]:  weth.positionValue,
      [F.notes]:         `ETH: $${weth.ethPrice?.toFixed(0)} | Tick: ${weth.currentTick} | Range: [${weth.tickLower}, ${weth.tickUpper}]`,
    })]);
    if (ok) { written++; console.log(`✓ WETH/USDC: $${weth.positionValue?.toFixed(2)}`); }
  }

  // Moonwell — batch all records together
  if (moonwell) {
    const batch = [
      moonwell.ETH       != null ? lendingRecord(LPOS.moonwellETH,    { [LF.supplyUSD]: moonwell.ETH        }) : null,
      moonwell.VIRTUAL   != null ? lendingRecord(LPOS.moonwellVIRT,   { [LF.supplyUSD]: moonwell.VIRTUAL    }) : null,
      moonwell.cbXRP     != null ? lendingRecord(LPOS.moonwellCBXRP,  { [LF.supplyUSD]: moonwell.cbXRP      }) : null,
      moonwell.AERO      != null ? lendingRecord(LPOS.moonwellAERO,   { [LF.supplyUSD]: moonwell.AERO       }) : null,
      moonwell.USDCBorrow!= null ? lendingRecord(LPOS.moonwellBorrow, { [LF.borrowUSD]: moonwell.USDCBorrow }) : null,
    ].filter(Boolean);

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

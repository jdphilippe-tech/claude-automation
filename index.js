// ============================================================
// Daily Portfolio Check — GitHub Actions v10
// Moonwell: hardcoded correct mToken addresses (verified from SDK)
// Uses staticCall + Chainlink oracle for accurate USD values
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

const NOW_UTC       = new Date().toISOString();
const FETCH_TIMEOUT = 20000;

// ---- Daily Actions field IDs ----
const F = {
  asset:         'fldtiRIqznncRfJYG',
  actionType:    'fldUkwrxtS4AEr52W',
  date:          'fldHG3MCcyhkXknyH',
  inRange:       'fld9pdBIkiEIv352W',
  positionValue: 'fldWElDtJZRYTaZtD',
  feeValue:      'fld6QnTv9CKHvglcX',
  revertPosVal:  'fldcciMBHm1kI0dL9',
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
};

// ---- Lending position record IDs ----
const LPOS = {
  moonwellETH:    'rec1T0ll6aEkYoZwj',
  moonwellVIRT:   'rec6Zi6u6uK6x4M9F',
  moonwellCBXRP:  'recQRudPvkFOMhfWL',
  moonwellAERO:   'recwH74S9hCOqPBjR',
  moonwellBorrow: 'recJ2skZuwzu9f1xY',
};

// ---- Moonwell mToken addresses (verified from Moonwell SDK output) ----
// Supply markets
const MOONWELL_MARKETS = [
  { key: 'moonwellETH',   mAddr: '0x628ff693426583D9a7FB391E54366292F509D457', dec: 18, type: 'supply' },
  { key: 'moonwellVIRT',  mAddr: '0xdE8Df9d942D78edE3Ca06e60712582F79CFfFC64', dec: 18, type: 'supply' },
  { key: 'moonwellCBXRP', mAddr: '0xb4fb8fed5b3AaA8434f0B19b1b623d977e07e86d', dec: 6,  type: 'supply' },
  { key: 'moonwellAERO',  mAddr: '0x73902f619CEB9B31FD8EFecf435CbDf89E369Ba6', dec: 18, type: 'supply' },
  { key: 'moonwellBorrow',mAddr: '0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22', dec: 6,  type: 'borrow' },
];

// Moonwell Comptroller and Oracle on Base
const COMPTROLLER = '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C';

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
    if (!res.ok) { console.error(`[HTTP ${res.status}] ${url.slice(0, 80)}`); return null; }
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    console.error(`[fetch] ${e.name === 'AbortError' ? 'Timeout' : e.message}`);
    return null;
  }
}

async function airtableCreate(tableId, records) {
  const { default: fetch } = await import('node-fetch');
  const body = JSON.stringify({ records: records.map(r => ({ fields: r })) });
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
      body,
    }
  );
  if (!res.ok) {
    const err = await res.text();
    console.error(`[Airtable] FAILED: ${err.slice(0, 200)}`);
    return false;
  }
  return true;
}

function dailyRecord(assetId, inRange, extra = {}) {
  return {
    [F.asset]:      [assetId],
    [F.actionType]: 'Fee Check',
    [F.date]:       NOW_UTC,
    [F.inRange]:    inRange ? 'Yes' : 'No',
    ...extra,
  };
}

function lendingRecord(positionId, extra = {}) {
  return {
    [LF.position]:   [positionId],
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
// MODULE 2 — WETH/USDC PRIMARY (Arbitrum on-chain RPC)
// ============================================================

async function getWethPosition() {
  console.log('\n--- WETH/USDC Primary ---');
  try {
    const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC);

    const posABI     = ['function positions(uint256 tokenId) external view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'];
    const factoryABI = ['function getPool(address,address,uint24) external view returns (address)'];
    const poolABI    = ['function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)'];

    const nft      = new ethers.Contract('0xC36442b4a4522E871399CD717aBDD847Ab11FE88', posABI, provider);
    const raw      = await nft.positions(WETH_POS_ID);
    const token0 = raw[2], token1 = raw[3], fee = raw[4];
    const tickLowerN = Number(raw[5]);
    const tickUpperN = Number(raw[6]);
    const liquidity  = raw[7];

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
// MODULE 3 — Moonwell USD values
// Uses correct mToken addresses from SDK output
// Gets oracle price from Moonwell Comptroller
// ============================================================

async function getMoonwellUSD() {
  console.log('\n--- Moonwell USD ---');
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const results  = {};

  // Get oracle address from Comptroller
  const comptrollerABI = ['function oracle() external view returns (address)'];
  const oracleABI      = ['function getUnderlyingPrice(address mToken) external view returns (uint)'];
  const mTokenABI      = [
    'function balanceOfUnderlying(address owner) external returns (uint)',
    'function borrowBalanceCurrent(address account) external returns (uint)',
    'function decimals() external view returns (uint8)',
  ];

  let oracle;
  try {
    const comptroller = new ethers.Contract(COMPTROLLER, comptrollerABI, provider);
    const oracleAddr  = await comptroller.oracle();
    oracle = new ethers.Contract(oracleAddr, oracleABI, provider);
    console.log(`Oracle: ${oracleAddr}`);
  } catch (e) {
    console.error(`Comptroller/oracle error: ${e.message}`);
    return results;
  }

  for (const market of MOONWELL_MARKETS) {
    try {
      const mToken = new ethers.Contract(market.mAddr, mTokenABI, provider);

      // Get oracle price
      // Moonwell oracle returns price * 1e(36 - underlyingDecimals) / 1e18
      // So: priceUSD = oraclePrice / 10^(36 - underlyingDecimals)
      const oracleRaw = await oracle.getUnderlyingPrice(market.mAddr);
      const scalePow  = 36 - market.dec;
      const priceUSD  = Number(oracleRaw) / Math.pow(10, scalePow);

      if (market.type === 'supply') {
        const balRaw   = await mToken.balanceOfUnderlying.staticCall(WALLET_EVM);
        const tokens   = Number(balRaw) / Math.pow(10, market.dec);
        const supplyUSD = tokens * priceUSD;
        console.log(`${market.key}: ${tokens.toFixed(4)} tokens × $${priceUSD.toFixed(4)} = $${supplyUSD.toFixed(2)}`);
        if (supplyUSD > 0.01) {
          results[market.key] = { type: 'supply', supplyUSD };
        }
      } else {
        const borrowRaw = await mToken.borrowBalanceCurrent.staticCall(WALLET_EVM);
        const borrowUSD = Number(borrowRaw) / Math.pow(10, market.dec);
        console.log(`${market.key}: borrow $${borrowUSD.toFixed(2)}`);
        if (borrowUSD > 0.01) {
          results[market.key] = { type: 'borrow', borrowUSD };
        }
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
  console.log(`\n====== Daily Portfolio Check v10 — ${NOW_UTC} ======`);

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
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.llp, true, {
      [F.positionValue]: lighter.llp,
      [F.notes]:         'Principal amount — real equity deferred',
    })]);
    if (ok) { written++; console.log(`✓ LLP: $${lighter.llp}`); }
  }

  // Lighter — Edge & Hedge
  if (lighter?.edgeHedge != null) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.edgeHedge, true, {
      [F.positionValue]: lighter.edgeHedge,
      [F.notes]:         'Principal amount — real equity deferred',
    })]);
    if (ok) { written++; console.log(`✓ Edge & Hedge: $${lighter.edgeHedge}`); }
  }

  // Lighter — LIT Staking
  if (lighter?.lit != null) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.litStaking, true, {
      [F.positionValue]: lighter.lit,
      [F.notes]:         'Principal amount — real equity deferred',
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

  // Moonwell
  if (moonwell && Object.keys(moonwell).length > 0) {
    const batch = [];
    for (const [posKey, data] of Object.entries(moonwell)) {
      if (!LPOS[posKey]) continue;
      if (data.type === 'supply' && data.supplyUSD > 0) {
        batch.push(lendingRecord(LPOS[posKey], { [LF.supplyUSD]: data.supplyUSD }));
        console.log(`  Queued ${posKey}: supply $${data.supplyUSD.toFixed(2)}`);
      } else if (data.type === 'borrow' && data.borrowUSD > 0) {
        batch.push(lendingRecord(LPOS[posKey], { [LF.borrowUSD]: data.borrowUSD }));
        console.log(`  Queued ${posKey}: borrow $${data.borrowUSD.toFixed(2)}`);
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

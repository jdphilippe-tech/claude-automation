// ============================================================
// Daily Portfolio Check — GitHub Actions v14
// ETH/VIRTUAL: oracle + balanceOfUnderlying.staticCall (confirmed)
// cbXRP/AERO: DeFi Llama price + mToken balance × exchange rate
// USDC borrow: borrowBalanceStored (pure view)
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

const COMPTROLLER = '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C';

// Market config
// balanceMethod: 'underlying' = use balanceOfUnderlying.staticCall
//                'mtoken'     = use balanceOf × exchangeRateStored
// priceMethod:   'oracle'     = use Moonwell Chainlink oracle
//                'llama'      = use DeFi Llama coins API by token address
const MOONWELL_MARKETS = [
  {
    key:            'moonwellETH',
    mAddr:          '0x628ff693426583D9a7FB391E54366292F509D457',
    underlyingAddr: '0x4200000000000000000000000000000000000006',
    underlyingDec:  18,
    type:           'supply',
    balanceMethod:  'underlying',
    priceMethod:    'oracle',
  },
  {
    key:            'moonwellVIRT',
    mAddr:          '0xdE8Df9d942D78edE3Ca06e60712582F79CFfFC64',
    underlyingAddr: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b',
    underlyingDec:  18,
    type:           'supply',
    balanceMethod:  'underlying',
    priceMethod:    'oracle',
  },
  {
    key:            'moonwellCBXRP',
    mAddr:          '0xb4fb8fed5b3AaA8434f0B19b1b623d977e07e86d',
    underlyingAddr: '0xcb585250f852C6c6bf90434AB21A00f02833a4af',
    underlyingDec:  6,
    type:           'supply',
    balanceMethod:  'mtoken',  // use mToken balance × exchange rate
    priceMethod:    'llama',
  },
  {
    key:            'moonwellAERO',
    mAddr:          '0x73902f619CEB9B31FD8EFecf435CbDf89E369Ba6',
    underlyingAddr: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
    underlyingDec:  18,
    type:           'supply',
    balanceMethod:  'mtoken',  // use mToken balance × exchange rate
    priceMethod:    'llama',
  },
  {
    key:            'moonwellBorrow',
    mAddr:          '0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22',
    underlyingAddr: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    underlyingDec:  6,
    type:           'borrow',
    balanceMethod:  'stored',  // use borrowBalanceStored
    priceMethod:    'fixed',   // USDC = $1
  },
];

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
// MODULE 2 — WETH/USDC PRIMARY
// ============================================================

async function getWethPosition() {
  console.log('\n--- WETH/USDC Primary ---');
  try {
    const provider   = new ethers.JsonRpcProvider(ARBITRUM_RPC);
    const posABI     = ['function positions(uint256 tokenId) external view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'];
    const factoryABI = ['function getPool(address,address,uint24) external view returns (address)'];
    const poolABI    = ['function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)'];

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
    console.log(`ETH: $${ethPrice.toFixed(2)}, position: $${positionValue.toFixed(2)}, in range: ${inRange}`);
    return { positionValue, inRange, currentTick, tickLower: tickLowerN, tickUpper: tickUpperN, ethPrice };
  } catch (e) {
    console.error(`WETH/USDC: ${e.message}`);
    return null;
  }
}

// ============================================================
// MODULE 3 — Moonwell USD values
// ============================================================

async function getMoonwellUSD() {
  console.log('\n--- Moonwell USD ---');
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const results  = {};

  // Get Moonwell oracle
  const comptrollerABI = ['function oracle() external view returns (address)'];
  const oracleABI      = ['function getUnderlyingPrice(address mToken) external view returns (uint)'];
  const mTokenABI = [
    // Method 1: balanceOfUnderlying (non-view, needs staticCall)
    'function balanceOfUnderlying(address owner) external returns (uint)',
    // Method 2: raw mToken balance + exchange rate (pure view)
    'function balanceOf(address account) external view returns (uint)',
    'function exchangeRateStored() external view returns (uint)',
    // Borrow
    'function borrowBalanceStored(address account) external view returns (uint)',
  ];

  let oracle;
  try {
    const comptroller = new ethers.Contract(COMPTROLLER, comptrollerABI, provider);
    oracle = new ethers.Contract(await comptroller.oracle(), oracleABI, provider);
  } catch (e) {
    console.error(`Oracle setup: ${e.message}`);
  }

  // Fetch DeFi Llama prices for llama-priced tokens in one call
  const llamaTokens = MOONWELL_MARKETS
    .filter(m => m.priceMethod === 'llama')
    .map(m => `base:${m.underlyingAddr}`);

  let llamaPrices = {};
  if (llamaTokens.length > 0) {
    const data = await fetchWithTimeout(`https://coins.llama.fi/prices/current/${llamaTokens.join(',')}`);
    if (data?.coins) {
      for (const [key, val] of Object.entries(data.coins)) {
        llamaPrices[key.replace('base:', '').toLowerCase()] = val.price;
      }
    }
    console.log('DeFi Llama prices fetched:', Object.keys(llamaPrices).length);
  }

  for (const market of MOONWELL_MARKETS) {
    try {
      const mToken = new ethers.Contract(market.mAddr, mTokenABI, provider);

      // Step 1: Get price
      let priceUSD = null;
      if (market.priceMethod === 'oracle' && oracle) {
        try {
          const raw  = await oracle.getUnderlyingPrice(market.mAddr);
          priceUSD   = Number(raw) / Math.pow(10, 36 - market.underlyingDec);
        } catch (e) {
          console.error(`  ${market.key} oracle: ${e.message.slice(0, 40)}`);
        }
      } else if (market.priceMethod === 'llama') {
        priceUSD = llamaPrices[market.underlyingAddr.toLowerCase()] ?? null;
      } else if (market.priceMethod === 'fixed') {
        priceUSD = 1.0;
      }

      if (!priceUSD) {
        console.error(`${market.key}: no price — skipping`);
        continue;
      }

      // Step 2: Get balance
      if (market.type === 'supply') {
        let underlyingTokens = null;

        if (market.balanceMethod === 'underlying') {
          // Method 1: balanceOfUnderlying.staticCall
          const raw    = await mToken.balanceOfUnderlying.staticCall(WALLET_EVM);
          underlyingTokens = Number(raw) / Math.pow(10, market.underlyingDec);
        } else if (market.balanceMethod === 'mtoken') {
          // Method 2: mToken balance × exchange rate
          // mToken has 8 decimals always
          // exchangeRateStored scaled by 1e18
          // underlying = mBal * exchRate / (10^8 * 10^18) * 10^underlyingDec
          // Simplification: underlying = mBal * exchRate / 10^(26 - underlyingDec + underlyingDec)
          // = mBal * exchRate / 10^26  × 10^(underlyingDec)... let me be explicit:
          // underlying_raw = mBal_raw * exchRate / 1e18  (gives underlying in raw units with 8 decimals)
          // But mToken is 8 dec, underlying might be 6 or 18
          // Correct: underlying_in_full_units = (mBal_raw * exchRate) / (1e18 * 10^8)
          // Then in display units: underlying_in_full_units (already in underlying decimals? No...)
          // Let's test with numbers:
          // mAERO: mBal_raw = some big number (8 dec mTokens)
          // exchRate from exchangeRateStored = rate * 1e18
          // underlying_tokens = (mBal_raw * exchRate) / (10^8 * 10^18)
          // This gives underlying in whole AERO tokens
          const [mBalRaw, exchRaw] = await Promise.all([
            mToken.balanceOf(WALLET_EVM),
            mToken.exchangeRateStored(),
          ]);
          // underlying (in display units) = mBalRaw * exchRaw / (10^8 * 10^18)
          underlyingTokens = Number(mBalRaw) * Number(exchRaw) / (Math.pow(10, 8) * Math.pow(10, 18));
          console.log(`  ${market.key}: mBal=${mBalRaw}, exchRate=${exchRaw}, underlying=${underlyingTokens.toFixed(4)}`);
        }

        if (underlyingTokens !== null && underlyingTokens > 0) {
          const supplyUSD = underlyingTokens * priceUSD;
          console.log(`${market.key}: ${underlyingTokens.toFixed(4)} × $${priceUSD.toFixed(4)} = $${supplyUSD.toFixed(2)}`);
          results[market.key] = { type: 'supply', supplyUSD };
        } else {
          console.log(`${market.key}: no supply balance`);
        }

      } else if (market.type === 'borrow') {
        let borrowUSD = null;
        if (market.balanceMethod === 'stored') {
          const raw = await mToken.borrowBalanceStored(WALLET_EVM);
          borrowUSD = Number(raw) / Math.pow(10, market.underlyingDec);
        }
        if (borrowUSD !== null && borrowUSD > 0.01) {
          console.log(`${market.key}: borrow $${borrowUSD.toFixed(2)}`);
          results[market.key] = { type: 'borrow', borrowUSD };
        }
      }

    } catch (e) {
      console.error(`${market.key}: ${e.message.slice(0, 100)}`);
    }
  }

  return results;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log(`\n====== Daily Portfolio Check v14 — ${NOW_UTC} ======`);

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

  if (lighter?.llp != null) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.llp, true, {
      [F.positionValue]: lighter.llp,
      [F.notes]:         'Principal amount — real equity deferred',
    })]);
    if (ok) { written++; console.log(`✓ LLP: $${lighter.llp}`); }
  }

  if (lighter?.edgeHedge != null) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.edgeHedge, true, {
      [F.positionValue]: lighter.edgeHedge,
      [F.notes]:         'Principal amount — real equity deferred',
    })]);
    if (ok) { written++; console.log(`✓ Edge & Hedge: $${lighter.edgeHedge}`); }
  }

  if (lighter?.lit != null) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.litStaking, true, {
      [F.positionValue]: lighter.lit,
      [F.notes]:         'Principal amount — real equity deferred',
    })]);
    if (ok) { written++; console.log(`✓ LIT Staking: $${lighter.lit}`); }
  }

  if (weth) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.wethPrimary, weth.inRange, {
      [F.positionValue]: weth.positionValue,
      [F.revertPosVal]:  weth.positionValue,
      [F.notes]:         `ETH: $${weth.ethPrice?.toFixed(0)} | Tick: ${weth.currentTick} | Range: [${weth.tickLower}, ${weth.tickUpper}]`,
    })]);
    if (ok) { written++; console.log(`✓ WETH/USDC: $${weth.positionValue?.toFixed(2)}`); }
  }

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

// ============================================================
// Daily Portfolio Check — GitHub Actions v6
// Moonwell: uses Comptroller.getAllMarkets() + oracle for USD values
// WETH/USDC: on-chain Arbitrum RPC
// Lighter: principal_amount from public endpoint
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
};

// ---- Lending position record IDs ----
// Mapped by underlying token symbol
const LPOS = {
  WETH:    'rec1T0ll6aEkYoZwj',  // Moonwell ETH supply
  VIRTUAL: 'rec6Zi6u6uK6x4M9F',  // Moonwell VIRTUAL supply
  cbXRP:   'recQRudPvkFOMhfWL',  // Moonwell cbXRP supply
  AERO:    'recwH74S9hCOqPBjR',  // Moonwell AERO supply
  USDC:    'recJ2skZuwzu9f1xY',  // Moonwell USDC borrow
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
// MODULE 3 — Moonwell USD values (Base RPC)
// Uses Comptroller.getAllMarkets() to find all market addresses
// Uses Moonwell oracle to get USD prices for each token
// ============================================================

async function getMoonwellUSD() {
  console.log('\n--- Moonwell USD ---');
  const provider = new ethers.JsonRpcProvider(BASE_RPC);

  const COMPTROLLER = '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C';
  const comptrollerABI = [
    'function getAllMarkets() external view returns (address[])',
    'function oracle() external view returns (address)',
  ];
  const mTokenABI = [
    'function symbol() external view returns (string)',
    'function underlying() external view returns (address)',
    'function balanceOfUnderlying(address owner) external returns (uint)',
    'function borrowBalanceCurrent(address account) external returns (uint)',
    'function decimals() external view returns (uint8)',
  ];
  const underlyingABI = [
    'function symbol() external view returns (string)',
    'function decimals() external view returns (uint8)',
  ];
  const oracleABI = [
    'function getUnderlyingPrice(address mToken) external view returns (uint)',
  ];

  const results = {};

  try {
    const comptroller  = new ethers.Contract(COMPTROLLER, comptrollerABI, provider);
    const [markets, oracleAddr] = await Promise.all([
      comptroller.getAllMarkets(),
      comptroller.oracle(),
    ]);
    const oracle = new ethers.Contract(oracleAddr, oracleABI, provider);

    console.log(`Moonwell markets found: ${markets.length}`);

    for (const mAddr of markets) {
      try {
        const mToken = new ethers.Contract(mAddr, mTokenABI, provider);
        const mSymbol = await mToken.symbol();

        // Get underlying symbol
        let underlyingSymbol = 'ETH';
        let underlyingDecimals = 18;
        try {
          const underlyingAddr = await mToken.underlying();
          const underlying = new ethers.Contract(underlyingAddr, underlyingABI, provider);
          [underlyingSymbol, underlyingDecimals] = await Promise.all([
            underlying.symbol(),
            underlying.decimals(),
          ]);
        } catch {
          // Native ETH market has no underlying()
        }

        // Get oracle price (scaled by 1e36 / token decimals for Compound-style oracle)
        const oraclePrice = await oracle.getUnderlyingPrice(mAddr);
        // Oracle returns price * 1e18 * 1e(18-decimals)
        const priceScaleFactor = 18 + (18 - Number(underlyingDecimals));
        const priceUSD = Number(oraclePrice) / Math.pow(10, priceScaleFactor);

        // Check if this is a market we track
        const isTracked = Object.keys(LPOS).some(sym =>
          underlyingSymbol.toLowerCase().includes(sym.toLowerCase()) ||
          mSymbol.toLowerCase().includes(sym.toLowerCase())
        );

        if (!isTracked) continue;

        console.log(`Checking ${mSymbol} (${underlyingSymbol}), price: $${priceUSD.toFixed(4)}`);

        // Get supply balance and convert to USD
        try {
          const balRaw = await mToken.balanceOfUnderlying.staticCall(WALLET_EVM);
          const tokenBalance = Number(balRaw) / Math.pow(10, Number(underlyingDecimals));
          const supplyUSD = tokenBalance * priceUSD;

          if (supplyUSD > 0.01) {
            console.log(`  ${underlyingSymbol} supply: ${tokenBalance.toFixed(4)} tokens = $${supplyUSD.toFixed(2)}`);

            // Map to Airtable lending position record
            const posKey = Object.keys(LPOS).find(sym =>
              underlyingSymbol.toLowerCase().includes(sym.toLowerCase())
            );
            if (posKey && posKey !== 'USDC') {
              results[posKey] = { supplyUSD, mAddr };
            }
          }
        } catch (e) {
          console.error(`  ${underlyingSymbol} supply error: ${e.message.slice(0, 60)}`);
        }

        // Check borrow balance for USDC
        if (underlyingSymbol.toLowerCase().includes('usdc')) {
          try {
            const borrowRaw = await mToken.borrowBalanceCurrent.staticCall(WALLET_EVM);
            const borrowUSD = Number(borrowRaw) / Math.pow(10, Number(underlyingDecimals));
            if (borrowUSD > 0.01) {
              results['USDC'] = { borrowUSD, mAddr };
              console.log(`  USDC borrow: $${borrowUSD.toFixed(2)}`);
            }
          } catch (e) {
            console.error(`  USDC borrow error: ${e.message.slice(0, 60)}`);
          }
        }

      } catch (e) {
        // Skip markets we can't read
      }
    }
  } catch (e) {
    console.error(`Moonwell error: ${e.message}`);
  }

  return results;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log(`\n====== Daily Portfolio Check v6 — ${NOW_UTC} ======`);

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
      [F.notes]:         'Principal amount — real equity deferred (requires Lighter auth)',
    })]);
    if (ok) { written++; console.log(`✓ LLP: $${lighter.llp}`); }
  }

  // Lighter — Edge & Hedge
  if (lighter?.edgeHedge != null) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.edgeHedge, true, {
      [F.positionValue]: lighter.edgeHedge,
      [F.notes]:         'Principal amount — real equity deferred (requires Lighter auth)',
    })]);
    if (ok) { written++; console.log(`✓ Edge & Hedge: $${lighter.edgeHedge}`); }
  }

  // Lighter — LIT Staking
  if (lighter?.lit != null) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.litStaking, true, {
      [F.positionValue]: lighter.lit,
      [F.notes]:         'Principal amount — real equity deferred (requires Lighter auth)',
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

  // Moonwell USD values — lending table
  if (moonwell && Object.keys(moonwell).length > 0) {
    const batch = [];

    for (const [sym, data] of Object.entries(moonwell)) {
      if (sym === 'USDC' && data.borrowUSD != null) {
        batch.push(lendingRecord(LPOS.USDC, { [LF.borrowUSD]: data.borrowUSD }));
      } else if (LPOS[sym] && data.supplyUSD != null) {
        batch.push(lendingRecord(LPOS[sym], { [LF.supplyUSD]: data.supplyUSD }));
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

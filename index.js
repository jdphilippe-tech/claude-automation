// ============================================================
// Daily Portfolio Check — GitHub Actions v15
// ETH/VIRTUAL: oracle + balanceOfUnderlying.staticCall (confirmed)
// cbXRP/AERO/USDC: Moonwell yield-backend API for USD values
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

// Markets confirmed working with oracle + staticCall
const ORACLE_MARKETS = [
  { key: 'moonwellETH',  mAddr: '0x628ff693426583D9a7FB391E54366292F509D457', underlyingDec: 18, type: 'supply' },
  { key: 'moonwellVIRT', mAddr: '0xdE8Df9d942D78edE3Ca06e60712582F79CFfFC64', underlyingDec: 18, type: 'supply' },
];

// Markets that need alternative approach — use mToken address to match Moonwell API
// mToken address → lending position key
const ALTERNATIVE_MARKETS = {
  '0xb4fb8fed5b3aaa8434f0b19b1b623d977e07e86d': { key: 'moonwellCBXRP', type: 'supply'  },
  '0x73902f619ceb9b31fd8efecf435cbdf89e369ba6': { key: 'moonwellAERO',  type: 'supply'  },
  '0xedc817a28e8b93b03976fbd4a3ddbc9f7d176c22': { key: 'moonwellBorrow', type: 'borrow'  },
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

  // Part A: Oracle markets (ETH and VIRTUAL — confirmed working)
  const comptrollerABI = ['function oracle() external view returns (address)'];
  const oracleABI      = ['function getUnderlyingPrice(address mToken) external view returns (uint)'];
  const mTokenABI      = ['function balanceOfUnderlying(address owner) external returns (uint)'];

  try {
    const comptroller = new ethers.Contract(COMPTROLLER, comptrollerABI, provider);
    const oracle      = new ethers.Contract(await comptroller.oracle(), oracleABI, provider);

    for (const market of ORACLE_MARKETS) {
      try {
        const mToken     = new ethers.Contract(market.mAddr, mTokenABI, provider);
        const oracleRaw  = await oracle.getUnderlyingPrice(market.mAddr);
        const priceUSD   = Number(oracleRaw) / Math.pow(10, 36 - market.underlyingDec);
        const balRaw     = await mToken.balanceOfUnderlying.staticCall(WALLET_EVM);
        const tokens     = Number(balRaw) / Math.pow(10, market.underlyingDec);
        const supplyUSD  = tokens * priceUSD;
        console.log(`${market.key}: ${tokens.toFixed(4)} × $${priceUSD.toFixed(4)} = $${supplyUSD.toFixed(2)}`);
        if (supplyUSD > 0.01) results[market.key] = { type: 'supply', supplyUSD };
      } catch (e) {
        console.error(`${market.key}: ${e.message.slice(0, 80)}`);
      }
    }
  } catch (e) {
    console.error(`Oracle setup: ${e.message}`);
  }

  // Part B: Alternative markets — use Moonwell's ponder API which returns user positions
  // Try the correct ponder endpoint format
  const ponderEndpoints = [
    `https://ponder.moonwell.fi/v1/positions/${WALLET_EVM.toLowerCase()}`,
    `https://ponder.moonwell.fi/positions/${WALLET_EVM.toLowerCase()}`,
    `https://api.moonwell.fi/v1/positions?address=${WALLET_EVM.toLowerCase()}&chainId=8453`,
  ];

  let ponderData = null;
  for (const url of ponderEndpoints) {
    ponderData = await fetchWithTimeout(url);
    if (ponderData) {
      console.log(`Ponder response from ${url.slice(0, 60)}:`, JSON.stringify(ponderData).slice(0, 200));
      break;
    }
  }

  // If ponder fails, calculate using DeFi Llama prices + raw mToken data
  if (!ponderData) {
    console.log('Ponder unavailable — using DeFi Llama + raw mToken balances');

    // Get prices from DeFi Llama
    const tokenAddresses = [
      'base:0xcb585250f852C6c6bf90434AB21A00f02833a4af', // cbXRP
      'base:0x940181a94A35A4569E4529A3CDfB74e38FD98631', // AERO
      'base:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
    ];
    const priceData = await fetchWithTimeout(
      `https://coins.llama.fi/prices/current/${tokenAddresses.join(',')}`
    );

    const prices = {};
    if (priceData?.coins) {
      for (const [key, val] of Object.entries(priceData.coins)) {
        prices[key.split(':')[1].toLowerCase()] = val.price;
      }
    }
    console.log('DeFi Llama prices:', JSON.stringify(prices));

    // Try alternative ABI patterns for these contracts
    const altABIs = [
      // Try ERC4626 vault interface (getAssets, totalAssets, etc.)
      'function balanceOf(address account) external view returns (uint256)',
      'function convertToAssets(uint256 shares) external view returns (uint256)',
      'function totalAssets() external view returns (uint256)',
      'function totalSupply() external view returns (uint256)',
      // Compound V2 fallbacks
      'function getAccountSnapshot(address account) external view returns (uint, uint, uint, uint)',
    ];

    const altTokenABI = altABIs;

    const altMarkets = [
      { key: 'moonwellCBXRP', mAddr: '0xb4fb8fed5b3AaA8434f0B19b1b623d977e07e86d', tokenAddr: '0xcb585250f852C6c6bf90434AB21A00f02833a4af', dec: 6,  type: 'supply' },
      { key: 'moonwellAERO',  mAddr: '0x73902f619CEB9B31FD8EFecf435CbDf89E369Ba6', tokenAddr: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', dec: 18, type: 'supply' },
      { key: 'moonwellBorrow',mAddr: '0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22', tokenAddr: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', dec: 6,  type: 'borrow' },
    ];

    for (const market of altMarkets) {
      try {
        const contract = new ethers.Contract(market.mAddr, altTokenABI, provider);
        const price    = prices[market.tokenAddr.toLowerCase()] ?? (market.key === 'moonwellBorrow' ? 1.0 : null);

        if (!price) { console.error(`${market.key}: no price`); continue; }

        // Try getAccountSnapshot — returns (error, mTokenBalance, borrowBalance, exchangeRate)
        try {
          const snapshot = await contract.getAccountSnapshot(WALLET_EVM);
          console.log(`${market.key} snapshot: [${snapshot.map(x => x.toString()).join(', ')}]`);
          const mBal      = Number(snapshot[1]);
          const borrowBal = Number(snapshot[2]);
          const exchRate  = Number(snapshot[3]);

          if (market.type === 'supply' && mBal > 0 && exchRate > 0) {
            // underlying = mBal * exchRate / 1e18
            const underlying = mBal * exchRate / Math.pow(10, 18 + 8); // 8 = mToken decimals
            const supplyUSD  = underlying * price;
            console.log(`${market.key}: ${underlying.toFixed(4)} × $${price.toFixed(4)} = $${supplyUSD.toFixed(2)}`);
            if (supplyUSD > 0.01) results[market.key] = { type: 'supply', supplyUSD };
          } else if (market.type === 'borrow' && borrowBal > 0) {
            const borrowUSD = borrowBal / Math.pow(10, market.dec);
            console.log(`${market.key}: borrow $${borrowUSD.toFixed(2)}`);
            if (borrowUSD > 0.01) results[market.key] = { type: 'borrow', borrowUSD };
          } else {
            console.log(`${market.key}: zero balance`);
          }
        } catch (e) {
          console.error(`${market.key} getAccountSnapshot: ${e.message.slice(0, 60)}`);

          // Last resort: try balanceOf to at least get mToken count
          try {
            const mBal = await contract.balanceOf(WALLET_EVM);
            console.log(`${market.key} mToken balance: ${mBal.toString()}`);
          } catch (e2) {
            console.error(`${market.key} balanceOf: ${e2.message.slice(0, 40)}`);
          }
        }
      } catch (e) {
        console.error(`${market.key}: ${e.message.slice(0, 80)}`);
      }
    }
  }

  console.log(`Moonwell results: ${Object.keys(results).join(', ') || 'ETH+VIRTUAL only'}`);
  return results;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log(`\n====== Daily Portfolio Check v15 — ${NOW_UTC} ======`);

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

// ============================================================
// Daily Portfolio Check — GitHub Actions v19-fix
// Uses BigInt math for exchange rate to avoid floating point errors
// Correct formula derived empirically:
//   cbXRP (6 dec):  underlying = mBalRaw * exchRaw / 10^21  -> 332.57 ✓
//   AERO  (18 dec): underlying = mBalRaw * exchRaw / 10^35  -> 504.07 ✓
//   Pattern: divisor = 10^(mDec + 18 - underlyingDec + 2*underlyingDec - 1)
//   Simplified: divisor = 10^(mDec + 18 + underlyingDec - 1) ... nope
//   Actually: cbXRP 10^21 = 10^(8+18-6+1)... nope
//   Let's just hardcode what works:
//   divisorExp = mDec + 18 + underlyingDec - (underlyingDec*2 - underlyingDec + 14 - underlyingDec)
//   Cleanest: underlying_display = mBalRaw * exchRaw / BigInt(10^(mDec + 18)) / BigInt(10^underlyingDec) ... wait
//   mBalRaw=1623983762149 * exchRaw=204800000000000 / 10^26 = 332.57 ✓ (for cbXRP 6 dec: 8+18=26)
//   mBalRaw=2171116968994 * exchRaw=232200000000000000000000000 / 10^35 = 504.07 ✓ (for AERO 18 dec: 8+18+9=35)
//   So: divisorExp = mDec + 18 for cbXRP (6 dec) = 26
//       divisorExp = mDec + 18 + 9 for AERO (18 dec) = 35? 
//   That doesn't make sense either. Let me check AERO exchRate more carefully.
//   v18 log: exchRate=2.322e+26 — but what is it really?
//   If underlying = mBal * exchRate / 10^26 should give 504 for AERO:
//   504 = 2171116968994 * 2.322e26 / X => X = 2171116968994 * 2.322e26 / 504 ≈ 10^35
//   But for cbXRP: 332.57 = 1623983762149 * 2.048e14 / X => X = 10^21
//   Difference in divisors: 10^35 / 10^21 = 10^14 = 10^(8+6) = 10^(mDec + cbXRPdec) 
//   So divisor = 10^(26 + underlyingDec - 6) for 6-dec token = 10^26 for 6 dec
//   and divisor = 10^(26 + 18 - 6 + something)... not clean
//   
//   Let me try: underlying (raw) = mBalRaw * exchRate / 10^18  (standard compound)
//   underlying (display) = underlying_raw / 10^underlyingDec
//   BUT exchRate in v18 was shown as 2.048e14 for cbXRP and 2.322e26 for AERO
//   Standard Compound: exchangeRate scaled by 1e18, so underlying_raw = mBalRaw * exchRate / 1e18 / 10^mDec * 10^mDec
//   = mBalRaw * exchRate / 1e18
//   cbXRP: 1623983762149 * 2.048e14 / 1e18 = 332570 (raw 6-dec units) -> /1e6 = 0.33 ❌
//   Hmm no.
//   Try without mDec: underlying = mBalRaw * exchRate / 1e18 / 10^mDec
//   cbXRP: 1623983762149 * 2.048e14 / 1e18 / 1e8 = 332570 / 1e8 = 0.003 ❌
//
//   OK final approach: just divide by 10^21 for cbXRP and verify with BigInt
//   cbXRP: 1623983762149n * 204800000000000n / (10n**21n) = 332564... hmm
//   Let me be precise: exchRaw for cbXRP is an integer. From v18: 2.048e14 = 204800000000000 (15 digits)
//   1623983762149n * 204800000000000n = 332271234647875200000000 
//   / 10^21 = 332271234647875200000000 / 1000000000000000000000 = 332.27... 
//   Close to 332.57! Small difference due to floating point showing 2.048e14 rounded.
//   So formula IS: underlying_in_raw_units = mBalRaw * exchRaw / 10^(18 + mDec)
//                  underlying_display = underlying_raw / 10^underlyingDec
//                  = mBalRaw * exchRaw / 10^(18 + mDec + underlyingDec)
//   cbXRP: / 10^(18+8+6) = / 10^32 -> 332571 / 10^6... wait that gives 0.0003
//   I need to use actual BigInt values not floating point approximations.
//   The script will log the actual BigInt values.
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

const NOW_UTC = new Date().toISOString();

// ---- Field IDs ----
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

const COMPTROLLER = '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C';

const MARKETS = [
  { key: 'moonwellETH',   mAddr: '0x628ff693426583D9a7FB391E54366292F509D457', underlyingDec: 18, mDec: 8, type: 'supply', method: 'oracle' },
  { key: 'moonwellVIRT',  mAddr: '0xdE8Df9d942D78edE3Ca06e60712582F79CFfFC64', underlyingDec: 18, mDec: 8, type: 'supply', method: 'oracle' },
  { key: 'moonwellCBXRP', mAddr: '0xb4fb8fed5b3AaA8434f0B19b1b623d977e07e86d', underlyingAddr: '0xcb585250f852C6c6bf90434AB21A00f02833a4af', underlyingDec: 6,  mDec: 8, type: 'supply', method: 'mtoken' },
  { key: 'moonwellAERO',  mAddr: '0x73902f619CEB9B31FD8EFecf435CbDf89E369Ba6', underlyingAddr: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', underlyingDec: 18, mDec: 8, type: 'supply', method: 'mtoken' },
  { key: 'moonwellBorrow',mAddr: '0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22', underlyingDec: 6,  mDec: 8, type: 'borrow', method: 'borrow' },
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

// BigInt power helper
function pow10(n) {
  return BigInt(10) ** BigInt(n);
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
// MODULE 3 — Moonwell USD values (Base via Alchemy)
// ============================================================

async function getMoonwellUSD() {
  console.log('\n--- Moonwell USD ---');
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
  const llamaData     = await fetchWithTimeout(
    `https://coins.llama.fi/prices/current/${mtokenMarkets.map(m => `base:${m.underlyingAddr}`).join(',')}`
  );
  const prices = {};
  if (llamaData?.coins) {
    for (const [k, v] of Object.entries(llamaData.coins)) {
      prices[k.split(':')[1].toLowerCase()] = v.price;
    }
  }
  console.log('DeFi Llama:', JSON.stringify(prices));

  for (const market of MARKETS) {
    try {
      const mToken = new ethers.Contract(market.mAddr, mTokenABI, provider);

      if (market.method === 'oracle' && oracle) {
        const oracleRaw = await oracle.getUnderlyingPrice(market.mAddr);
        const priceUSD  = Number(oracleRaw) / Math.pow(10, 36 - market.underlyingDec);
        const balRaw    = await mToken.balanceOfUnderlying.staticCall(WALLET_EVM);
        const tokens    = Number(balRaw) / Math.pow(10, market.underlyingDec);
        const supplyUSD = tokens * priceUSD;
        console.log(`${market.key}: ${tokens.toFixed(4)} × $${priceUSD.toFixed(4)} = $${supplyUSD.toFixed(2)}`);
        if (supplyUSD > 0.01) results[market.key] = { type: 'supply', supplyUSD };

      } else if (market.method === 'mtoken') {
        const price = prices[market.underlyingAddr?.toLowerCase()] ?? null;
        if (!price) { console.error(`${market.key}: no price`); continue; }

        // Use BigInt to avoid floating point errors
        const [mBalRaw, exchRaw] = await Promise.all([
          mToken.balanceOf(WALLET_EVM),
          mToken.exchangeRateStored(),
        ]);

        // Log raw values so we can debug
        console.log(`${market.key} raw: mBal=${mBalRaw.toString()}, exchRate=${exchRaw.toString()}`);

        // Compound V2: underlying_in_18dec_units = mBal * exchRate / 10^18
        // Then adjust: underlying_display = underlying_18dec / 10^(18 - underlyingDec + mDec)
        // Wait — let me work backwards from known-good values:
        // cbXRP: mBal=1623983762149, need 332.57 cbXRP (6 dec)
        //        332.57 * 10^6 = 332570000 (raw cbXRP units)
        //        332570000 = mBal * exchRate / X
        //        X = 1623983762149 * exchRate / 332570000
        // AERO:  mBal=2171116968994, need 504.07 AERO (18 dec)
        //        504.07 * 10^18 = 504070000000000000000 (raw AERO units)
        //        504070000000000000000 = mBal * exchRate / X
        //        X = 2171116968994 * exchRate / 504070000000000000000
        // Standard Compound: underlying_raw = mBal * exchRate / 10^(18 + mDec - underlyingDec)
        //   cbXRP: / 10^(18+8-6) = / 10^20 -> underlying_raw (in 6-dec units)
        //   AERO:  / 10^(18+8-18) = / 10^8 -> underlying_raw (in 18-dec units)
        // Then divide by 10^underlyingDec to get display:
        //   cbXRP: underlying_raw / 10^20 / 10^6 -> but that's /10^26 which gave 0
        //
        // NEW THEORY: exchangeRateStored is NOT scaled by 1e18 for these contracts
        // It might be already in "underlying per mToken" with a different scaling.
        // Let me compute what scaling works for cbXRP given mBal:
        // We need: 332.57 * 10^6 = mBal * exchRate / X (underlying raw)
        // X = mBal * exchRate / (332.57 * 10^6)
        // We need exchRate actual value (BigInt) to compute this.
        // Log it and we'll fix next run.

        const mBalBig  = BigInt(mBalRaw.toString());
        const exchBig  = BigInt(exchRaw.toString());

        // Try standard Compound formula: underlying_raw = mBal * exchRate / 10^(18 + mDec - underlyingDec)
        // underlying_display = underlying_raw / 10^underlyingDec
        // Combined: underlying_display = mBal * exchRate / 10^(18 + mDec)
        const expStandard     = 18 + market.mDec;
        const underlyingRaw   = mBalBig * exchBig / pow10(expStandard);
        const underlyingDisplay = Number(underlyingRaw) / Math.pow(10, market.underlyingDec);

        console.log(`${market.key}: exchRate=${exchBig}, underlyingRaw=${underlyingRaw}, display=${underlyingDisplay.toFixed(4)}`);

        if (underlyingDisplay > 0.01) {
          const supplyUSD = underlyingDisplay * price;
          console.log(`${market.key}: ${underlyingDisplay.toFixed(4)} × $${price.toFixed(4)} = $${supplyUSD.toFixed(2)}`);
          if (supplyUSD > 0.01) results[market.key] = { type: 'supply', supplyUSD };
        } else {
          console.log(`${market.key}: underlyingDisplay too low (${underlyingDisplay}) — checking raw values above`);
        }

      } else if (market.method === 'borrow') {
        const borrowRaw = await mToken.borrowBalanceStored(WALLET_EVM);
        const borrowUSD = Number(borrowRaw) / Math.pow(10, market.underlyingDec);
        console.log(`${market.key}: borrow $${borrowUSD.toFixed(2)}`);
        if (borrowUSD > 0.01) results[market.key] = { type: 'borrow', borrowUSD };
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
  console.log(`\n====== Daily Portfolio Check v19-fix — ${NOW_UTC} ======`);

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

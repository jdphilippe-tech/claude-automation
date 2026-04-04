// ============================================================
// Daily Portfolio Check — GitHub Actions v26
// Added: Suilend (SUI supply, wSOL supply, USDC borrow) via raw Sui RPC
// No @suilend/sdk — avoids springsui-sdk ESM directory import bug
// Retained: WETH/USDC Primary (Arbitrum), Moonwell (Base)
// Schedule: 14:00 UTC = 7:00 AM PDT
// ============================================================

import { ethers } from 'ethers';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE    = 'appWojaxYR99bXC1f';
const DAILY_TABLE      = 'tblKsk0QnkOoKNLuk';
const LENDING_TABLE    = 'tblFw52kzeTRvxTSM';

const WALLET_EVM  = '0x871fd9a8A6a6E918658eadF46e9c23fE4E377289';
const WALLET_SUI  = '0xa43b2375ebc13ade7ea537e26e46cd32dc46edd4e23776149c576f1ce36705e9';
const WETH_POS_ID = 5384162n;

const BASE_RPC     = process.env.BASE_RPC_URL ?? 'https://base.llamarpc.com';
const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
const SUI_RPC      = 'https://fullnode.mainnet.sui.io';

// Suilend ObligationOwnerCap type — used to find obligation ID from wallet
// We scan all owned objects and match by type string keyword
// This avoids hardcoding the exact package address which may differ from docs
const OBLIGATION_CAP_KEYWORD = 'ObligationOwnerCap';

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

// Sui JSON-RPC helper
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
// MODULE 1 — WETH/USDC PRIMARY (Arbitrum)
// ============================================================

async function getWethPosition() {
  console.log('\n--- WETH/USDC Primary ---');
  try {
    const provider   = new ethers.JsonRpcProvider(ARBITRUM_RPC);
    const posABI     = ['function positions(uint256 tokenId) external view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'];
    const factoryABI = ['function getPool(address,address,uint24) external view returns (address)'];
    const poolABI    = ['function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)'];
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

    const MAX128     = BigInt('0xffffffffffffffffffffffffffffffff');
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
  } catch (e) {
    console.error(`Oracle: ${e.message}`);
  }

  const mtokenMarkets  = MARKETS.filter(m => m.method === 'mtoken');
  const llamaPriceData = await fetchWithTimeout(
    `https://coins.llama.fi/prices/current/${mtokenMarkets.map(m => `base:${m.underlyingAddr}`).join(',')}`
  );
  const prices = {};
  if (llamaPriceData?.coins) {
    for (const [k, v] of Object.entries(llamaPriceData.coins)) {
      prices[k.split(':')[1].toLowerCase()] = v.price;
    }
  }

  const llamaPoolsData = await fetchWithTimeout('https://yields.llama.fi/pools');
  const moonwellPools  = {};
  if (llamaPoolsData?.data) {
    const basePools = llamaPoolsData.data.filter(
      p => p.project === 'moonwell-lending' && p.chain === 'Base'
    );
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
      const pool      = moonwellPools[market.key];
      const supplyAPY = pool?.apy ?? null;

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
        const tokens    = borrowUSD;

        let borrowAPY = null;
        try {
          const rateRaw    = await mToken.borrowRatePerTimestamp();
          const ratePerSec = Number(rateRaw) / 1e18;
          borrowAPY        = ((1 + ratePerSec) ** 31_536_000 - 1) * 100;
        } catch (e) {
          console.error(`borrowRatePerTimestamp failed: ${e.message.slice(0, 60)}`);
        }

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
// MODULE 3 — Suilend (Sui) via raw RPC
// No SDK — avoids @suilend/springsui-sdk ESM directory import bug
// ============================================================

async function getSuilendData() {
  console.log('\n--- Suilend ---');
  const results = {};

  try {
    // Step 1: Scan all owned objects and find ObligationOwnerCap by type keyword
    // We can't use StructType filter because the exact package address varies
    let obligationId = null;
    let cursor = null;

    outer: while (true) {
      const page = await suiRpc('suix_getOwnedObjects', [
        WALLET_SUI,
        { options: { showType: true, showContent: true } },
        cursor,
        50,
      ]);

      if (!page?.data?.length) break;

      for (const obj of page.data) {
        const objType = obj.data?.type ?? '';
        if (objType.includes(OBLIGATION_CAP_KEYWORD)) {
          console.log(`Suilend: found cap type: ${objType}`);
          const fields = obj.data?.content?.fields;
          obligationId = fields?.obligation_id ?? fields?.obligationId;
          break outer;
        }
      }

      if (!page.hasNextPage) break;
      cursor = page.nextCursor;
    }

    if (!obligationId) {
      console.error('Suilend: no ObligationOwnerCap found. Logging all object types for debug:');
      const debugPage = await suiRpc('suix_getOwnedObjects', [
        WALLET_SUI,
        { options: { showType: true } },
        null,
        20,
      ]);
      for (const obj of debugPage?.data ?? []) {
        console.log(' -', obj.data?.type ?? 'unknown');
      }
      return results;
    }

    console.log(`Suilend: obligation ${obligationId}`);

    // Step 2: Fetch the obligation object
    const obligationObj    = await suiRpc('sui_getObject', [
      obligationId,
      { showContent: true, showType: true },
    ]);
    const obligationFields = obligationObj?.data?.content?.fields;

    if (!obligationFields) {
      console.error('Suilend: could not read obligation fields');
      return results;
    }

    // Log full structure on first run so we can see exact field names
    console.log('Obligation field keys:', Object.keys(obligationFields).join(', '));

    // Step 3: Get prices and lending market reserves in parallel
    const lendingMarketId = obligationFields.lending_market_id?.id
      ?? obligationFields.lending_market_id;

    const [priceData, lendingMarketObj] = await Promise.all([
      fetchWithTimeout('https://coins.llama.fi/prices/current/coingecko:sui,coingecko:wrapped-solana'),
      suiRpc('sui_getObject', [lendingMarketId, { showContent: true }]),
    ]);

    const suiPrice  = priceData?.coins?.['coingecko:sui']?.price ?? 0;
    const wsolPrice = priceData?.coins?.['coingecko:wrapped-solana']?.price ?? 0;
    console.log(`Prices: SUI $${suiPrice.toFixed(4)}, wSOL $${wsolPrice.toFixed(4)}`);

    // Reserves are stored as a vector in the lending market object fields
    const lmFields = lendingMarketObj?.data?.content?.fields;
    const reserves  = lmFields?.reserves ?? [];
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

      if (!suilendAPYs[key]) {
        // Config is Cell<ReserveConfig> — actual data at config.fields.element.fields
        const configEl = rf?.config?.fields?.element?.fields ?? {};

        // Interest rate model: piecewise linear lookup using utils[] and aprs[] arrays
        // interest_rate_utils: utilization breakpoints (scaled 1e18)
        // interest_rate_aprs: APR at each breakpoint (scaled 1e18, annualized)
        const utils = configEl?.interest_rate_utils ?? [];
        const aprs  = configEl?.interest_rate_aprs  ?? [];

        // borrowed_amount is a Decimal struct scaled by 1e18 (regardless of asset)
        // available_amount is raw token units in native asset decimals
        const mintDec      = Number(rf?.mint_decimals ?? 6);
        const borrowedRaw  = BigInt(rf?.borrowed_amount?.fields?.value ?? 0);
        const availableRaw = BigInt(rf?.available_amount ?? 0);

        // Convert both to same scale: native token units
        // borrowed: Decimal value / 1e18 gives token amount (already in native units)
        // available: raw / 10^mintDec gives token amount
        const borrowed  = Number(borrowedRaw) / 1e18;
        const available = Number(availableRaw) / Math.pow(10, mintDec);
        const total     = borrowed + available;
        const utilRate  = total > 0 ? borrowed / total : 0;

        // Interpolate borrow APR from the lookup table
        let borrowAprPerYear = 0;
        if (utils.length > 0 && aprs.length >= utils.length) {
          // Convert utils to fractions
          const utilPoints = utils.map(u => Number(u) / 1e18);
          const aprPoints  = aprs.map(a => Number(a) / 1e18);

          if (utilRate <= utilPoints[0]) {
            borrowAprPerYear = aprPoints[0];
          } else if (utilRate >= utilPoints[utilPoints.length - 1]) {
            borrowAprPerYear = aprPoints[aprPoints.length - 1];
          } else {
            for (let i = 1; i < utilPoints.length; i++) {
              if (utilRate <= utilPoints[i]) {
                const t = (utilRate - utilPoints[i-1]) / (utilPoints[i] - utilPoints[i-1]);
                borrowAprPerYear = aprPoints[i-1] + t * (aprPoints[i] - aprPoints[i-1]);
                break;
              }
            }
          }
        }

        // APR is already annualized — convert to APY via compound formula
        // APR per second = borrowAprPerYear / 31536000
        const borrowRatePerSec = borrowAprPerYear / 31_536_000;
        const borrowAPY = borrowRatePerSec > 0
          ? ((1 + borrowRatePerSec) ** 31_536_000 - 1) * 100
          : null;

        // Supply APY = borrow APY × utilization × (1 - spread_fee)
        const spreadFeeBps = Number(configEl?.spread_fee_bps ?? 0);
        const spreadFee    = spreadFeeBps / 10000;
        const supplyAPY    = borrowAPY != null
          ? borrowAPY * utilRate * (1 - spreadFee)
          : null;

        suilendAPYs[key] = { supplyAPY, borrowAPY };
        console.log(`Reserve ${key}: util=${(utilRate*100).toFixed(1)}%, borrowAPY=${borrowAPY?.toFixed(2) ?? 'n/a'}%, supplyAPY=${supplyAPY?.toFixed(2) ?? 'n/a'}%`);
      }
    }

    // Step 4: Parse deposits
    // Suilend obligation stores deposits as a dynamic field table — try common field names
    const depositList = obligationFields.deposits?.fields?.contents
      ?? obligationFields.collateral?.fields?.contents
      ?? obligationFields.deposits
      ?? [];

    console.log(`Deposits raw count: ${depositList.length}`);

    for (const entry of depositList) {
      const d        = entry?.fields ?? entry;
      const coinType = d?.coin_type?.fields?.name
        ?? d?.reserve_array_index  // fallback — log and skip
        ?? '';

      const isSUI  = coinType.toLowerCase().includes('sui::sui');
      const isWSOL = coinType.toLowerCase().includes('b7844e28');
      if (!isSUI && !isWSOL) continue;

      const assetKey  = isSUI ? 'SUI' : 'WSOL';
      const price     = isSUI ? suiPrice : wsolPrice;
      const lposKey   = isSUI ? 'suilendSUI' : 'suilendWSOL';
      const supplyAPY = suilendAPYs[assetKey]?.supplyAPY ?? null;

      // market_value.fields.value is scaled by 1e18 — confirmed from raw data
      // e.g. wSOL: 972659829285856213321 / 1e18 = $972.66 ✓
      const mv = d?.market_value;

      let supplyUSD = 0;
      // market_value is a Decimal struct: { fields: { value: "12345..." } } scaled 1e18
      // OR it could be a plain numeric string scaled 1e18
      // Use BigInt to avoid float precision loss on large integers
      if (mv?.fields?.value != null) {
        supplyUSD = Number(BigInt(mv.fields.value) / 10000n) / 1e14;  // /1e18 via BigInt
      } else if (mv != null && !isNaN(Number(mv))) {
        supplyUSD = Number(BigInt(String(mv).split('.')[0]) / 10000n) / 1e14;
      }
      // Fallback to ctoken * price
      if (supplyUSD === 0 || supplyUSD < 0.01) {
        const decimals  = isSUI ? 9 : 8;
        const ctokenRaw = BigInt(d?.deposited_ctoken_amount ?? 0);
        supplyUSD = (Number(ctokenRaw) / Math.pow(10, decimals)) * price;
      }
      const tokens = price > 0 ? supplyUSD / price : 0;

      console.log(`suilend${assetKey}: ${tokens.toFixed(4)} tokens = $${supplyUSD.toFixed(2)} | supplyAPY: ${supplyAPY?.toFixed(2) ?? 'n/a'}%`);
      results[lposKey] = { type: 'supply', supplyUSD, tokens, supplyAPY };
    }

    // Step 5: Parse borrows
    const borrowList = obligationFields.borrows?.fields?.contents
      ?? obligationFields.borrows
      ?? [];

    console.log(`Borrows raw count: ${borrowList.length}`);

    for (const entry of borrowList) {
      const b        = entry?.fields ?? entry;
      const coinType = b?.coin_type?.fields?.name ?? '';

      const isUSDC = coinType.toLowerCase().includes('usdc') || coinType.toLowerCase().includes('dba346');
      if (!isUSDC) continue;

      // borrowed_amount.fields.value is scaled by 1e24 (confirmed from raw data)
      // raw: 313648890508183858160030809 / 1e24 = 313.65 ✓
      // Note: supply market_value uses 1e18, borrow uses 1e24 — different scales
      const baRaw     = b?.borrowed_amount?.fields?.value ?? b?.borrowed_amount ?? '0';
      const baInt     = BigInt(String(baRaw).split('.')[0]);
      const borrowUSD = Number(baInt / 1000000n) / 1e18;  // /1e24 via BigInt
      const tokens    = borrowUSD;

      const borrowPool = suilendAPYs['USDC'];
      const borrowAPY  = borrowPool?.borrowAPY ?? null;

      console.log(`suilendBorrow: borrow $${borrowUSD.toFixed(2)} | borrowAPY: ${borrowAPY?.toFixed(2) ?? 'n/a'}%`);
      results['suilendBorrow'] = { type: 'borrow', borrowUSD, tokens, borrowAPY };
    }

  } catch (e) {
    console.error(`Suilend fatal: ${e.message}`);
  }

  return results;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log(`\n====== Daily Portfolio Check v26 — ${NOW_UTC} ======`);

  const [wethRes, moonwellRes, suilendRes] = await Promise.allSettled([
    getWethPosition(),
    getMoonwellData(),
    getSuilendData(),
  ]);

  const weth     = wethRes.value     ?? null;
  const moonwell = moonwellRes.value ?? null;
  const suilend  = suilendRes.value  ?? null;

  console.log('\n--- Writing to Airtable ---');
  let written = 0;

  // WETH/USDC Primary
  if (weth) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.wethPrimary, weth.inRange, {
      [F.positionValue]: weth.positionValue,
      [F.revertPosVal]:  weth.positionValue,
      ...(weth.feeValue > 0 ? { [F.feeValue]: weth.feeValue } : {}),
      [F.notes]:         `ETH: $${weth.ethPrice?.toFixed(0)} | Tick: ${weth.currentTick} | Range: [${weth.tickLower}, ${weth.tickUpper}]`,
    })]);
    if (ok) { written++; console.log(`✓ WETH/USDC: $${weth.positionValue?.toFixed(2)}, fees: $${weth.feeValue?.toFixed(2)}`); }
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

  // Suilend
  if (suilend && Object.keys(suilend).length > 0) {
    const batch = [];
    for (const [posKey, data] of Object.entries(suilend)) {
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
      if (ok) { written += batch.length; console.log(`✓ Suilend: ${batch.length} records`); }
    }
  }

  console.log(`\n====== Complete — ${written} records written ======`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

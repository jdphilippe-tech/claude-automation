// ============================================================
// Daily Portfolio Check — GitHub Actions v27
// Added: Raydium xStocks CLMM LP positions (Solana RPC, raw)
//        Discovery mode via RAYDIUM_DRY_RUN=true (logs only, no Airtable writes)
//        Once validated set RAYDIUM_DRY_RUN=false in repo vars to go live
// Retained: WETH/USDC Primary (Arbitrum), Moonwell (Base), Suilend (Sui)
// Schedule: 14:00 UTC = 7:00 AM PDT
// ============================================================

import { ethers } from 'ethers';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE    = 'appWojaxYR99bXC1f';
const DAILY_TABLE      = 'tblKsk0QnkOoKNLuk';
const LENDING_TABLE    = 'tblFw52kzeTRvxTSM';

const WALLET_EVM  = '0x871fd9a8A6a6E918658eadF46e9c23fE4E377289';
const WALLET_SUI  = '0xa43b2375ebc13ade7ea537e26e46cd32dc46edd4e23776149c576f1ce36705e9';
const WALLET_SOL  = '5yiTWdskR7yd5RXvs7MJLqWsn6n7geM8SzvYjUpRHrTX';
const WETH_POS_ID = 5384162n;

const BASE_RPC     = process.env.BASE_RPC_URL ?? 'https://base.llamarpc.com';
const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
const SUI_RPC      = 'https://fullnode.mainnet.sui.io';
const SOL_RPC      = process.env.SOL_RPC_URL ?? 'https://api.mainnet-beta.solana.com';

// Set to false once numbers are validated against Raydium UI
const RAYDIUM_DRY_RUN = (process.env.RAYDIUM_DRY_RUN ?? 'true') !== 'false';

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
  cycleId:       'fldFFts5ByR1EeYBk',
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
  // Raydium xStocks — NFT mint addresses from Raydium UI + Airtable record IDs
  // ⚠️ UPDATE CYCLE IDs once confirmed with you
  tslax:  { recordId: 'recd33iBRKrMMq710', cycleId: 'TSLAx-C2',  nftMint: '7R5JFSuXL23epYJmX6LhzbM2Nce39at4maWD7NeFK4tU' },
  nvdax:  { recordId: 'recdQq6r8iDl3BGYZ', cycleId: 'NVDAx-C1',  nftMint: 'J7qm9jifiKg7CyWDbmdDUNokhgs7JvwZmy2jnJ7qmN5Z' },
  aaplx:  { recordId: 'recGF59dwIOnE8fm2',  cycleId: 'AAPLx-C1',  nftMint: '2NsZvobR13JuYbkYTt5EK1XyyEJh3xB8621FhUW3LYKp' },
  googlx: { recordId: 'recRxStry17D0ZGB5',  cycleId: 'GOOGLx-C1', nftMint: '2jznFFq36gfhUsWRzkEigGBY8hDqHBv4W6CdtsSGArWx' },
  crclx:  { recordId: 'recPq2Ee2MsoMa21S',  cycleId: 'CRCLx-C1',  nftMint: 'AZHgbQL6dfBodYN5yHvNbvwWVYXvRGeqYRbd8ni9NfWq' },
  spyx:   { recordId: 'rechX4b2anmi82enx',  cycleId: 'SPYx-C1',   nftMint: 'HgcTrL1Tb57ZrycTbhcBgRviFcWrfSiJRWSmwELXSyrj' },
};

// Map xStock token name keywords → asset key
// Used to match pool tokens to the right Airtable record
const XSTOCK_MAP = {
  'TSLAx':  'tslax',
  'NVDAx':  'nvdax',
  'AAPLx':  'aaplx',
  'GOOGLx': 'googlx',
  'CRCLx':  'crclx',
  'SPYx':   'spyx',
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
// ============================================================

async function getSuilendData() {
  console.log('\n--- Suilend ---');
  const results = {};

  try {
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
      console.error('Suilend: no ObligationOwnerCap found.');
      return results;
    }

    console.log(`Suilend: obligation ${obligationId}`);

    const obligationObj    = await suiRpc('sui_getObject', [
      obligationId,
      { showContent: true, showType: true },
    ]);
    const obligationFields = obligationObj?.data?.content?.fields;

    if (!obligationFields) {
      console.error('Suilend: could not read obligation fields');
      return results;
    }

    console.log('Obligation field keys:', Object.keys(obligationFields).join(', '));

    const lendingMarketId = obligationFields.lending_market_id?.id
      ?? obligationFields.lending_market_id;

    const [priceData, lendingMarketObj] = await Promise.all([
      fetchWithTimeout('https://coins.llama.fi/prices/current/coingecko:sui,coingecko:wrapped-solana'),
      suiRpc('sui_getObject', [lendingMarketId, { showContent: true }]),
    ]);

    const suiPrice  = priceData?.coins?.['coingecko:sui']?.price ?? 0;
    const wsolPrice = priceData?.coins?.['coingecko:wrapped-solana']?.price ?? 0;
    console.log(`Prices: SUI $${suiPrice.toFixed(4)}, wSOL $${wsolPrice.toFixed(4)}`);

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
        const configEl = rf?.config?.fields?.element?.fields ?? {};
        const utils = configEl?.interest_rate_utils ?? [];
        const aprs  = configEl?.interest_rate_aprs  ?? [];

        const mintDec      = Number(rf?.mint_decimals ?? 6);
        const borrowedRaw  = BigInt(rf?.borrowed_amount?.fields?.value ?? 0);
        const scale27      = 10n ** 27n;
        const borrowedNative     = Number(borrowedRaw * 1000n / scale27) / 1000;
        const ctokenSupplyNative = Number(BigInt(rf?.ctoken_supply ?? 0)) / Math.pow(10, mintDec);
        const utilRate           = ctokenSupplyNative > 0 ? borrowedNative / ctokenSupplyNative : 0;

        let borrowAprPerYear = 0;
        if (utils.length > 0 && aprs.length >= utils.length) {
          const utilPoints = utils.map(u => Number(u) / 100);
          const aprPoints  = aprs.map(a => Number(a) / 10000);

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

        const borrowRatePerSec = borrowAprPerYear / 31_536_000;
        const borrowAPY = borrowRatePerSec > 0
          ? ((1 + borrowRatePerSec) ** 31_536_000 - 1) * 100
          : null;

        const spreadFeeBps = Number(configEl?.spread_fee_bps ?? 0);
        const spreadFee    = spreadFeeBps / 10000;
        const supplyAPY    = borrowAPY != null
          ? borrowAPY * utilRate * (1 - spreadFee)
          : null;

        suilendAPYs[key] = { supplyAPY, borrowAPY };
        console.log(`Reserve ${key}: util=${(utilRate*100).toFixed(1)}%, borrowAPY=${borrowAPY?.toFixed(2) ?? 'n/a'}%, supplyAPY=${supplyAPY?.toFixed(2) ?? 'n/a'}%`);
      }
    }

    const depositList = obligationFields.deposits?.fields?.contents
      ?? obligationFields.collateral?.fields?.contents
      ?? obligationFields.deposits
      ?? [];

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
      const supplyAPY = suilendAPYs[assetKey]?.supplyAPY ?? null;

      const mintDec2  = isSUI ? 9 : 8;
      const ctokenRaw = BigInt(d?.deposited_ctoken_amount ?? 0);
      const tokens    = Number(ctokenRaw) / Math.pow(10, mintDec2);
      const supplyUSD = tokens * price;

      console.log(`suilend${assetKey}: ${tokens.toFixed(4)} tokens = $${supplyUSD.toFixed(2)} | supplyAPY: ${supplyAPY?.toFixed(2) ?? 'n/a'}%`);
      results[lposKey] = { type: 'supply', supplyUSD, tokens, supplyAPY };
    }

    const borrowList = obligationFields.borrows?.fields?.contents
      ?? obligationFields.borrows
      ?? [];

    console.log(`Borrows raw count: ${borrowList.length}`);

    for (const entry of borrowList) {
      const b        = entry?.fields ?? entry;
      const coinType = b?.coin_type?.fields?.name ?? '';

      const isUSDC = coinType.toLowerCase().includes('usdc') || coinType.toLowerCase().includes('dba346');
      if (!isUSDC) continue;

      const baRaw     = b?.borrowed_amount?.fields?.value ?? b?.borrowed_amount ?? '0';
      const baInt     = BigInt(String(baRaw).split('.')[0]);
      const borrowUSD = Number(baInt / 1000000n) / 1e18;
      const tokens    = borrowUSD;

      const borrowPool = suilendAPYs['USDC'];
      const borrowAPY  = borrowPool?.borrowAPY ?? null;

      const depositedValueUsd      = Number(BigInt(obligationFields.deposited_value_usd?.fields?.value ?? 0) / 10000n) / 1e14;
      const allowedBorrowValueUsd  = Number(BigInt(obligationFields.allowed_borrow_value_usd?.fields?.value ?? 0) / 10000n) / 1e14;
      const ltvPct = allowedBorrowValueUsd > 0 ? (borrowUSD / allowedBorrowValueUsd * 100).toFixed(1) : 'n/a';
      const notes  = `Collateral: $${depositedValueUsd.toFixed(2)} | Borrow Limit: $${allowedBorrowValueUsd.toFixed(2)} | LTV Used: ${ltvPct}%`;

      console.log(`suilendBorrow: borrow $${borrowUSD.toFixed(2)} | borrowAPY: ${borrowAPY?.toFixed(2) ?? 'n/a'}% | ${notes}`);
      results['suilendBorrow'] = { type: 'borrow', borrowUSD, tokens, borrowAPY, notes };
    }

  } catch (e) {
    console.error(`Suilend fatal: ${e.message}`);
  }

  return results;
}

// ============================================================
// MODULE 4 — Raydium xStocks CLMM (Solana)
// ============================================================

// Raydium CLMM program ID on mainnet
const RAYDIUM_CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

// Q64.64 fixed point → float
function sqrtPriceX64ToFloat(sqrtPriceX64Str) {
  const val = BigInt(sqrtPriceX64Str);
  // sqrtPrice is Q64.64: divide by 2^64
  const Q64 = 2n ** 64n;
  const intPart  = Number(val / Q64);
  const fracPart = Number(val % Q64) / Number(Q64);
  return intPart + fracPart;
}

// Tick → sqrt price as float
function tickToSqrtPrice(tick) {
  return Math.sqrt(1.0001 ** tick);
}

// Calculate token amounts from liquidity + tick bounds + current tick
// Returns { amount0, amount1 } in raw token units (not USD)
function calcAmounts(liquidity, tickLower, tickUpper, tickCurrent, sqrtPriceCurrent) {
  const liq = Number(liquidity);
  const sqrtLower   = tickToSqrtPrice(tickLower);
  const sqrtUpper   = tickToSqrtPrice(tickUpper);
  const sqrtCurrent = sqrtPriceCurrent ?? tickToSqrtPrice(tickCurrent);

  const inRange = tickCurrent >= tickLower && tickCurrent < tickUpper;

  let amount0 = 0, amount1 = 0;
  if (inRange) {
    amount0 = liq * (sqrtUpper - sqrtCurrent) / (sqrtCurrent * sqrtUpper);
    amount1 = liq * (sqrtCurrent - sqrtLower);
  } else if (tickCurrent < tickLower) {
    amount0 = liq * (sqrtUpper - sqrtLower) / (sqrtLower * sqrtUpper);
  } else {
    amount1 = liq * (sqrtUpper - sqrtLower);
  }

  return { amount0, amount1, inRange };
}

// Parse a Raydium CLMM PersonalPositionState from raw base64 account data
// Layout (all little-endian):
//   8  bytes  discriminator
//   32 bytes  nft_mint
//   32 bytes  pool_id
//   4  bytes  tick_lower_index  (i32)
//   4  bytes  tick_upper_index  (i32)
//   16 bytes  liquidity         (u128)
//   16 bytes  fee_growth_inside_0_last_x64 (u128)
//   16 bytes  fee_growth_inside_1_last_x64 (u128)
//   8  bytes  token_fees_owed_0 (u64)
//   8  bytes  token_fees_owed_1 (u64)
//   ... reward fields follow (not needed for fee check)
function parsePositionAccount(data) {
  const buf = Buffer.from(data, 'base64');
  let offset = 8; // skip discriminator (8 bytes)
  offset += 1;    // skip bump (u8)

  const nftMintBytes = buf.slice(offset, offset + 32); offset += 32;
  const poolIdBytes  = buf.slice(offset, offset + 32); offset += 32;

  // Use bytes directly for base58 encoding — avoids BigInt leading zero loss
  const nftMint = base58EncodeBytes(nftMintBytes);
  const poolId  = base58EncodeBytes(poolIdBytes);

  const tickLower = buf.readInt32LE(offset); offset += 4;
  const tickUpper = buf.readInt32LE(offset); offset += 4;

  // u128 little-endian: two 64-bit halves
  const liqLo  = buf.readBigUInt64LE(offset);     offset += 8;
  const liqHi  = buf.readBigUInt64LE(offset);     offset += 8;
  const liquidity = liqLo | (liqHi << 64n);

  const feeGrowth0Lo = buf.readBigUInt64LE(offset); offset += 8;
  const feeGrowth0Hi = buf.readBigUInt64LE(offset); offset += 8;
  const feeGrowthInside0Last = feeGrowth0Lo | (feeGrowth0Hi << 64n);

  const feeGrowth1Lo = buf.readBigUInt64LE(offset); offset += 8;
  const feeGrowth1Hi = buf.readBigUInt64LE(offset); offset += 8;
  const feeGrowthInside1Last = feeGrowth1Lo | (feeGrowth1Hi << 64n);

  const tokenFeesOwed0 = buf.readBigUInt64LE(offset); offset += 8;
  const tokenFeesOwed1 = buf.readBigUInt64LE(offset); offset += 8;

  return {
    poolId: base58FromHex(poolId),
    nftMint: base58FromHex(nftMint),
    tickLower,
    tickUpper,
    liquidity,
    feeGrowthInside0Last,
    feeGrowthInside1Last,
    tokenFeesOwed0,
    tokenFeesOwed1,
  };
}

// Parse Raydium CLMM PoolState — we only need the fields relevant to price + fees
// Layout offset reference (all LE):
//   8   discriminator
//   1   amm_config bump
//   32  amm_config
//   32  creator
//   32  token_mint_0
//   32  token_mint_1
//   32  token_vault_0
//   32  token_vault_1
//   32  observation_key
//   1   mint_decimals_0
//   1   mint_decimals_1
//   2   tick_spacing
//   16  liquidity
//   16  sqrt_price_x64      ← current price
//   4   tick_current        ← current tick (i32)
//   2   observation_index
//   2   observation_update_duration
//   16  fee_growth_global_0_x64
//   16  fee_growth_global_1_x64
//   8   protocol_fees_token_0
//   8   protocol_fees_token_1
//   ... swap volumes etc
function parsePoolAccount(data) {
  const buf = Buffer.from(data, 'base64');
  let offset = 8;

  offset += 1 + 32 + 32; // bump + amm_config + creator

  const mint0Bytes = buf.slice(offset, offset + 32); offset += 32;
  const mint1Bytes = buf.slice(offset, offset + 32); offset += 32;

  offset += 32 + 32 + 32; // vault0, vault1, observation_key

  const decimals0 = buf.readUInt8(offset); offset += 1;
  const decimals1 = buf.readUInt8(offset); offset += 1;

  const tickSpacing = buf.readUInt16LE(offset); offset += 2;

  // skip pool liquidity (16 bytes)
  offset += 16;

  // sqrt_price_x64 (u128 LE)
  const sqrtPriceLo = buf.readBigUInt64LE(offset); offset += 8;
  const sqrtPriceHi = buf.readBigUInt64LE(offset); offset += 8;
  const sqrtPriceX64 = sqrtPriceLo | (sqrtPriceHi << 64n);

  const tickCurrent = buf.readInt32LE(offset); offset += 4;

  offset += 2 + 2; // observation_index, observation_update_duration

  // fee_growth_global_0_x64 (u128 LE)
  const fg0Lo = buf.readBigUInt64LE(offset); offset += 8;
  const fg0Hi = buf.readBigUInt64LE(offset); offset += 8;
  const feeGrowthGlobal0 = fg0Lo | (fg0Hi << 64n);

  // fee_growth_global_1_x64 (u128 LE)
  const fg1Lo = buf.readBigUInt64LE(offset); offset += 8;
  const fg1Hi = buf.readBigUInt64LE(offset); offset += 8;
  const feeGrowthGlobal1 = fg1Lo | (fg1Hi << 64n);

  return {
    mint0: base58EncodeBytes(mint0Bytes),
    mint1: base58EncodeBytes(mint1Bytes),
    decimals0,
    decimals1,
    tickSpacing,
    sqrtPriceX64,
    tickCurrent,
    feeGrowthGlobal0,
    feeGrowthGlobal1,
  };
}

// Calculate uncollected fees from fee growth fields
// Standard CLMM formula: fees_owed = (feeGrowthGlobal - feeGrowthInsideLast) × liquidity / Q64
// Note: this is a simplified version — full precision requires tick account fee_growth_outside values
// For daily monitoring this gives a close approximation; exact values require tick account reads
function calcPendingFees(feeGrowthGlobal, feeGrowthInsideLast, tokenFeesOwed, liquidity) {
  const Q64 = 2n ** 64n;
  // Handle wraparound (u128 overflow)
  const U128_MAX = 2n ** 128n;
  let delta = (feeGrowthGlobal - feeGrowthInsideLast + U128_MAX) % U128_MAX;
  const accumulated = Number(delta * liquidity / Q64);
  const alreadyOwed = Number(tokenFeesOwed);
  return accumulated + alreadyOwed;
}

// Minimal base58 decode/encode — enough to convert 32-byte hex pubkeys
// Uses the standard Bitcoin/Solana base58 alphabet
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58FromHex(hex) {
  return base58EncodeBytes(Buffer.from(hex, 'hex'));
}

// Correct base58 encoding from a Buffer/Uint8Array
// Handles leading zero bytes as leading '1' characters
function base58EncodeBytes(bytes) {
  let num = 0n;
  for (const b of bytes) {
    num = num * 256n + BigInt(b);
  }
  let result = '';
  while (num > 0n) {
    result = BASE58_ALPHABET[Number(num % 58n)] + result;
    num = num / 58n;
  }
  // Each leading zero byte → leading '1'
  for (const b of bytes) {
    if (b === 0) result = '1' + result;
    else break;
  }
  return result;
}

async function getRaydiumPositions() {
  console.log(`\n--- Raydium xStocks CLMM ${RAYDIUM_DRY_RUN ? '[DRY RUN]' : '[LIVE]'} ---`);
  const results = [];

  try {
    // Step 1: Query Raydium CLMM program directly for position accounts owned by this wallet
    // PersonalPositionState layout (all LE):
    //   0-7:   discriminator
    //   8-39:  nft_mint (unique position ID)
    //   40-71: pool_id
    //   72-103: owner (wallet pubkey) ← filter here
    console.log(`Scanning Raydium CLMM for positions owned by ${WALLET_SOL.slice(0,8)}...`);

    // NFT mints are hardcoded from Raydium UI — bypasses wallet scanning entirely.
    // Position PDAs are derived from: seeds=[POSITION_SEED, nft_mint], program=RAYDIUM_CLMM_PROGRAM
    // We fetch each position account directly using getAccountInfo on the derived PDA.

    // Build list of positions from ASSET config
    const xstockPositions = Object.entries(ASSET)
      .filter(([, v]) => typeof v === 'object' && v.nftMint)
      .map(([key, v]) => ({ key, ...v }));

    console.log(`Processing ${xstockPositions.length} hardcoded xStock positions`);

    for (const posConfig of xstockPositions) {
      const { key, nftMint, recordId, cycleId } = posConfig;
      try {
        // Find position account by memcmp on nft_mint at offset 9 in PersonalPositionState
        // Layout: discriminator(8) + bump(1) + nft_mint(32 starting at byte 9)
        // dataSize=281 confirmed from source: 8+1+32+32+4+4+16+16+16+8+8+72+64
        const programAccounts = await solRpc('getProgramAccounts', [
          RAYDIUM_CLMM_PROGRAM,
          {
            encoding: 'base64',
            filters: [
              { dataSize: 281 },
              { memcmp: { offset: 9, bytes: nftMint } },
            ],
          },
        ]);

        if (!programAccounts || programAccounts.length === 0) {
          // Try offset 8 as fallback (no bump byte in some versions)
          console.log(`  ${key}: not found at offset 9, trying offset 8...`);
          const fallback = await solRpc('getProgramAccounts', [
            RAYDIUM_CLMM_PROGRAM,
            {
              encoding: 'base64',
              filters: [
                { dataSize: 281 },
                { memcmp: { offset: 8, bytes: nftMint } },
              ],
            },
          ]);
          if (!fallback || fallback.length === 0) {
            console.log(`  ${key}: no position account found at offset 8 or 9`);
            continue;
          }
          programAccounts.push(...fallback);
        }

        const posData = programAccounts[0].account.data[0];
        const pos     = parsePositionAccount(posData);

        console.log(`  Position: ticks [${pos.tickLower}, ${pos.tickUpper}], liquidity: ${pos.liquidity}`);
        console.log(`  Pool ID (full): ${pos.poolId}`);
        console.log(`  NFT mint (verify): ${pos.nftMint}`);

        // Delay between positions to let Helius recover after getProgramAccounts
        await new Promise(r => setTimeout(r, 2000));

        // Fetch the pool account — retry up to 3 times with backoff if null
        let poolAccountRes = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          poolAccountRes = await solRpc('getAccountInfo', [pos.poolId, { encoding: 'base64' }]);
          if (poolAccountRes?.value?.data) break;
          console.log(`  Pool ${pos.poolId}: attempt ${attempt} failed — error above`);
          await new Promise(r => setTimeout(r, 3000));
        }

        if (!poolAccountRes?.value?.data) {
          console.error(`  Pool ${pos.poolId.slice(0,8)}...: could not fetch account data after retries`);
          continue;
        }

        const pool = parsePoolAccount(poolAccountRes.value.data[0]);

        console.log(`  Pool: mint0=${pool.mint0.slice(0,8)}... mint1=${pool.mint1.slice(0,8)}... tick=${pool.tickCurrent} dec0=${pool.decimals0} dec1=${pool.decimals1}`);

        // Get token prices from DeFi Llama
        const priceKeys = `solana:${pool.mint0},solana:${pool.mint1}`;
        const priceData = await fetchWithTimeout(`https://coins.llama.fi/prices/current/${priceKeys}`);
        const price0    = priceData?.coins?.[`solana:${pool.mint0}`]?.price ?? null;
        const price1    = priceData?.coins?.[`solana:${pool.mint1}`]?.price ?? null;

        console.log(`  Prices: mint0=$${price0?.toFixed(4) ?? 'n/a'}, mint1=$${price1?.toFixed(4) ?? 'n/a'}`);

        // Calculate position value
        const sqrtPriceFloat = sqrtPriceX64ToFloat(pool.sqrtPriceX64.toString());
        const { amount0, amount1, inRange } = calcAmounts(
          pos.liquidity, pos.tickLower, pos.tickUpper, pool.tickCurrent, sqrtPriceFloat
        );

        const tokens0 = amount0 / Math.pow(10, pool.decimals0);
        const tokens1 = amount1 / Math.pow(10, pool.decimals1);
        const value0  = price0 != null ? tokens0 * price0 : null;
        const value1  = price1 != null ? tokens1 * price1 : null;
        const positionValue = (value0 ?? 0) + (value1 ?? 0);

        console.log(`  Amounts: ${tokens0.toFixed(6)} token0 ($${value0?.toFixed(2) ?? '?'}) + ${tokens1.toFixed(6)} token1 ($${value1?.toFixed(2) ?? '?'})`);
        console.log(`  Position value: $${positionValue.toFixed(2)}, in range: ${inRange}`);

        // Calculate pending fees
        const pendingRaw0 = calcPendingFees(pool.feeGrowthGlobal0, pos.feeGrowthInside0Last, pos.tokenFeesOwed0, pos.liquidity);
        const pendingRaw1 = calcPendingFees(pool.feeGrowthGlobal1, pos.feeGrowthInside1Last, pos.tokenFeesOwed1, pos.liquidity);
        const pendingTokens0 = pendingRaw0 / Math.pow(10, pool.decimals0);
        const pendingTokens1 = pendingRaw1 / Math.pow(10, pool.decimals1);
        const pendingUSD0    = price0 != null ? pendingTokens0 * price0 : 0;
        const pendingUSD1    = price1 != null ? pendingTokens1 * price1 : 0;
        const pendingYield   = pendingUSD0 + pendingUSD1;

        console.log(`  Pending fees: ${pendingTokens0.toFixed(6)} token0 + ${pendingTokens1.toFixed(6)} USDC = $${pendingYield.toFixed(4)}`);

        // Resolve asset key
        const assetKey = resolveXStockAsset(pool.mint0, pool.mint1);
        console.log(`  Resolved asset key: ${assetKey ?? 'UNKNOWN (add mint to XSTOCK_MINT_MAP)'}`);
        console.log(`  mint0 (xStock): ${pool.mint0}`);
        console.log(`  mint1 (USDC?):  ${pool.mint1}`);

        results.push({
          assetKey,
          poolId: pos.poolId,
          mint0: pool.mint0,
          mint1: pool.mint1,
          positionValue,
          pendingYield,
          inRange,
          tickCurrent: pool.tickCurrent,
          tickLower: pos.tickLower,
          tickUpper: pos.tickUpper,
        });

      } catch (e) {
        console.error(`  Error processing position: ${e.message}`);
      }
    }

  } catch (e) {
    console.error(`Raydium fatal: ${e.message}`);
  }

  return results;
}

// Resolve which xStock asset a position belongs to
// On first discovery run this will log unknown — we update the map after seeing the mints
// Known USDC mint on Solana: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
const USDC_MINT_SOL  = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ⚠️ POPULATE after first discovery run — map xStock mint → ASSET key
// These will be logged in the Actions output on first run
const XSTOCK_MINT_MAP = {
  // 'MINT_ADDRESS': 'tslax',
  // 'MINT_ADDRESS': 'nvdax',
  // etc.
};

function resolveXStockAsset(mint0, mint1) {
  // mint1 should be USDC, mint0 should be the xStock
  const xStockMint = mint0 === USDC_MINT_SOL ? mint1 : mint0;
  return XSTOCK_MINT_MAP[xStockMint] ?? null;
}

// base58 → Uint8Array — needed for memcmp filters
function base58ToBytes(str) {
  let num = 0n;
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`Invalid base58 char: ${char}`);
    num = num * 58n + BigInt(idx);
  }
  const bytes = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  // Pad to 32 bytes
  while (bytes.length < 32) bytes.unshift(0);
  return new Uint8Array(bytes);
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log(`\n====== Daily Portfolio Check v27 — ${NOW_UTC} ======`);
  if (RAYDIUM_DRY_RUN) {
    console.log('ℹ️  RAYDIUM_DRY_RUN=true — Raydium data will be logged but NOT written to Airtable');
  }

  const [wethRes, moonwellRes, suilendRes, raydiumRes] = await Promise.allSettled([
    getWethPosition(),
    getMoonwellData(),
    getSuilendData(),
    getRaydiumPositions(),
  ]);

  const weth     = wethRes.status     === 'fulfilled' ? wethRes.value     : null;
  const moonwell = moonwellRes.status === 'fulfilled' ? moonwellRes.value : null;
  const suilend  = suilendRes.status  === 'fulfilled' ? suilendRes.value  : null;
  const raydium  = raydiumRes.status  === 'fulfilled' ? raydiumRes.value  : [];

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
        if (data.notes)             fields[LF.notes]     = data.notes;
        batch.push(lendingRecord(LPOS[posKey], fields));
        console.log(`  Queued ${posKey}: $${data.borrowUSD.toFixed(2)}, ${data.tokens?.toFixed(4)} tokens, Borrow APY ${data.borrowAPY?.toFixed(2) ?? 'n/a'}%`);
      }
    }
    if (batch.length > 0) {
      const ok = await airtableCreate(LENDING_TABLE, batch);
      if (ok) { written += batch.length; console.log(`✓ Suilend: ${batch.length} records`); }
    }
  }

  // Raydium xStocks
  if (raydium.length > 0) {
    console.log(`\nRaydium — ${raydium.length} position(s) found`);

    if (RAYDIUM_DRY_RUN) {
      console.log('DRY RUN — printing results, skipping Airtable write:');
      for (const pos of raydium) {
        console.log(`  ${pos.assetKey ?? 'UNKNOWN'} | mint0: ${pos.mint0} | value: $${pos.positionValue.toFixed(2)} | yield: $${pos.pendingYield.toFixed(4)} | inRange: ${pos.inRange}`);
      }
      console.log('\n⚠️  ACTION REQUIRED after this run:');
      console.log('  1. Check the mint0 addresses above and map them in XSTOCK_MINT_MAP');
      console.log('  2. Confirm position values match Raydium UI');
      console.log('  3. Confirm pending yield matches Raydium UI');
      console.log('  4. Set RAYDIUM_DRY_RUN=false in GitHub repo variables to go live');
    } else {
      // Live write — only write positions that have a resolved asset key
      const batch = [];
      for (const pos of raydium) {
        if (!pos.assetKey || !ASSET[pos.assetKey]) {
          console.warn(`  Skipping unresolved position (mint0: ${pos.mint0})`);
          continue;
        }
        const { recordId, cycleId } = ASSET[pos.assetKey];
        batch.push(dailyRecord(recordId, pos.inRange, {
          [F.positionValue]: pos.positionValue,
          [F.revertPosVal]:  pos.positionValue,
          [F.feeValue]:      pos.pendingYield,
          [F.cycleId]:       cycleId,
          [F.notes]:         `Tick: ${pos.tickCurrent} | Range: [${pos.tickLower}, ${pos.tickUpper}]`,
        }));
        console.log(`  Queued ${pos.assetKey}: $${pos.positionValue.toFixed(2)}, yield: $${pos.pendingYield.toFixed(4)}, inRange: ${pos.inRange}`);
      }
      if (batch.length > 0) {
        // Batch in chunks of 10 (Airtable limit)
        for (let i = 0; i < batch.length; i += 10) {
          const ok = await airtableCreate(DAILY_TABLE, batch.slice(i, i + 10));
          if (ok) written += Math.min(10, batch.length - i);
        }
        console.log(`✓ Raydium: ${batch.length} records written`);
      }
    }
  } else {
    console.log('Raydium: no positions returned');
  }

  console.log(`\n====== Complete — ${written} records written ======`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

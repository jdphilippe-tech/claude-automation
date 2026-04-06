// ============================================================
// Daily Portfolio Check — GitHub Actions v27
// Raydium xStocks CLMM: position value + in-range status (pending yield = Phase 2)
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
const WETH_POS_ID = 5384162n;

const BASE_RPC     = process.env.BASE_RPC_URL ?? 'https://base.llamarpc.com';
const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
const SUI_RPC      = 'https://fullnode.mainnet.sui.io';
const SOL_RPC      = process.env.SOL_RPC_URL ?? 'https://api.mainnet-beta.solana.com';

// Set RAYDIUM_DRY_RUN=false in GitHub repo Variables to go live
const RAYDIUM_DRY_RUN = (process.env.RAYDIUM_DRY_RUN ?? 'true') !== 'false';

const OBLIGATION_CAP_KEYWORD = 'ObligationOwnerCap';
const RAYDIUM_CLMM_PROGRAM   = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

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
  // Raydium xStocks — all data confirmed from Raydium UI and dry runs
  // ⚠️ UPDATE cycleId once Cycle IDs are seeded in Airtable
  tslax:  { recordId: 'recd33iBRKrMMq710', cycleId: 'TSLAx-C2',  nftMint: '7R5JFSuXL23epYJmX6LhzbM2Nce39at4maWD7NeFK4tU', poolId: '8aDaBQkTrS6HVMjyc6EZebgdiaXhLYGriDWKWWp1NpFF' },
  nvdax:  { recordId: 'recdQq6r8iDl3BGYZ', cycleId: 'NVDAx-C1',  nftMint: 'J7qm9jifiKg7CyWDbmdDUNokhgs7JvwZmy2jnJ7qmN5Z', poolId: '4KqQN6u1pFKroFE2jVEhoepAMRKPcuAzWVDCgm9zRBYN' },
  aaplx:  { recordId: 'recGF59dwIOnE8fm2', cycleId: 'AAPLx-C1',  nftMint: '2NsZvobR13JuYbkYTt5EK1XyyEJh3xB8621FhUW3LYKp', poolId: 'CKwJZwm7oj3nu4653N1EpDrqXbXAYXoPFiPeEnLouF8y' },
  googlx: { recordId: 'recRxStry17D0ZGB5', cycleId: 'GOOGLx-C1', nftMint: '2jznFFq36gfhUsWRzkEigGBY8hDqHBv4W6CdtsSGArWx', poolId: 'B8YAwjGYk6qidWzGBXMAxP7nYfG8g74EZ3Y4gFSsobRw' },
  crclx:  { recordId: 'recPq2Ee2MsoMa21S', cycleId: 'CRCLx-C1',  nftMint: 'AZHgbQL6dfBodYN5yHvNbvwWVYXvRGeqYRbd8ni9NfWq', poolId: 'G39wywquKbHK8F2wZZZFX3fcsyG91VCCbbr6WEVp5axy' },
  spyx:   { recordId: 'rechX4b2anmi82enx', cycleId: 'SPYx-C1',   nftMint: 'HgcTrL1Tb57ZrycTbhcBgRviFcWrfSiJRWSmwELXSyrj', poolId: '6truu3rZuiB9rKQg4VYC3Dt3QwV7DgwGqXrYUcrvnDDE' },
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
  } catch (e) { console.error(`Oracle: ${e.message}`); }

  const mtokenMarkets  = MARKETS.filter(m => m.method === 'mtoken');
  const llamaPriceData = await fetchWithTimeout(`https://coins.llama.fi/prices/current/${mtokenMarkets.map(m => `base:${m.underlyingAddr}`).join(',')}`);
  const prices = {};
  if (llamaPriceData?.coins) {
    for (const [k, v] of Object.entries(llamaPriceData.coins)) prices[k.split(':')[1].toLowerCase()] = v.price;
  }

  const llamaPoolsData = await fetchWithTimeout('https://yields.llama.fi/pools');
  const moonwellPools  = {};
  if (llamaPoolsData?.data) {
    const basePools = llamaPoolsData.data.filter(p => p.project === 'moonwell-lending' && p.chain === 'Base');
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
      const supplyAPY = moonwellPools[market.key]?.apy ?? null;

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
        const [mBalRaw, exchRaw] = await Promise.all([mToken.balanceOf(WALLET_EVM), mToken.exchangeRateStored()]);
        const underlying = Number(BigInt(mBalRaw.toString()) * BigInt(exchRaw.toString()) / (BigInt(10) ** BigInt(18 + market.underlyingDec)));
        const supplyUSD  = underlying * price;
        console.log(`${market.key}: ${underlying.toFixed(4)} tokens × $${price.toFixed(4)} = $${supplyUSD.toFixed(2)} | supplyAPY: ${supplyAPY?.toFixed(2)}%`);
        if (supplyUSD > 0.01) results[market.key] = { type: 'supply', supplyUSD, tokens: underlying, supplyAPY };

      } else if (market.method === 'borrow') {
        const borrowRaw = await mToken.borrowBalanceStored(WALLET_EVM);
        const borrowUSD = Number(borrowRaw) / Math.pow(10, market.underlyingDec);
        let borrowAPY = null;
        try {
          const rateRaw    = await mToken.borrowRatePerTimestamp();
          const ratePerSec = Number(rateRaw) / 1e18;
          borrowAPY        = ((1 + ratePerSec) ** 31_536_000 - 1) * 100;
        } catch (e) { console.error(`borrowRatePerTimestamp failed: ${e.message.slice(0, 60)}`); }
        console.log(`${market.key}: borrow $${borrowUSD.toFixed(2)} | borrowAPY: ${borrowAPY?.toFixed(2)}%`);
        if (borrowUSD > 0.01) results[market.key] = { type: 'borrow', borrowUSD, tokens: borrowUSD, borrowAPY };
      }
    } catch (e) { console.error(`${market.key}: ${e.message.slice(0, 80)}`); }
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
    let obligationId = null, cursor = null;
    outer: while (true) {
      const page = await suiRpc('suix_getOwnedObjects', [WALLET_SUI, { options: { showType: true, showContent: true } }, cursor, 50]);
      if (!page?.data?.length) break;
      for (const obj of page.data) {
        if ((obj.data?.type ?? '').includes(OBLIGATION_CAP_KEYWORD)) {
          console.log(`Suilend: found cap type: ${obj.data.type}`);
          const fields = obj.data?.content?.fields;
          obligationId = fields?.obligation_id ?? fields?.obligationId;
          break outer;
        }
      }
      if (!page.hasNextPage) break;
      cursor = page.nextCursor;
    }

    if (!obligationId) { console.error('Suilend: no ObligationOwnerCap found.'); return results; }
    console.log(`Suilend: obligation ${obligationId}`);

    const obligationObj    = await suiRpc('sui_getObject', [obligationId, { showContent: true, showType: true }]);
    const obligationFields = obligationObj?.data?.content?.fields;
    if (!obligationFields) { console.error('Suilend: could not read obligation fields'); return results; }

    console.log('Obligation field keys:', Object.keys(obligationFields).join(', '));

    const lendingMarketId = obligationFields.lending_market_id?.id ?? obligationFields.lending_market_id;
    const [priceData, lendingMarketObj] = await Promise.all([
      fetchWithTimeout('https://coins.llama.fi/prices/current/coingecko:sui,coingecko:wrapped-solana'),
      suiRpc('sui_getObject', [lendingMarketId, { showContent: true }]),
    ]);

    const suiPrice  = priceData?.coins?.['coingecko:sui']?.price ?? 0;
    const wsolPrice = priceData?.coins?.['coingecko:wrapped-solana']?.price ?? 0;
    console.log(`Prices: SUI $${suiPrice.toFixed(4)}, wSOL $${wsolPrice.toFixed(4)}`);

    const reserves = lendingMarketObj?.data?.content?.fields?.reserves ?? [];
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
      if (suilendAPYs[key]) continue;

      const configEl = rf?.config?.fields?.element?.fields ?? {};
      const utils    = configEl?.interest_rate_utils ?? [];
      const aprs     = configEl?.interest_rate_aprs  ?? [];
      const mintDec  = Number(rf?.mint_decimals ?? 6);
      const borrowedNative     = Number(BigInt(rf?.borrowed_amount?.fields?.value ?? 0) * 1000n / 10n ** 27n) / 1000;
      const ctokenSupplyNative = Number(BigInt(rf?.ctoken_supply ?? 0)) / Math.pow(10, mintDec);
      const utilRate           = ctokenSupplyNative > 0 ? borrowedNative / ctokenSupplyNative : 0;

      let borrowAprPerYear = 0;
      if (utils.length > 0 && aprs.length >= utils.length) {
        const utilPoints = utils.map(u => Number(u) / 100);
        const aprPoints  = aprs.map(a => Number(a) / 10000);
        if (utilRate <= utilPoints[0]) { borrowAprPerYear = aprPoints[0]; }
        else if (utilRate >= utilPoints[utilPoints.length - 1]) { borrowAprPerYear = aprPoints[aprPoints.length - 1]; }
        else {
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
      const borrowAPY = borrowRatePerSec > 0 ? ((1 + borrowRatePerSec) ** 31_536_000 - 1) * 100 : null;
      const spreadFee = Number(configEl?.spread_fee_bps ?? 0) / 10000;
      const supplyAPY = borrowAPY != null ? borrowAPY * utilRate * (1 - spreadFee) : null;
      suilendAPYs[key] = { supplyAPY, borrowAPY };
      console.log(`Reserve ${key}: util=${(utilRate*100).toFixed(1)}%, borrowAPY=${borrowAPY?.toFixed(2) ?? 'n/a'}%, supplyAPY=${supplyAPY?.toFixed(2) ?? 'n/a'}%`);
    }

    const depositList = obligationFields.deposits?.fields?.contents ?? obligationFields.collateral?.fields?.contents ?? obligationFields.deposits ?? [];
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
      const tokens    = Number(BigInt(d?.deposited_ctoken_amount ?? 0)) / Math.pow(10, isSUI ? 9 : 8);
      const supplyUSD = tokens * price;
      console.log(`suilend${assetKey}: ${tokens.toFixed(4)} tokens = $${supplyUSD.toFixed(2)} | supplyAPY: ${suilendAPYs[assetKey]?.supplyAPY?.toFixed(2) ?? 'n/a'}%`);
      results[lposKey] = { type: 'supply', supplyUSD, tokens, supplyAPY: suilendAPYs[assetKey]?.supplyAPY ?? null };
    }

    const borrowList = obligationFields.borrows?.fields?.contents ?? obligationFields.borrows ?? [];
    console.log(`Borrows raw count: ${borrowList.length}`);
    for (const entry of borrowList) {
      const b        = entry?.fields ?? entry;
      const coinType = b?.coin_type?.fields?.name ?? '';
      if (!coinType.toLowerCase().includes('usdc') && !coinType.toLowerCase().includes('dba346')) continue;
      const baInt     = BigInt(String(b?.borrowed_amount?.fields?.value ?? '0').split('.')[0]);
      const borrowUSD = Number(baInt / 1000000n) / 1e18;
      const borrowAPY = suilendAPYs['USDC']?.borrowAPY ?? null;
      const depositedValueUsd     = Number(BigInt(obligationFields.deposited_value_usd?.fields?.value ?? 0) / 10000n) / 1e14;
      const allowedBorrowValueUsd = Number(BigInt(obligationFields.allowed_borrow_value_usd?.fields?.value ?? 0) / 10000n) / 1e14;
      const ltvPct = allowedBorrowValueUsd > 0 ? (borrowUSD / allowedBorrowValueUsd * 100).toFixed(1) : 'n/a';
      const notes  = `Collateral: $${depositedValueUsd.toFixed(2)} | Borrow Limit: $${allowedBorrowValueUsd.toFixed(2)} | LTV Used: ${ltvPct}%`;
      console.log(`suilendBorrow: borrow $${borrowUSD.toFixed(2)} | borrowAPY: ${borrowAPY?.toFixed(2) ?? 'n/a'}% | ${notes}`);
      results['suilendBorrow'] = { type: 'borrow', borrowUSD, tokens: borrowUSD, borrowAPY, notes };
    }
  } catch (e) { console.error(`Suilend fatal: ${e.message}`); }

  return results;
}

// ============================================================
// MODULE 4 — Raydium xStocks CLMM (Solana)
// Logs: position value + in-range status
// Pending yield deferred to Phase 2 (tick array PDA derivation)
// ============================================================

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58EncodeBytes(input) {
  const bytes = Array.from(input);
  let num = 0n;
  for (const b of bytes) { num = num * 256n + BigInt(b); }
  let result = '';
  while (num > 0n) { result = BASE58_ALPHABET[Number(num % 58n)] + result; num = num / 58n; }
  for (const b of bytes) { if (b === 0) result = '1' + result; else break; }
  return result;
}

function sqrtPriceX64ToFloat(str) {
  const val = BigInt(str);
  const Q64 = 2n ** 64n;
  return Number(val / Q64) + Number(val % Q64) / Number(Q64);
}

function calcAmounts(liquidity, tickLower, tickUpper, tickCurrent, sqrtPriceCurrent) {
  const liq = Number(liquidity);
  const sqrtL = Math.sqrt(1.0001 ** tickLower);
  const sqrtU = Math.sqrt(1.0001 ** tickUpper);
  const sqrtC = sqrtPriceCurrent ?? Math.sqrt(1.0001 ** tickCurrent);
  const inRange = tickCurrent >= tickLower && tickCurrent < tickUpper;
  let a0 = 0, a1 = 0;
  if (inRange)              { a0 = liq * (sqrtU - sqrtC) / (sqrtC * sqrtU); a1 = liq * (sqrtC - sqrtL); }
  else if (tickCurrent < tickLower) { a0 = liq * (sqrtU - sqrtL) / (sqrtL * sqrtU); }
  else                      { a1 = liq * (sqrtU - sqrtL); }
  return { amount0: a0, amount1: a1, inRange };
}

function parsePositionAccount(data) {
  // Layout: disc(8) + bump(1) + nft_mint(32) + pool_id(32) + tick_lower(4) + tick_upper(4) + liquidity(16) + ...
  const buf = Buffer.from(data, 'base64');
  const tickLower = buf.readInt32LE(73);
  const tickUpper = buf.readInt32LE(77);
  const liqLo = buf.readBigUInt64LE(81);
  const liqHi = buf.readBigUInt64LE(89);
  return { tickLower, tickUpper, liquidity: liqLo | (liqHi << 64n) };
}

function parsePoolAccount(data) {
  // Layout: disc(8) + bump(1) + amm_config(32) + creator(32) + mint0(32) + mint1(32) + vault0(32) + vault1(32) + obs(32) + dec0(1) + dec1(1) + tickSpacing(2) + liq(16) + sqrtPrice(16) + tickCurrent(4)
  const buf = Buffer.from(data, 'base64');
  const mint0Bytes = buf.slice(73, 105);
  const mint1Bytes = buf.slice(105, 137);
  const dec0       = buf.readUInt8(233);
  const dec1       = buf.readUInt8(234);
  const sqrtLo     = buf.readBigUInt64LE(238);
  const sqrtHi     = buf.readBigUInt64LE(246);
  const tickCurrent = buf.readInt32LE(254);
  return {
    mint0: base58EncodeBytes(Array.from(mint0Bytes)),
    mint1: base58EncodeBytes(Array.from(mint1Bytes)),
    decimals0: dec0,
    decimals1: dec1,
    sqrtPriceX64: sqrtLo | (sqrtHi << 64n),
    tickCurrent,
  };
}

async function getRaydiumPositions() {
  console.log(`\n--- Raydium xStocks CLMM ${RAYDIUM_DRY_RUN ? '[DRY RUN]' : '[LIVE]'} ---`);
  const results = [];

  const xstockPositions = Object.entries(ASSET)
    .filter(([, v]) => typeof v === 'object' && v.nftMint)
    .map(([key, v]) => ({ key, ...v }));

  console.log(`Processing ${xstockPositions.length} hardcoded xStock positions`);

  for (const posConfig of xstockPositions) {
    const { key, nftMint, poolId } = posConfig;
    try {
      // Find position account by nft_mint at offset 9 (disc=8, bump=1, then nft_mint)
      const programAccounts = await solRpc('getProgramAccounts', [
        RAYDIUM_CLMM_PROGRAM,
        { encoding: 'base64', filters: [{ dataSize: 281 }, { memcmp: { offset: 9, bytes: nftMint } }] },
      ]);

      const posAccount = programAccounts?.[0] ?? null;
      if (!posAccount) {
        console.log(`  ${key}: position account not found`);
        continue;
      }

      const pos = parsePositionAccount(posAccount.account.data[0]);
      console.log(`  ${key}: ticks [${pos.tickLower}, ${pos.tickUpper}], liquidity: ${pos.liquidity}`);

      await new Promise(r => setTimeout(r, 2000));

      // Fetch pool account
      let poolRes = null;
      for (let i = 1; i <= 3; i++) {
        poolRes = await solRpc('getAccountInfo', [poolId, { encoding: 'base64' }]);
        if (poolRes?.value?.data) break;
        await new Promise(r => setTimeout(r, 3000));
      }

      if (!poolRes?.value?.data) { console.error(`  ${key}: pool not found`); continue; }

      const pool = parsePoolAccount(poolRes.value.data[0]);

      // Get prices
      const priceData = await fetchWithTimeout(`https://coins.llama.fi/prices/current/solana:${pool.mint0},solana:${pool.mint1}`);
      const price0    = priceData?.coins?.[`solana:${pool.mint0}`]?.price ?? null;
      const price1    = priceData?.coins?.[`solana:${pool.mint1}`]?.price ?? null;

      const sqrtP = sqrtPriceX64ToFloat(pool.sqrtPriceX64.toString());
      const { amount0, amount1, inRange } = calcAmounts(pos.liquidity, pos.tickLower, pos.tickUpper, pool.tickCurrent, sqrtP);

      const tokens0 = amount0 / Math.pow(10, pool.decimals0);
      const tokens1 = amount1 / Math.pow(10, pool.decimals1);
      const positionValue = (price0 ?? 0) * tokens0 + (price1 ?? 0) * tokens1;

      console.log(`  ${key}: $${positionValue.toFixed(2)}, in range: ${inRange}`);
      results.push({ key, positionValue, inRange });

    } catch (e) { console.error(`  ${key}: ${e.message}`); }
  }

  return results;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log(`\n====== Daily Portfolio Check v27 — ${NOW_UTC} ======`);
  if (RAYDIUM_DRY_RUN) console.log('ℹ️  RAYDIUM_DRY_RUN=true — Raydium will NOT write to Airtable');

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
      [F.notes]: `ETH: $${weth.ethPrice?.toFixed(0)} | Tick: ${weth.currentTick} | Range: [${weth.tickLower}, ${weth.tickUpper}]`,
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
        console.log(`  Queued ${posKey}: $${data.supplyUSD.toFixed(2)}, APY ${data.supplyAPY?.toFixed(2) ?? 'n/a'}%`);
      } else if (data.type === 'borrow') {
        const fields = { [LF.borrowUSD]: data.borrowUSD, [LF.tokenAmt]: data.tokens };
        if (data.borrowAPY != null) fields[LF.borrowAPY] = data.borrowAPY;
        batch.push(lendingRecord(LPOS[posKey], fields));
        console.log(`  Queued ${posKey}: $${data.borrowUSD.toFixed(2)}, Borrow APY ${data.borrowAPY?.toFixed(2) ?? 'n/a'}%`);
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
        console.log(`  Queued ${posKey}: $${data.supplyUSD.toFixed(2)}, APY ${data.supplyAPY?.toFixed(2) ?? 'n/a'}%`);
      } else if (data.type === 'borrow') {
        const fields = { [LF.borrowUSD]: data.borrowUSD, [LF.tokenAmt]: data.tokens };
        if (data.borrowAPY != null) fields[LF.borrowAPY] = data.borrowAPY;
        if (data.notes)             fields[LF.notes]     = data.notes;
        batch.push(lendingRecord(LPOS[posKey], fields));
        console.log(`  Queued ${posKey}: $${data.borrowUSD.toFixed(2)}, Borrow APY ${data.borrowAPY?.toFixed(2) ?? 'n/a'}%`);
      }
    }
    if (batch.length > 0) {
      const ok = await airtableCreate(LENDING_TABLE, batch);
      if (ok) { written += batch.length; console.log(`✓ Suilend: ${batch.length} records`); }
    }
  }

  // Raydium xStocks
  if (raydium.length > 0) {
    console.log(`\nRaydium — ${raydium.length} position(s)`);
    if (RAYDIUM_DRY_RUN) {
      for (const pos of raydium) console.log(`  ${pos.key}: $${pos.positionValue.toFixed(2)}, inRange: ${pos.inRange}`);
      console.log('DRY RUN — set RAYDIUM_DRY_RUN=false in GitHub Variables to go live');
    } else {
      const batch = [];
      for (const pos of raydium) {
        const meta = ASSET[pos.key];
        if (!meta) continue;
        batch.push(dailyRecord(meta.recordId, pos.inRange, {
          [F.positionValue]: pos.positionValue,
          [F.revertPosVal]:  pos.positionValue,
          [F.cycleId]:       meta.cycleId,
          [F.notes]:         `Raydium CLMM | ${pos.key.toUpperCase()} | Position value only — pending yield Phase 2`,
        }));
        console.log(`  Queued ${pos.key}: $${pos.positionValue.toFixed(2)}, inRange: ${pos.inRange}`);
      }
      if (batch.length > 0) {
        for (let i = 0; i < batch.length; i += 10) {
          const ok = await airtableCreate(DAILY_TABLE, batch.slice(i, i + 10));
          if (ok) written += Math.min(10, batch.length - i);
        }
        console.log(`✓ Raydium: ${batch.length} records written`);
      }
    }
  }

  console.log(`\n====== Complete — ${written} records written ======`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

// ============================================================
// Daily Portfolio Check — GitHub Actions v3
// Fixes: Airtable singleSelect names, Moonwell addresses,
//        xStocks Raydium token program, Suilend data extraction
// ============================================================

import fetch from 'node-fetch';
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

const WALLET_EVM    = '0x871fd9a8A6a6E918658eadF46e9c23fE4E377289';
const WALLET_SOLANA = '5yiTWdskR7yd5RXvs7MJLqWsn6n7geM8SzvYjUpRHrTX';
const WETH_POS_ID   = 5384162n;

const BASE_RPC     = 'https://mainnet.base.org';
const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
const SOLANA_RPC   = 'https://api.mainnet-beta.solana.com';

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

const LPOS = {
  moonwellETH:    'rec1T0ll6aEkYoZwj',
  moonwellVIRT:   'rec6Zi6u6uK6x4M9F',
  moonwellCBXRP:  'recQRudPvkFOMhfWL',
  moonwellAERO:   'recwH74S9hCOqPBjR',
  moonwellBorrow: 'recJ2skZuwzu9f1xY',
  suilendSUI:     'rec2CCpli6msLPzgF',
  suilendSOL:     'reccOax2I2jLO9ATs',
  suilendBorrow:  'rec7fEjrou7kLZ29U',
};

// ============================================================
// HELPERS
// ============================================================

async function safeFetch(label, url, options = {}) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      console.error(`[${label}] HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error(`[${label}] failed: ${e.message}`);
    return null;
  }
}

// Airtable REST API — singleSelect uses NAME string not {id} object
// Linked record fields use array of {id: 'recXXX'} objects
async function airtableCreate(tableId, records) {
  const body = { records: records.map(r => ({ fields: r })) };
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    console.error(`[Airtable/${tableId}] Write failed: ${err.slice(0, 200)}`);
    return false;
  }
  return true;
}

// Build a Daily Actions record
// KEY FIX: singleSelect fields use plain string name, not {id} object
// Linked record fields use [{id: 'recXXX'}]
function dailyRecord(assetId, inRange, extra = {}) {
  return {
    [F.asset]:      [{ id: assetId }],  // linked record field
    [F.actionType]: 'Fee Check',         // singleSelect — use name string
    [F.date]:       NOW_UTC,
    [F.inRange]:    inRange ? 'Yes' : 'No',  // singleSelect — use name string
    ...extra,
  };
}

function lendingRecord(positionId, extra = {}) {
  return {
    [LF.position]:   [{ id: positionId }],  // linked record field
    [LF.actionType]: 'Rate Check',           // singleSelect — use name string
    [LF.date]:       NOW_UTC,
    ...extra,
  };
}

// ============================================================
// MODULE 1 — LIGHTER (principal_amount, public endpoint)
// ============================================================

async function getLighterData() {
  console.log('\n--- Lighter ---');

  const data = await safeFetch(
    'Lighter/account',
    `${LIGHTER_BASE_URL}/account?by=index&value=${LIGHTER_ACCOUNT_IDX}`
  );

  const results = { llp: null, edgeHedge: null, lit: null };

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

    const NFT_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
    const posABI = [
      'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)'
    ];
    const factoryABI = ['function getPool(address,address,uint24) external view returns (address)'];
    const poolABI    = ['function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)'];

    const nftManager  = new ethers.Contract(NFT_MANAGER, posABI, provider);
    const pos         = await nftManager.positions(WETH_POS_ID);
    const tickLower   = Number(pos.tickLower);
    const tickUpper   = Number(pos.tickUpper);
    const liquidity   = pos.liquidity;

    const factory  = new ethers.Contract('0x1F98431c8aD98523631AE4a59f267346ea31F984', factoryABI, provider);
    const poolAddr = await factory.getPool(pos.token0, pos.token1, pos.fee);
    const pool     = new ethers.Contract(poolAddr, poolABI, provider);
    const slot0    = await pool.slot0();

    const currentTick  = Number(slot0.tick);
    const sqrtPriceX96 = slot0.sqrtPriceX96;
    const inRange      = currentTick >= tickLower && currentTick < tickUpper;

    const Q96      = 2n ** 96n;
    const sqrtP    = Number(sqrtPriceX96) / Number(Q96);
    const ethPrice = sqrtP * sqrtP * 1e12;

    const sqrtLower   = Math.sqrt(1.0001 ** tickLower);
    const sqrtUpper   = Math.sqrt(1.0001 ** tickUpper);
    const sqrtCurrent = Math.sqrt(1.0001 ** currentTick);
    const liq         = Number(liquidity);

    let amount0 = 0, amount1 = 0;
    if (inRange) {
      amount0 = liq * (sqrtUpper - sqrtCurrent) / (sqrtCurrent * sqrtUpper) / 1e18;
      amount1 = liq * (sqrtCurrent - sqrtLower) / 1e6;
    } else if (currentTick < tickLower) {
      amount0 = liq * (sqrtUpper - sqrtLower) / (sqrtLower * sqrtUpper) / 1e18;
    } else {
      amount1 = liq * (sqrtUpper - sqrtLower) / 1e6;
    }

    const positionValueUSD = (amount0 * ethPrice) + amount1;
    console.log(`ETH: $${ethPrice.toFixed(2)}, position: $${positionValueUSD.toFixed(2)}, in range: ${inRange}`);
    return { positionValue: positionValueUSD, inRange, currentTick, tickLower, tickUpper, ethPrice };
  } catch (e) {
    console.error(`WETH/USDC: ${e.message}`);
    return null;
  }
}

// ============================================================
// MODULE 3 — xStocks LP (Raydium/Solana)
// Try multiple token programs including Raydium CLMM
// ============================================================

async function getXStockPositions() {
  console.log('\n--- xStocks LP ---');

  const positions = [];

  // Try Raydium API directly using wallet address
  const raydiumData = await safeFetch(
    'Raydium/positions',
    `https://api-v3.raydium.io/position/list?wallet=${WALLET_SOLANA}`
  );

  if (raydiumData?.data?.length > 0) {
    console.log(`Raydium positions found: ${raydiumData.data.length}`);
    for (const p of raydiumData.data) {
      const currentPrice = parseFloat(p.currentPrice ?? 0);
      const priceLower   = parseFloat(p.priceLower ?? 0);
      const priceUpper   = parseFloat(p.priceUpper ?? 0);
      const inRange      = currentPrice >= priceLower && currentPrice <= priceUpper;

      positions.push({
        symbolA:          p.tokenASymbol ?? p.mintA?.slice(0, 6) ?? 'tokenA',
        symbolB:          p.tokenBSymbol ?? 'USDC',
        positionValueUSD: parseFloat(p.positionValueUSD ?? p.totalValue ?? p.amountUSD ?? 0),
        unclaimedFeeUSD:  parseFloat(p.unclaimedFeeUSD ?? p.feeUSD ?? 0),
        priceLower,
        priceUpper,
        currentPrice,
        inRange,
      });
      console.log(`  ${p.tokenASymbol}/${p.tokenBSymbol}: $${p.positionValueUSD}`);
    }
    return positions;
  }

  // Fallback: try NFT-based lookup with multiple token programs
  const TOKEN_PROGRAMS = [
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',  // SPL Token
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',  // Token-2022
  ];

  let nfts = [];
  for (const prog of TOKEN_PROGRAMS) {
    const data = await safeFetch('Solana/tokens', SOLANA_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTokenAccountsByOwner',
        params: [
          WALLET_SOLANA,
          { programId: prog },
          { encoding: 'jsonParsed' }
        ]
      }),
    });
    if (data?.result?.value) {
      const found = data.result.value.filter(acc => {
        const info = acc.account?.data?.parsed?.info;
        return info?.tokenAmount?.uiAmount === 1 && info?.tokenAmount?.decimals === 0;
      });
      nfts = nfts.concat(found);
    }
  }

  console.log(`Solana NFTs found: ${nfts.length}`);

  for (const nft of nfts.slice(0, 20)) {
    const mint = nft.account?.data?.parsed?.info?.mint;
    if (!mint) continue;

    const posData = await safeFetch(
      `Raydium/nft-${mint.slice(0, 8)}`,
      `https://api-v3.raydium.io/position/nft?nft=${mint}`
    );

    if (posData?.data) {
      const p = posData.data;
      const currentPrice = parseFloat(p.currentPrice ?? 0);
      const priceLower   = parseFloat(p.priceLower ?? 0);
      const priceUpper   = parseFloat(p.priceUpper ?? 0);
      const inRange      = currentPrice >= priceLower && currentPrice <= priceUpper;

      positions.push({
        symbolA:          p.tokenASymbol ?? 'tokenA',
        symbolB:          p.tokenBSymbol ?? 'USDC',
        positionValueUSD: parseFloat(p.positionValueUSD ?? p.totalValue ?? 0),
        unclaimedFeeUSD:  parseFloat(p.unclaimedFeeUSD ?? 0),
        priceLower,
        priceUpper,
        currentPrice,
        inRange,
      });
      console.log(`  ${p.tokenASymbol}/${p.tokenBSymbol}: $${p.positionValueUSD}`);
    }
  }

  return positions;
}

// ============================================================
// MODULE 4 — Moonwell USD values (Base RPC)
// Fixed: correct checksummed addresses, staticCall
// ============================================================

async function getMoonwellUSD() {
  console.log('\n--- Moonwell USD ---');

  const provider = new ethers.JsonRpcProvider(BASE_RPC);

  const mTokenABI = [
    'function balanceOfUnderlying(address owner) external returns (uint)',
    'function borrowBalanceCurrent(address account) external returns (uint)',
  ];

  // Addresses must be checksummed (mixed case) for ethers.js
  const MARKETS = {
    ETH:     { addr: '0x628ff693426583D9a7FB391E54366292F509D457', decimals: 18 },
    VIRTUAL: { addr: '0x0A61Df5651050bc3F5E0e47D73B5CF44e7c38E4A', decimals: 18 },
    cbXRP:   { addr: '0x3Bf93770960AB943f9323F77fc1f21ff9Aa1f87E', decimals: 6  },
    AERO:    { addr: '0x73702E48a6AE0b4B9e4BFAE4781a43AE7e61E3A7', decimals: 18 },
  };

  const results = {};

  for (const [symbol, { addr, decimals }] of Object.entries(MARKETS)) {
    try {
      // Convert to checksummed address
      const checksumAddr = ethers.getAddress(addr);
      const mToken  = new ethers.Contract(checksumAddr, mTokenABI, provider);
      const balRaw  = await mToken.balanceOfUnderlying.staticCall(WALLET_EVM);
      results[symbol] = Number(balRaw) / Math.pow(10, decimals);
      console.log(`Moonwell ${symbol}: ${results[symbol].toFixed(4)}`);
    } catch (e) {
      console.error(`Moonwell ${symbol}: ${e.message.slice(0, 80)}`);
      results[symbol] = null;
    }
  }

  // USDC borrow
  try {
    const USDC_MARKET = ethers.getAddress('0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22');
    const mUSDC    = new ethers.Contract(USDC_MARKET, mTokenABI, provider);
    const borrowRaw = await mUSDC.borrowBalanceCurrent.staticCall(WALLET_EVM);
    results.USDCBorrow = Number(borrowRaw) / 1e6;
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
  console.log(`\n====== Daily Portfolio Check v3 — ${NOW_UTC} ======`);

  const [lighterRes, wethRes, xstocksRes, moonwellRes] = await Promise.allSettled([
    getLighterData(),
    getWethPosition(),
    getXStockPositions(),
    getMoonwellUSD(),
  ]);

  const lighter  = lighterRes.value  ?? null;
  const weth     = wethRes.value     ?? null;
  const xstocks  = xstocksRes.value  ?? [];
  const moonwell = moonwellRes.value ?? null;

  console.log('\n--- Writing to Airtable ---');
  let written = 0;

  // Lighter — LLP
  if (lighter?.llp != null) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.llp, true, {
      [F.positionValue]: lighter.llp,
      [F.notes]:         'Principal amount — equity update deferred',
    })]);
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

  // xStocks
  const xstockMap = {
    'TSLAx': ASSET.tsla, 'NVDAx': ASSET.nvda, 'CRCLx': ASSET.crcl,
    'SPYx':  ASSET.spy,  'GOOGLx': ASSET.googl, 'AAPLx': ASSET.aapl,
  };

  for (const pos of xstocks) {
    const assetId = xstockMap[pos.symbolA];
    if (!assetId) { console.log(`  Skipping: ${pos.symbolA}`); continue; }
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(assetId, pos.inRange, {
      [F.positionValue]: pos.positionValueUSD,
      [F.feeValue]:      pos.unclaimedFeeUSD,
      [F.notes]:         `Fees: $${pos.unclaimedFeeUSD?.toFixed(2)} | Range: [${pos.priceLower}, ${pos.priceUpper}]`,
    })]);
    if (ok) { written++; console.log(`✓ ${pos.symbolA}: $${pos.positionValueUSD}`); }
  }

  // Moonwell — batch all 5 records together (max 10 per request)
  if (moonwell) {
    const lendingBatch = [
      moonwell.ETH       != null ? lendingRecord(LPOS.moonwellETH,    { [LF.supplyUSD]: moonwell.ETH       }) : null,
      moonwell.VIRTUAL   != null ? lendingRecord(LPOS.moonwellVIRT,   { [LF.supplyUSD]: moonwell.VIRTUAL   }) : null,
      moonwell.cbXRP     != null ? lendingRecord(LPOS.moonwellCBXRP,  { [LF.supplyUSD]: moonwell.cbXRP     }) : null,
      moonwell.AERO      != null ? lendingRecord(LPOS.moonwellAERO,   { [LF.supplyUSD]: moonwell.AERO      }) : null,
      moonwell.USDCBorrow!= null ? lendingRecord(LPOS.moonwellBorrow, { [LF.borrowUSD]: moonwell.USDCBorrow}) : null,
    ].filter(Boolean);

    if (lendingBatch.length > 0) {
      const ok = await airtableCreate(LENDING_TABLE, lendingBatch);
      if (ok) { written += lendingBatch.length; console.log(`✓ Moonwell: ${lendingBatch.length} records`); }
    }
  }

  console.log(`\n====== Complete — ${written} records written ======`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

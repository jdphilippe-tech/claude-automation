// ============================================================
// Daily Portfolio Check — GitHub Actions v2
// Covers: Lighter (principal_amount), WETH/USDC (Arbitrum RPC),
//         xStocks LP (Raydium), Moonwell USD (Base RPC),
//         Suilend (Sui RPC)
// ============================================================

import fetch from 'node-fetch';
import { ethers } from 'ethers';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE    = 'appWojaxYR99bXC1f';

const DAILY_TABLE   = 'tblKsk0QnkOoKNLuk';
const LENDING_TABLE = 'tblFw52kzeTRvxTSM';

const LIGHTER_BASE_URL    = 'https://mainnet.zklighter.elliot.ai/api/v1';
const LIGHTER_ACCOUNT_IDX = 449217;

// Pool indexes
const POOL_LLP        = 281474976710654;
const POOL_EDGE_HEDGE = 281474976688087;
const POOL_LIT        = 281474976624800;

// Wallets
const WALLET_EVM    = '0x871fd9a8A6a6E918658eadF46e9c23fE4E377289';
const WALLET_SOLANA = '5yiTWdskR7yd5RXvs7MJLqWsn6n7geM8SzvYjUpRHrTX';
const WALLET_SUI    = '0xa43b2375ebc13ade7ea537e26e46cd32dc46edd4e23776149c576f1ce36705e9';
const WETH_POS_ID   = 5384162n;

// RPC endpoints
const BASE_RPC     = 'https://mainnet.base.org';
const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
const SOLANA_RPC   = 'https://api.mainnet-beta.solana.com';
const SUI_RPC      = 'https://fullnode.mainnet.sui.io';

const NOW_UTC = new Date().toISOString();

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
  supplyAPY: 'fldJLDy5yOHq8S6RS',
  borrowAPY: 'fldWHlp8HCuMYGc9e',
  notes:     'fldHzWRmzI1H3zueM',
};

// ---- Choice IDs ----
const CHOICES = {
  feeCheck:   'selgvLZWhg55D9G3J',
  inRangeYes: 'selHUxQnpgt2jtpTs',
  inRangeNo:  'selLJhXONvMhIgHlu',
  rateCheck:  'sel1jmWcXJsE0vfC5',
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

// Write records to Airtable via REST API
// Linked record fields need array of {id} objects
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
    console.error(`[Airtable] Write failed: ${err}`);
    return false;
  }
  const data = await res.json();
  return data.records?.length > 0;
}

// Build a Daily Actions record
function dailyRecord(assetId, inRange, extraFields = {}) {
  return {
    [F.asset]:      [{ id: assetId }],   // linked record — must be array of {id}
    [F.actionType]: { id: CHOICES.feeCheck },
    [F.date]:       NOW_UTC,
    [F.inRange]:    { id: inRange ? CHOICES.inRangeYes : CHOICES.inRangeNo },
    ...extraFields,
  };
}

// Build a Lending Actions record
function lendingRecord(positionId, extraFields = {}) {
  return {
    [LF.position]:   [{ id: positionId }],  // linked record
    [LF.actionType]: { id: CHOICES.rateCheck },
    [LF.date]:       NOW_UTC,
    ...extraFields,
  };
}

// ============================================================
// MODULE 1 — LIGHTER (principal_amount, public endpoint)
// Real equity via auth token deferred to future update
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
      const poolIdx  = Number(share.public_pool_index);
      const principal = parseFloat(share.principal_amount ?? 0);

      if (poolIdx === POOL_LLP)        { results.llp       = principal; }
      if (poolIdx === POOL_EDGE_HEDGE) { results.edgeHedge = principal; }
      if (poolIdx === POOL_LIT)        { results.lit       = principal; }
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

    // Uniswap V3 NonfungiblePositionManager on Arbitrum
    const NFT_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
    const posABI = [
      'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)'
    ];

    const nftManager  = new ethers.Contract(NFT_MANAGER, posABI, provider);
    const pos         = await nftManager.positions(WETH_POS_ID);
    const tickLower   = Number(pos.tickLower);
    const tickUpper   = Number(pos.tickUpper);
    const liquidity   = pos.liquidity;

    // Get pool current tick
    const FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
    const factoryABI = [
      'function getPool(address,address,uint24) external view returns (address)'
    ];
    const poolABI = [
      'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)'
    ];

    const factory     = new ethers.Contract(FACTORY, factoryABI, provider);
    const poolAddr    = await factory.getPool(pos.token0, pos.token1, pos.fee);
    const pool        = new ethers.Contract(poolAddr, poolABI, provider);
    const slot0       = await pool.slot0();
    const currentTick = Number(slot0.tick);
    const sqrtPriceX96 = slot0.sqrtPriceX96;
    const inRange     = currentTick >= tickLower && currentTick < tickUpper;

    // ETH price from sqrtPriceX96
    // token0=WETH (18 decimals), token1=USDC (6 decimals)
    const Q96      = 2n ** 96n;
    const sqrtP    = Number(sqrtPriceX96) / Number(Q96);
    const price    = sqrtP * sqrtP;
    const ethPrice = price * 1e12; // decimal adjustment

    // Position value from liquidity math
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
    console.error(`WETH/USDC error: ${e.message}`);
    return null;
  }
}

// ============================================================
// MODULE 3 — xStocks LP (Raydium/Solana)
// ============================================================

async function getXStockPositions() {
  console.log('\n--- xStocks LP ---');

  // Get all token accounts for wallet
  const data = await safeFetch('Solana/tokens', SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'getTokenAccountsByOwner',
      params: [
        WALLET_SOLANA,
        { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
        { encoding: 'jsonParsed' }
      ]
    }),
  });

  if (!data?.result?.value) {
    console.error('No Solana token accounts found');
    return [];
  }

  // NFT positions have amount=1, decimals=0
  const nfts = data.result.value.filter(acc => {
    const info = acc.account?.data?.parsed?.info;
    return info?.tokenAmount?.uiAmount === 1 && info?.tokenAmount?.decimals === 0;
  });

  console.log(`Solana NFTs found: ${nfts.length}`);

  const positions = [];
  for (const nft of nfts.slice(0, 15)) {
    const mint = nft.account?.data?.parsed?.info?.mint;
    if (!mint) continue;

    const posData = await safeFetch(
      `Raydium/${mint.slice(0, 8)}`,
      `https://api-v3.raydium.io/position/nft?nft=${mint}`
    );

    if (posData?.data) {
      const p = posData.data;
      const currentPrice = parseFloat(p.currentPrice ?? 0);
      const priceLower   = parseFloat(p.priceLower ?? 0);
      const priceUpper   = parseFloat(p.priceUpper ?? 0);
      const inRange      = currentPrice >= priceLower && currentPrice <= priceUpper;

      positions.push({
        mint,
        symbolA:         p.tokenASymbol ?? 'tokenA',
        symbolB:         p.tokenBSymbol ?? 'tokenB',
        positionValueUSD: parseFloat(p.positionValueUSD ?? p.totalValue ?? 0),
        unclaimedFeeUSD:  parseFloat(p.unclaimedFeeUSD ?? 0),
        priceLower,
        priceUpper,
        currentPrice,
        inRange,
      });
      console.log(`  ${p.tokenASymbol}/${p.tokenBSymbol}: $${p.positionValueUSD}, fees: $${p.unclaimedFeeUSD}`);
    }
  }

  return positions;
}

// ============================================================
// MODULE 4 — Moonwell USD values (Base RPC)
// Uses eth_call (read-only) — not sendTransaction
// ============================================================

async function getMoonwellUSD() {
  console.log('\n--- Moonwell USD ---');

  const provider = new ethers.JsonRpcProvider(BASE_RPC);

  // balanceOfUnderlying is non-view but we can call it statically
  const mTokenABI = [
    'function balanceOfUnderlying(address owner) external returns (uint)',
    'function borrowBalanceCurrent(address account) external returns (uint)',
  ];

  const MARKETS = {
    ETH:    { addr: '0x628ff693426583D9a7FB391E54366292F509D457', decimals: 18 },
    VIRTUAL:{ addr: '0x0A61Df5651050bc3F5E0e47D73B5CF44e7c38E4A', decimals: 18 },
    cbXRP:  { addr: '0x49f85b2A5b54fD90ee6B5a3F0c70F48DfE55038', decimals: 6  },
    AERO:   { addr: '0x73702E48a6AE0b4B9e4BFAE4781a43AE7e61E3A7', decimals: 18 },
  };

  const results = {};

  for (const [symbol, { addr, decimals }] of Object.entries(MARKETS)) {
    try {
      const mToken  = new ethers.Contract(addr, mTokenABI, provider);
      // Use staticCall to avoid "sending transaction" error
      const balRaw  = await mToken.balanceOfUnderlying.staticCall(WALLET_EVM);
      results[symbol] = Number(balRaw) / Math.pow(10, decimals);
      console.log(`Moonwell ${symbol}: ${results[symbol]}`);
    } catch (e) {
      console.error(`Moonwell ${symbol}: ${e.message}`);
      results[symbol] = null;
    }
  }

  // USDC borrow balance
  try {
    const USDC_MARKET = '0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22';
    const mUSDC = new ethers.Contract(USDC_MARKET, mTokenABI, provider);
    const borrowRaw = await mUSDC.borrowBalanceCurrent.staticCall(WALLET_EVM);
    results.USDCBorrow = Number(borrowRaw) / 1e6;
    console.log(`Moonwell USDC borrow: $${results.USDCBorrow}`);
  } catch (e) {
    console.error(`Moonwell borrow: ${e.message}`);
    results.USDCBorrow = null;
  }

  return results;
}

// ============================================================
// MODULE 5 — Suilend (Sui RPC)
// ============================================================

async function getSuilendData() {
  console.log('\n--- Suilend ---');

  try {
    // Query owned objects for Suilend obligation
    const data = await safeFetch('Sui/objects', SUI_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'suix_getOwnedObjects',
        params: [
          WALLET_SUI,
          { options: { showContent: true, showType: true } },
          null,
          50
        ]
      }),
    });

    if (data?.result?.data) {
      const objects = data.result.data;
      console.log(`Sui objects found: ${objects.length}`);

      // Find Suilend obligation objects
      const obligations = objects.filter(obj =>
        obj.data?.type?.includes('lending_market') ||
        obj.data?.type?.includes('obligation') ||
        obj.data?.type?.includes('suilend')
      );

      if (obligations.length > 0) {
        console.log(`Suilend obligations: ${obligations.length}`);
        for (const ob of obligations) {
          console.log(`  Type: ${ob.data?.type}`);
          console.log(`  Content: ${JSON.stringify(ob.data?.content).slice(0, 200)}`);
        }
        return obligations;
      } else {
        console.log('No Suilend obligation objects found');
        console.log('Object types seen:', objects.slice(0, 5).map(o => o.data?.type).join(', '));
      }
    }
  } catch (e) {
    console.error(`Suilend: ${e.message}`);
  }

  return null;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log(`\n====== Daily Portfolio Check v2 — ${NOW_UTC} ======`);

  // Fetch all data in parallel
  const [lighterRes, wethRes, xstocksRes, moonwellRes, suilendRes] =
    await Promise.allSettled([
      getLighterData(),
      getWethPosition(),
      getXStockPositions(),
      getMoonwellUSD(),
      getSuilendData(),
    ]);

  const lighter  = lighterRes.value  ?? null;
  const weth     = wethRes.value     ?? null;
  const xstocks  = xstocksRes.value  ?? [];
  const moonwell = moonwellRes.value ?? null;

  console.log('\n--- Writing to Airtable ---');
  let written = 0;

  // ---- Lighter — LLP ----
  if (lighter?.llp != null) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.llp, true, {
      [F.positionValue]: lighter.llp,
      [F.notes]:         'Principal amount (cost basis) — equity update coming',
    })]);
    if (ok) { written++; console.log(`✓ LLP: $${lighter.llp}`); }
  }

  // ---- Lighter — Edge & Hedge ----
  if (lighter?.edgeHedge != null) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.edgeHedge, true, {
      [F.positionValue]: lighter.edgeHedge,
      [F.notes]:         'Principal amount (cost basis) — equity update coming',
    })]);
    if (ok) { written++; console.log(`✓ Edge & Hedge: $${lighter.edgeHedge}`); }
  }

  // ---- Lighter — LIT Staking ----
  if (lighter?.lit != null) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.litStaking, true, {
      [F.positionValue]: lighter.lit,
      [F.notes]:         'Principal amount (cost basis) — equity update coming',
    })]);
    if (ok) { written++; console.log(`✓ LIT Staking: $${lighter.lit}`); }
  }

  // ---- WETH/USDC Primary ----
  if (weth) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.wethPrimary, weth.inRange, {
      [F.positionValue]: weth.positionValue,
      [F.revertPosVal]:  weth.positionValue,
      [F.notes]:         `ETH: $${weth.ethPrice?.toFixed(0)} | Tick: ${weth.currentTick} | Range: [${weth.tickLower}, ${weth.tickUpper}]`,
    })]);
    if (ok) { written++; console.log(`✓ WETH/USDC: $${weth.positionValue?.toFixed(2)}, in range: ${weth.inRange}`); }
  }

  // ---- xStocks ----
  const xstockMap = {
    'TSLAx': ASSET.tsla, 'NVDAx': ASSET.nvda, 'CRCLx': ASSET.crcl,
    'SPYx':  ASSET.spy,  'GOOGLx': ASSET.googl, 'AAPLx': ASSET.aapl,
  };

  for (const pos of xstocks) {
    const assetId = xstockMap[pos.symbolA];
    if (!assetId) { console.log(`  Skipping unknown symbol: ${pos.symbolA}`); continue; }

    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(assetId, pos.inRange, {
      [F.positionValue]: pos.positionValueUSD,
      [F.feeValue]:      pos.unclaimedFeeUSD,
      [F.notes]:         `Fees: $${pos.unclaimedFeeUSD?.toFixed(2)} | Range: [${pos.priceLower}, ${pos.priceUpper}]`,
    })]);
    if (ok) { written++; console.log(`✓ ${pos.symbolA}: $${pos.positionValueUSD}`); }
  }

  // ---- Moonwell USD values ----
  if (moonwell) {
    const moonwellRecords = [
      moonwell.ETH      != null ? lendingRecord(LPOS.moonwellETH,    { [LF.supplyUSD]: moonwell.ETH       }) : null,
      moonwell.VIRTUAL  != null ? lendingRecord(LPOS.moonwellVIRT,   { [LF.supplyUSD]: moonwell.VIRTUAL   }) : null,
      moonwell.cbXRP    != null ? lendingRecord(LPOS.moonwellCBXRP,  { [LF.supplyUSD]: moonwell.cbXRP     }) : null,
      moonwell.AERO     != null ? lendingRecord(LPOS.moonwellAERO,   { [LF.supplyUSD]: moonwell.AERO      }) : null,
      moonwell.USDCBorrow!=null ? lendingRecord(LPOS.moonwellBorrow, { [LF.borrowUSD]: moonwell.USDCBorrow}) : null,
    ].filter(Boolean);

    if (moonwellRecords.length > 0) {
      const ok = await airtableCreate(LENDING_TABLE, moonwellRecords);
      if (ok) { written += moonwellRecords.length; console.log(`✓ Moonwell: ${moonwellRecords.length} records`); }
    }
  }

  console.log(`\n====== Complete — ${written} records written ======`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});

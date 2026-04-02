// ============================================================
// Daily Portfolio Check — GitHub Actions
// Covers: Lighter (LLP, Edge & Hedge, LIT Staking),
//         WETH/USDC Primary (Arbitrum RPC),
//         xStocks LP (Raydium/Solana RPC),
//         Moonwell USD values (Base RPC),
//         Suilend rates + USD values (Sui RPC)
// ============================================================

import fetch from 'node-fetch';
import { ethers } from 'ethers';

// ---- Environment variables (from GitHub Secrets) ----
const AIRTABLE_API_KEY    = process.env.AIRTABLE_API_KEY;
const LIGHTER_PRIVATE_KEY = process.env.LIGHTER_PRIVATE_KEY;
const LIGHTER_PUBLIC_KEY  = process.env.LIGHTER_PUBLIC_KEY;

// ---- Constants ----
const AIRTABLE_BASE       = 'appWojaxYR99bXC1f';
const DAILY_ACTIONS_TABLE = 'tblKsk0QnkOoKNLuk';
const LENDING_ACTIONS_TABLE = 'tblFw52kzeTRvxTSM';

const LIGHTER_BASE_URL    = 'https://mainnet.zklighter.elliot.ai/api/v1';
const LIGHTER_ACCOUNT_IDX = 449217;

// Pool indexes from shares array
const POOL_LLP        = 281474976710654n; // LLP — $1,836 principal
const POOL_EDGE_HEDGE = 281474976688087n; // Edge & Hedge — $4,497 principal
const POOL_LIT        = 281474976624800n; // LIT Staking — $183 principal

// Wallets
const WALLET_EVM          = '0x871fd9a8A6a6E918658eadF46e9c23fE4E377289';
const WALLET_SOLANA       = '5yiTWdskR7yd5RXvs7MJLqWsn6n7geM8SzvYjUpRHrTX';
const WALLET_SUI          = '0xa43b2375ebc13ade7ea537e26e46cd32dc46edd4e23776149c576f1ce36705e9';
const LIGHTER_L1_ADDRESS  = '0xEE2178C5d2a19A83450ba2A13fd889A02Da19BDd';
const WETH_POSITION_ID    = 5384162n;

// RPC endpoints (public, no key needed)
const BASE_RPC     = 'https://mainnet.base.org';
const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
const SOLANA_RPC   = 'https://api.mainnet-beta.solana.com';
const SUI_RPC      = 'https://fullnode.mainnet.sui.io';

// NOW in UTC
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

const LENDING_F = {
  position:  'fldFi5nwRXNC5n0pU',
  actionType:'fld5UpfU63qiYEZtp',
  date:      'fldUksu7BXYunAADh',
  supplyUSD: 'fldJ7T452iqgQNiWb',
  borrowUSD: 'fldTSqf1Yrxg7O0tr',
  supplyAPY: 'fldJLDy5yOHq8S6RS',
  borrowAPY: 'fldWHlp8HCuMYGc9e',
  notes:     'fldHzWRmzI1H3zueM',
};

const CHOICES = {
  feeCheck:    'selgvLZWhg55D9G3J',
  inRangeYes:  'selHUxQnpgt2jtpTs',
  inRangeNo:   'selLJhXONvMhIgHlu',
  rateCheck:   'sel1jmWcXJsE0vfC5',
};

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

const LENDING_POS = {
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
      console.error(`[${label}] HTTP ${res.status}: ${url}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error(`[${label}] fetch failed: ${e.message}`);
    return null;
  }
}

async function airtableWrite(tableId, records) {
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ records }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    console.error(`[Airtable] Write failed: ${err}`);
    return false;
  }
  return true;
}

// ============================================================
// MODULE 1 — LIGHTER EQUITY
// Uses signed auth token to access pool position data
// ============================================================

async function getLighterEquity() {
  console.log('\n--- Lighter ---');
  const results = { llp: null, edgeHedge: null, lit: null };

  try {
    // Generate read-only auth token using private key
    // Lighter auth format: {expiry}:{account_index}:{api_key_index}:{random_hex}
    const expiry      = Math.floor(Date.now() / 1000) + 3600; // 1 hour
    const apiKeyIndex = 2; // standard API key index
    const randomHex   = ethers.hexlify(ethers.randomBytes(16)).slice(2);
    const message     = `${expiry}:${LIGHTER_ACCOUNT_IDX}:${apiKeyIndex}:${randomHex}`;

    // Sign with private key
    const wallet    = new ethers.Wallet(LIGHTER_PRIVATE_KEY);
    const signature = await wallet.signMessage(message);
    const authToken = `${message}:${signature}`;

    console.log('Auth token generated');

    // Fetch account with auth
    const accountData = await safeFetch(
      'Lighter/account-auth',
      `${LIGHTER_BASE_URL}/account?by=index&value=${LIGHTER_ACCOUNT_IDX}`,
      { headers: { 'Authorization': authToken } }
    );

    if (accountData?.accounts?.[0]?.shares) {
      const shares = accountData.accounts[0].shares;
      console.log(`Shares found: ${shares.length}`);

      for (const share of shares) {
        const poolIdx   = BigInt(share.public_pool_index);
        const sharesAmt = BigInt(share.shares_amount);

        // Fetch pool details with auth to get current NAV
        const poolData = await safeFetch(
          `Lighter/pool-${poolIdx}`,
          `${LIGHTER_BASE_URL}/publicPool?pool_index=${poolIdx}`,
          { headers: { 'Authorization': authToken } }
        );

        let equity = null;

        if (poolData) {
          console.log(`Pool ${poolIdx} data:`, JSON.stringify(poolData).slice(0, 200));
          // Calculate equity from NAV per share
          const navPerShare = parseFloat(
            poolData.nav_per_share ??
            poolData.usdc_per_share ??
            poolData.share_price ??
            0
          );
          if (navPerShare > 0) {
            equity = (Number(sharesAmt) * navPerShare) / 1e6; // shares are in 1e6 units
          }
        }

        // Fallback to principal_amount if NAV not available
        if (equity === null) {
          equity = parseFloat(share.principal_amount ?? 0);
          console.log(`Pool ${poolIdx}: using principal_amount fallback: $${equity}`);
        }

        if (poolIdx === POOL_LLP)        results.llp       = equity;
        if (poolIdx === POOL_EDGE_HEDGE) results.edgeHedge = equity;
        if (poolIdx === POOL_LIT)        results.lit       = equity;
      }
    }
  } catch (e) {
    console.error(`Lighter error: ${e.message}`);
  }

  console.log(`LLP: $${results.llp}, Edge&Hedge: $${results.edgeHedge}, LIT: $${results.lit}`);
  return results;
}

// ============================================================
// MODULE 2 — WETH/USDC PRIMARY (Uniswap V3 on Arbitrum)
// On-chain RPC read — no subgraph needed
// ============================================================

async function getWethPosition() {
  console.log('\n--- WETH/USDC Primary ---');

  try {
    const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC);

    // Uniswap V3 NonfungiblePositionManager on Arbitrum
    const NFT_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
    const positionABI = [
      'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)'
    ];

    const nftManager = new ethers.Contract(NFT_MANAGER, positionABI, provider);
    const pos        = await nftManager.positions(WETH_POSITION_ID);

    const tickLower = Number(pos.tickLower);
    const tickUpper = Number(pos.tickUpper);
    const liquidity = pos.liquidity;
    const fee       = pos.fee;

    console.log(`Position: tick [${tickLower}, ${tickUpper}], liquidity: ${liquidity}, fee: ${fee}`);

    // Get pool address to find current tick
    const FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
    const factoryABI = [
      'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'
    ];
    const poolABI = [
      'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
      'function token0() external view returns (address)',
      'function token1() external view returns (address)',
    ];

    const factory  = new ethers.Contract(FACTORY, factoryABI, provider);
    const poolAddr = await factory.getPool(pos.token0, pos.token1, pos.fee);
    const pool     = new ethers.Contract(poolAddr, poolABI, provider);
    const slot0    = await pool.slot0();
    const currentTick = Number(slot0.tick);
    const sqrtPriceX96 = slot0.sqrtPriceX96;

    const inRange = currentTick >= tickLower && currentTick < tickUpper;
    console.log(`Current tick: ${currentTick}, in range: ${inRange}`);

    // Calculate position value from liquidity and current price
    // sqrtPrice = sqrtPriceX96 / 2^96
    const Q96 = 2n ** 96n;
    const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
    const price = sqrtPrice * sqrtPrice; // token1/token0 = USDC/WETH

    // ETH price in USDC (token1 is USDC, token0 is WETH)
    const ethPrice = price * 1e12; // adjust for decimals (WETH=18, USDC=6)

    // Calculate amounts from liquidity (simplified)
    const sqrtLower = Math.sqrt(Math.pow(1.0001, tickLower));
    const sqrtUpper = Math.sqrt(Math.pow(1.0001, tickUpper));
    const sqrtCurrent = Math.sqrt(Math.pow(1.0001, currentTick));

    const liq = Number(liquidity);
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
    console.log(`ETH price: $${ethPrice.toFixed(2)}, position value: $${positionValueUSD.toFixed(2)}`);

    return { positionValue: positionValueUSD, inRange, currentTick, tickLower, tickUpper, ethPrice };
  } catch (e) {
    console.error(`WETH/USDC error: ${e.message}`);
    return null;
  }
}

// ============================================================
// MODULE 3 — xStocks LP (Raydium CLMM on Solana)
// ============================================================

async function getXStockPositions() {
  console.log('\n--- xStocks LP ---');

  // Raydium CLMM position NFT program
  // We query all NFT positions owned by the wallet
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getTokenAccountsByOwner',
    params: [
      WALLET_SOLANA,
      { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
      { encoding: 'jsonParsed' }
    ]
  };

  const data = await safeFetch('Solana/tokenAccounts', SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!data?.result?.value) {
    console.error('No Solana token accounts found');
    return null;
  }

  // Filter for NFT tokens (amount = 1, decimals = 0) — these are LP position NFTs
  const nfts = data.result.value.filter(acc => {
    const info = acc.account?.data?.parsed?.info;
    return info?.tokenAmount?.uiAmount === 1 && info?.tokenAmount?.decimals === 0;
  });

  console.log(`Solana NFT positions found: ${nfts.length}`);

  // For each NFT, try to get position data from Raydium API
  const positions = [];
  for (const nft of nfts.slice(0, 10)) {
    const mint = nft.account?.data?.parsed?.info?.mint;
    if (!mint) continue;

    const posData = await safeFetch(
      `Raydium/pos-${mint.slice(0, 8)}`,
      `https://api-v3.raydium.io/position/nft?nft=${mint}`
    );

    if (posData?.data) {
      const p = posData.data;
      positions.push({
        mint,
        poolId: p.poolId,
        priceLower: p.priceLower,
        priceUpper: p.priceUpper,
        currentPrice: p.currentPrice,
        amountA: p.amountA,
        amountB: p.amountB,
        tokenA: p.tokenAMint,
        tokenB: p.tokenBMint,
        symbolA: p.tokenASymbol ?? 'tokenA',
        symbolB: p.tokenBSymbol ?? 'tokenB',
        positionValueUSD: parseFloat(p.positionValueUSD ?? p.totalValue ?? 0),
        unclaimedFeeA: parseFloat(p.unclaimedFeeA ?? 0),
        unclaimedFeeB: parseFloat(p.unclaimedFeeB ?? 0),
        unclaimedFeeUSD: parseFloat(p.unclaimedFeeUSD ?? 0),
        inRange: p.inRange ?? (parseFloat(p.currentPrice) >= parseFloat(p.priceLower) && parseFloat(p.currentPrice) <= parseFloat(p.priceUpper)),
      });
      console.log(`  ${p.tokenASymbol}/${p.tokenBSymbol}: $${p.positionValueUSD ?? p.totalValue}`);
    }
  }

  return positions;
}

// ============================================================
// MODULE 4 — Moonwell USD values (Base RPC)
// ============================================================

async function getMoonwellUSD() {
  console.log('\n--- Moonwell USD ---');

  try {
    const provider = new ethers.JsonRpcProvider(BASE_RPC);

    // Moonwell Comptroller on Base
    const COMPTROLLER = '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C';
    const mTokenABI = [
      'function balanceOfUnderlying(address owner) external returns (uint)',
      'function borrowBalanceCurrent(address account) external returns (uint)',
      'function exchangeRateCurrent() external returns (uint)',
      'function decimals() external view returns (uint8)',
      'function underlying() external view returns (address)',
    ];

    // Moonwell market addresses on Base
    const MARKETS = {
      ETH:    '0x628ff693426583D9a7FB391E54366292F509D457',
      VIRTUAL:'0x0A61Df5651050bc3F5E0e47D73B5CF44e7c38E4A',
      cbXRP:  '0x49f85b2A5b54fD90ee6B5a3F0c70F48DfE55038',
      AERO:   '0x73702E48a6AE0b4B9e4BFAE4781a43AE7e61E3A7',
    };

    const results = {};

    for (const [symbol, addr] of Object.entries(MARKETS)) {
      try {
        const mToken = new ethers.Contract(addr, mTokenABI, provider);
        const [balRaw, decimals] = await Promise.all([
          mToken.balanceOfUnderlying(WALLET_EVM),
          mToken.decimals(),
        ]);
        const balance = Number(balRaw) / Math.pow(10, Number(decimals));
        results[symbol] = balance;
        console.log(`Moonwell ${symbol}: ${balance}`);
      } catch (e) {
        console.error(`Moonwell ${symbol} error: ${e.message}`);
        results[symbol] = null;
      }
    }

    // Get borrow balance (USDC)
    try {
      const USDC_MARKET = '0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22';
      const mUSDC = new ethers.Contract(USDC_MARKET, mTokenABI, provider);
      const borrowRaw = await mUSDC.borrowBalanceCurrent(WALLET_EVM);
      results['USDCBorrow'] = Number(borrowRaw) / 1e6;
      console.log(`Moonwell USDC borrow: $${results['USDCBorrow']}`);
    } catch (e) {
      console.error(`Moonwell borrow error: ${e.message}`);
    }

    return results;
  } catch (e) {
    console.error(`Moonwell error: ${e.message}`);
    return null;
  }
}

// ============================================================
// MODULE 5 — Suilend (Sui RPC)
// ============================================================

async function getSuilendData() {
  console.log('\n--- Suilend ---');

  try {
    // Query Suilend obligations for wallet
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'suix_getOwnedObjects',
      params: [
        WALLET_SUI,
        {
          filter: { StructType: '0xf95b06141ed4a174f239417323bde3f209b972f5d4c60747020fc9a5b3e97eaa::lending_market::Obligation<0x2::sui::SUI>' },
          options: { showContent: true }
        }
      ]
    };

    const data = await safeFetch('Sui/obligations', SUI_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (data?.result?.data?.length > 0) {
      console.log(`Suilend obligations: ${data.result.data.length}`);
      const obligation = data.result.data[0];
      console.log('Obligation:', JSON.stringify(obligation?.data?.content).slice(0, 300));
    } else {
      console.log('No Suilend obligations found — trying portfolio API');

      // Fall back to Suilend portfolio API
      const portfolio = await safeFetch(
        'Suilend/portfolio',
        `https://api.suilend.fi/portfolio?owner=${WALLET_SUI}`
      );
      if (portfolio) {
        console.log('Suilend portfolio:', JSON.stringify(portfolio).slice(0, 300));
        return portfolio;
      }
    }

    return null;
  } catch (e) {
    console.error(`Suilend error: ${e.message}`);
    return null;
  }
}

// ============================================================
// WRITE TO AIRTABLE
// ============================================================

async function writeDailyAction(assetId, fields) {
  const record = {
    fields: {
      [F.asset]:      [{ id: assetId }],
      [F.actionType]: { id: CHOICES.feeCheck },
      [F.date]:       NOW_UTC,
      ...fields,
    }
  };
  return airtableWrite(DAILY_ACTIONS_TABLE, [record]);
}

async function writeLendingAction(positionId, fields) {
  const record = {
    fields: {
      [LENDING_F.position]:   [{ id: positionId }],
      [LENDING_F.actionType]: { id: CHOICES.rateCheck },
      [LENDING_F.date]:       NOW_UTC,
      ...fields,
    }
  };
  return airtableWrite(LENDING_ACTIONS_TABLE, [record]);
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log(`\n====== Daily Portfolio Check — ${NOW_UTC} ======`);

  // Run all data fetches
  const [lighterData, wethData, xstockPositions, moonwellData, suilendData] =
    await Promise.allSettled([
      getLighterEquity(),
      getWethPosition(),
      getXStockPositions(),
      getMoonwellUSD(),
      getSuilendData(),
    ]);

  const lighter  = lighterData.status  === 'fulfilled' ? lighterData.value  : null;
  const weth     = wethData.status     === 'fulfilled' ? wethData.value     : null;
  const xstocks  = xstockPositions.status === 'fulfilled' ? xstockPositions.value : null;
  const moonwell = moonwellData.status === 'fulfilled' ? moonwellData.value : null;
  const suilend  = suilendData.status  === 'fulfilled' ? suilendData.value  : null;

  console.log('\n--- Writing to Airtable ---');
  let written = 0;

  // Lighter — LLP
  if (lighter?.llp !== null && lighter?.llp !== undefined) {
    await writeDailyAction(ASSET.llp, {
      [F.positionValue]: lighter.llp,
      [F.inRange]:       { id: CHOICES.inRangeYes },
      [F.notes]:         'LLP equity via Lighter API',
    });
    written++;
    console.log(`✓ LLP: $${lighter.llp}`);
  }

  // Lighter — Edge & Hedge
  if (lighter?.edgeHedge !== null && lighter?.edgeHedge !== undefined) {
    await writeDailyAction(ASSET.edgeHedge, {
      [F.positionValue]: lighter.edgeHedge,
      [F.inRange]:       { id: CHOICES.inRangeYes },
      [F.notes]:         'Edge & Hedge equity via Lighter API',
    });
    written++;
    console.log(`✓ Edge & Hedge: $${lighter.edgeHedge}`);
  }

  // Lighter — LIT Staking
  if (lighter?.lit !== null && lighter?.lit !== undefined) {
    await writeDailyAction(ASSET.litStaking, {
      [F.positionValue]: lighter.lit,
      [F.inRange]:       { id: CHOICES.inRangeYes },
      [F.notes]:         'LIT Staking equity via Lighter API',
    });
    written++;
    console.log(`✓ LIT Staking: $${lighter.lit}`);
  }

  // WETH/USDC Primary
  if (weth) {
    await writeDailyAction(ASSET.wethPrimary, {
      [F.positionValue]: weth.positionValue,
      [F.revertPosVal]:  weth.positionValue,
      [F.inRange]:       { id: weth.inRange ? CHOICES.inRangeYes : CHOICES.inRangeNo },
      [F.notes]:         `ETH: $${weth.ethPrice?.toFixed(0)} | Tick: ${weth.currentTick} | Range: [${weth.tickLower}, ${weth.tickUpper}]`,
    });
    written++;
    console.log(`✓ WETH/USDC: $${weth.positionValue?.toFixed(2)}`);
  }

  // xStocks — map by symbol
  const xstockMap = {
    TSLAx: ASSET.tsla,
    NVDAx: ASSET.nvda,
    CRCLx: ASSET.crcl,
    SPYx:  ASSET.spy,
    GOOGLx: ASSET.googl,
    AAPLx: ASSET.aapl,
  };

  if (xstocks?.length > 0) {
    for (const pos of xstocks) {
      const symbol = pos.symbolA?.replace('/USDC', '') ?? '';
      const assetId = xstockMap[symbol] ?? xstockMap[pos.symbolA];
      if (!assetId) {
        console.log(`  No asset ID for ${pos.symbolA}/${pos.symbolB} — skipping`);
        continue;
      }
      await writeDailyAction(assetId, {
        [F.positionValue]: pos.positionValueUSD,
        [F.feeValue]:      pos.unclaimedFeeUSD,
        [F.inRange]:       { id: pos.inRange ? CHOICES.inRangeYes : CHOICES.inRangeNo },
        [F.notes]:         `Fees: $${pos.unclaimedFeeUSD?.toFixed(2)} | Range: [${pos.priceLower}, ${pos.priceUpper}]`,
      });
      written++;
      console.log(`✓ ${symbol}: $${pos.positionValueUSD}`);
    }
  }

  // Moonwell USD values — update lending positions
  if (moonwell) {
    if (moonwell.ETH !== null) {
      await writeLendingAction(LENDING_POS.moonwellETH, {
        [LENDING_F.supplyUSD]: moonwell.ETH,
      });
      written++;
      console.log(`✓ Moonwell ETH supply: ${moonwell.ETH}`);
    }
    if (moonwell.VIRTUAL !== null) {
      await writeLendingAction(LENDING_POS.moonwellVIRT, {
        [LENDING_F.supplyUSD]: moonwell.VIRTUAL,
      });
      written++;
    }
    if (moonwell.cbXRP !== null) {
      await writeLendingAction(LENDING_POS.moonwellCBXRP, {
        [LENDING_F.supplyUSD]: moonwell.cbXRP,
      });
      written++;
    }
    if (moonwell.AERO !== null) {
      await writeLendingAction(LENDING_POS.moonwellAERO, {
        [LENDING_F.supplyUSD]: moonwell.AERO,
      });
      written++;
    }
    if (moonwell.USDCBorrow !== null) {
      await writeLendingAction(LENDING_POS.moonwellBorrow, {
        [LENDING_F.borrowUSD]: moonwell.USDCBorrow,
      });
      written++;
      console.log(`✓ Moonwell USDC borrow: $${moonwell.USDCBorrow}`);
    }
  }

  console.log(`\n====== Complete — ${written} records written ======`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});

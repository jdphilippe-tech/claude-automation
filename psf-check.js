// ============================================================
// PSF Check — On-demand WETH/USDC Primary + ETH Short Hedge v2
// Airtable-driven WETH/USDC position discovery
// WALLET_WETH_LP added — correct wallet for active LP position
// NFT position ID read from Airtable Assets at runtime
// On rollover: update Airtable Assets only, no code change needed
// Triggered manually via GitHub Actions UI
// ============================================================

import { ethers } from 'ethers';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE    = 'appWojaxYR99bXC1f';
const DAILY_TABLE      = 'tblKsk0QnkOoKNLuk';
const ASSETS_TABLE     = 'tblrATIQI0ld9tz1y';

const WALLET_WETH_LP     = '0x2375369D950D49897193EbCad32d99206C37D10A';
const WALLET_HYPERLIQUID = '0x464b059B1AF55A408CB3c822D610c2D962d2cf4b';
const ARBITRUM_RPC       = 'https://arb1.arbitrum.io/rpc';

const NOW_UTC = new Date().toISOString();

// ---- Assets table field IDs ----
const AF = {
  asset:    'fldXyU6o1g35gciSb',
  protocol: 'fldC8oxgDQtxfEKbs',
  status:   'fldDRyGqgXJTuHTpx',
  nftMint:  'fldpPTHyGfrSCQO0F',
  poolAddr: 'fldCw0oAwKkAmigto',
  cycleId:  'fld0T538WMoPQ5bgL',
};

// ---- Daily Actions field IDs ----
const F = {
  asset:         'fldtiRIqznncRfJYG',
  actionType:    'fldUkwrxtS4AEr52W',
  date:          'fldHG3MCcyhkXknyH',
  inRange:       'fld9pdBIkiEIv352W',
  positionValue: 'fldWElDtJZRYTaZtD',
  feeValue:      'fld6QnTv9CKHvglcX',
  cycleId:       'fldFFts5ByR1EeYBk',
  notes:         'fldxWdSuQ09uhadFo',
};

const ASSET = {
  wethPrimary: 'recbVsmOWh9YOWPBZ',
  ethHedge:    'recgASxadhJMkNNry',
};

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

async function airtableFetch(tableId, fields, filterFormula) {
  const { default: fetch } = await import('node-fetch');
  const params = new URLSearchParams();
  fields.forEach(f => params.append('fields[]', f));
  if (filterFormula) params.append('filterByFormula', filterFormula);
  params.append('pageSize', '100');
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}?${params}`,
    { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }
  );
  if (!res.ok) { console.error(`[Airtable fetch] ${await res.text().catch(() => '')}`); return []; }
  const json = await res.json();
  return json.records ?? [];
}

function dailyRecord(assetRecordId, inRange, extra = {}) {
  return { [F.asset]: [assetRecordId], [F.actionType]: 'Fee Check', [F.date]: NOW_UTC, [F.inRange]: inRange ? 'Yes' : 'No', ...extra };
}

// ============================================================
// STARTUP — Fetch WETH/USDC asset from Airtable
// ============================================================

async function fetchWethAsset() {
  // Fetch directly by record ID — avoids slash encoding issues in filterByFormula
  const { default: fetch } = await import('node-fetch');
  try {
    const res = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${ASSETS_TABLE}/recbVsmOWh9YOWPBZ`,
      { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }
    );
    if (!res.ok) { console.error(`WETH asset fetch failed: ${res.status}`); return null; }
    const record = await res.json();
    return record?.fields ? record : null;
  } catch (e) { console.error(`WETH asset fetch error: ${e.message}`); return null; }
}

// ============================================================
// MODULE 1 — WETH/USDC Primary (Arbitrum)
// ============================================================

async function getWethPosition(wethAsset) {
  console.log('\n--- WETH/USDC Primary ---');
  try {
    if (!wethAsset) { console.error('No active WETH/USDC asset found in Airtable'); return null; }

    const nftIdFromAirtable = wethAsset.fields[AF.nftMint];
    const cycleId           = wethAsset.fields[AF.cycleId];

    const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC);
    const NFT_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
    const WETH        = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
    const USDC        = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
    const TARGET_FEE  = 500;

    const nftManagerABI = [
      'function balanceOf(address owner) external view returns (uint256)',
      'function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)',
      'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
    ];
    const factoryABI = ['function getPool(address,address,uint24) external view returns (address)'];
    const poolABI    = ['function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)'];
    const collectABI = ['function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) external returns (uint256 amount0, uint256 amount1)'];

    const nft = new ethers.Contract(NFT_MANAGER, nftManagerABI, provider);

    // Try Airtable NFT ID first
    let WETH_POS_ID = null;
    let raw = null;

    if (nftIdFromAirtable) {
      try {
        const tokenId = BigInt(nftIdFromAirtable);
        const pos = await nft.positions(tokenId);
        const token0 = pos.token0.toLowerCase();
        const token1 = pos.token1.toLowerCase();
        const isWethUsdc = (
          (token0 === WETH.toLowerCase() && token1 === USDC.toLowerCase()) ||
          (token0 === USDC.toLowerCase() && token1 === WETH.toLowerCase())
        );
        if (isWethUsdc && Number(pos.fee) === TARGET_FEE && pos.liquidity > 0n) {
          WETH_POS_ID = tokenId;
          raw = pos;
          console.log(`Using Airtable NFT #${nftIdFromAirtable} — liquidity confirmed`);
        } else {
          console.log(`Airtable NFT #${nftIdFromAirtable} — liquidity=0 or wrong pair, falling back to wallet scan`);
        }
      } catch (e) {
        console.error(`Airtable NFT lookup failed: ${e.message.slice(0, 60)}, falling back to wallet scan`);
      }
    }

    // Fallback: scan WALLET_WETH_LP
    if (!WETH_POS_ID) {
      const balance = await nft.balanceOf(WALLET_WETH_LP);
      const count = Number(balance);
      console.log(`Scanning WALLET_WETH_LP — owns ${count} Uniswap V3 NFT(s)...`);
      for (let i = 0; i < count; i++) {
        const tokenId = await nft.tokenOfOwnerByIndex(WALLET_WETH_LP, i);
        const pos = await nft.positions(tokenId);
        const token0 = pos.token0.toLowerCase();
        const token1 = pos.token1.toLowerCase();
        const fee = Number(pos.fee);
        const liq = pos.liquidity;
        const isWethUsdc = (
          (token0 === WETH.toLowerCase() && token1 === USDC.toLowerCase()) ||
          (token0 === USDC.toLowerCase() && token1 === WETH.toLowerCase())
        );
        console.log(`  NFT #${tokenId}: fee=${fee}, liquidity=${liq}, WETH/USDC=${isWethUsdc}`);
        if (isWethUsdc && fee === TARGET_FEE && liq > 0n) {
          WETH_POS_ID = tokenId; raw = pos;
          console.log(`  ✓ Active WETH/USDC 0.05% position found: NFT #${tokenId}`);
          break;
        }
      }
    }

    if (!WETH_POS_ID || !raw) { console.error('No active WETH/USDC 0.05% position with liquidity found'); return null; }

    const tickLowerN = Number(raw.tickLower);
    const tickUpperN = Number(raw.tickUpper);
    const liquidity  = raw.liquidity;
    const factory    = new ethers.Contract('0x1F98431c8aD98523631AE4a59f267346ea31F984', factoryABI, provider);
    const poolAddr   = await factory.getPool(raw.token0, raw.token1, raw.fee);
    const slot0      = await (new ethers.Contract(poolAddr, poolABI, provider)).slot0();
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
    const MAX128 = BigInt('0xffffffffffffffffffffffffffffffff');
    const nftCollect = new ethers.Contract(NFT_MANAGER, collectABI, provider);
    let feeValue = 0;
    try {
      const fees = await nftCollect.collect.staticCall({ tokenId: WETH_POS_ID, recipient: WALLET_WETH_LP, amount0Max: MAX128, amount1Max: MAX128 });
      const feeETH  = Number(fees[0]) / 1e18;
      const feeUSDC = Number(fees[1]) / 1e6;
      feeValue = (feeETH * ethPrice) + feeUSDC;
      console.log(`ETH: $${ethPrice.toFixed(2)}, position: $${positionValue.toFixed(2)}, fees: $${feeValue.toFixed(2)}, in range: ${inRange}`);
    } catch (e) {
      console.error(`Fee collect failed: ${e.message.slice(0, 60)}`);
      console.log(`ETH: $${ethPrice.toFixed(2)}, position: $${positionValue.toFixed(2)}, in range: ${inRange}`);
    }

    return { positionValue, feeValue, inRange, currentTick, tickLower: tickLowerN, tickUpper: tickUpperN, ethPrice, cycleId };
  } catch (e) {
    console.error(`WETH/USDC: ${e.message}`);
    return null;
  }
}

// ============================================================
// MODULE 2 — ETH Short Hedge (Hyperliquid)
// ============================================================

async function getEthHedge() {
  console.log('\n--- ETH Short Hedge ---');
  try {
    const [hlState, hlSpot] = await Promise.all([
      fetchWithTimeout('https://api.hyperliquid.xyz/info', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'clearinghouseState', user: WALLET_HYPERLIQUID }),
      }),
      fetchWithTimeout('https://api.hyperliquid.xyz/info', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'spotClearinghouseState', user: WALLET_HYPERLIQUID }),
      }),
    ]);

    let positionValue = null;
    const balances = hlSpot?.balances ?? [];
    const usdc = balances.find(b => b.coin === 'USDC' || b.coin === 'USDC.e');
    if (usdc) {
      positionValue = parseFloat(usdc.total ?? usdc.hold ?? 0);
      console.log(`Portfolio Value (USDC): $${positionValue.toFixed(2)}`);
    }

    let hedgeData = null;
    const ethPos = (hlState?.assetPositions ?? []).find(p => p.position?.coin === 'ETH');
    if (ethPos) {
      const pos = ethPos.position;
      hedgeData = {
        unrealizedPnl: parseFloat(pos.unrealizedPnl ?? 0),
        entryPx:       parseFloat(pos.entryPx ?? 0),
        size:          parseFloat(pos.szi ?? 0),
      };
      console.log(`ETH PnL: $${hedgeData.unrealizedPnl.toFixed(2)}, entry: $${hedgeData.entryPx}, size: ${hedgeData.size} ETH`);
    } else { console.log('No active ETH position found'); }

    const noteParts = [];
    if (hedgeData?.unrealizedPnl != null) noteParts.push(`PnL: $${hedgeData.unrealizedPnl.toFixed(2)}`);
    if (hedgeData?.entryPx)               noteParts.push(`Entry: $${hedgeData.entryPx}`);
    if (hedgeData?.size)                  noteParts.push(`Size: ${hedgeData.size} ETH`);
    const notes = noteParts.length > 0 ? noteParts.join(' | ') : 'No active ETH position';
    return { positionValue, notes };
  } catch (e) {
    console.error(`ETH Hedge fatal: ${e.message}`);
    return null;
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log(`\n====== PSF Check — ${NOW_UTC} ======`);

  const wethAsset = await fetchWethAsset();

  const [wethRes, hedgeRes] = await Promise.allSettled([
    getWethPosition(wethAsset),
    getEthHedge(),
  ]);

  const weth  = wethRes.status  === 'fulfilled' ? wethRes.value  : null;
  const hedge = hedgeRes.status === 'fulfilled' ? hedgeRes.value : null;

  console.log('\n--- Writing to Airtable ---');
  let written = 0;

  if (weth) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.wethPrimary, weth.inRange, {
      [F.positionValue]: weth.positionValue,
      [F.cycleId]:       weth.cycleId,
      ...(weth.feeValue > 0 ? { [F.feeValue]: weth.feeValue } : {}),
      [F.notes]: `ETH: $${weth.ethPrice?.toFixed(0)} | Tick: ${weth.currentTick} | Range: [${weth.tickLower}, ${weth.tickUpper}]`,
    })]);
    if (ok) { written++; console.log(`✓ WETH/USDC: $${weth.positionValue?.toFixed(2)}, fees: $${weth.feeValue?.toFixed(2)}, cycleId: ${weth.cycleId}`); }
  }

  if (hedge?.positionValue != null) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.ethHedge, true, {
      [F.positionValue]: hedge.positionValue,
      [F.notes]:         hedge.notes,
    })]);
    if (ok) { written++; console.log(`✓ ETH Hedge: $${hedge.positionValue.toFixed(2)} | ${hedge.notes}`); }
  }

  console.log(`\n====== PSF Check Complete — ${written} records written ======`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

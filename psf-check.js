// ============================================================
// PSF Check — On-demand WETH/USDC Primary + ETH Short Hedge
// Triggered manually via Claude or GitHub Actions UI
// Writes fresh records to Airtable then Claude reads and
// performs full delta analysis in the same conversation.
// ============================================================

import { ethers } from 'ethers';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE    = 'appWojaxYR99bXC1f';
const DAILY_TABLE      = 'tblKsk0QnkOoKNLuk';

const WALLET_EVM         = '0x871fd9a8A6a6E918658eadF46e9c23fE4E377289';
const WALLET_HYPERLIQUID = '0x464b059B1AF55A408CB3c822D610c2D962d2cf4b';
const WETH_POS_ID        = 5384162n;
const ARBITRUM_RPC       = 'https://arb1.arbitrum.io/rpc';

const NOW_UTC = new Date().toISOString();

// ---- Field IDs (Daily Actions) ----
const F = {
  asset:         'fldtiRIqznncRfJYG',
  actionType:    'fldUkwrxtS4AEr52W',
  date:          'fldHG3MCcyhkXknyH',
  inRange:       'fld9pdBIkiEIv352W',
  positionValue: 'fldWElDtJZRYTaZtD',
  feeValue:      'fld6QnTv9CKHvglcX',
  notes:         'fldxWdSuQ09uhadFo',
};

// ---- Asset record IDs ----
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

function dailyRecord(assetRecordId, inRange, extra = {}) {
  return {
    [F.asset]:      [assetRecordId],
    [F.actionType]: 'Fee Check',
    [F.date]:       NOW_UTC,
    [F.inRange]:    inRange ? 'Yes' : 'No',
    ...extra
  };
}

// ============================================================
// MODULE 1 — WETH/USDC Primary (Arbitrum)
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
// MODULE 2 — ETH Short Hedge (Hyperliquid)
// ============================================================

async function getEthHedge() {
  console.log('\n--- ETH Short Hedge ---');
  try {
    const [hlState, hlSpot] = await Promise.all([
      fetchWithTimeout('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'clearinghouseState', user: WALLET_HYPERLIQUID }),
      }),
      fetchWithTimeout('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'spotClearinghouseState', user: WALLET_HYPERLIQUID }),
      }),
    ]);

    // USDC spot balance = position value
    let positionValue = null;
    const balances = hlSpot?.balances ?? [];
    const usdc = balances.find(b => b.coin === 'USDC' || b.coin === 'USDC.e');
    if (usdc) {
      positionValue = parseFloat(usdc.total ?? usdc.hold ?? 0);
      console.log(`Portfolio Value (USDC): $${positionValue.toFixed(2)}`);
    }

    // ETH perp position — PnL, entry, size
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
    } else {
      console.log('No active ETH position found');
    }

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

  const [wethRes, hedgeRes] = await Promise.allSettled([
    getWethPosition(),
    getEthHedge(),
  ]);

  const weth  = wethRes.status  === 'fulfilled' ? wethRes.value  : null;
  const hedge = hedgeRes.status === 'fulfilled' ? hedgeRes.value : null;

  console.log('\n--- Writing to Airtable ---');
  let written = 0;

  if (weth) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.wethPrimary, weth.inRange, {
      [F.positionValue]: weth.positionValue,
      ...(weth.feeValue > 0 ? { [F.feeValue]: weth.feeValue } : {}),
      [F.notes]: `ETH: $${weth.ethPrice?.toFixed(0)} | Tick: ${weth.currentTick} | Range: [${weth.tickLower}, ${weth.tickUpper}]`,
    })]);
    if (ok) { written++; console.log(`✓ WETH/USDC: $${weth.positionValue?.toFixed(2)}, fees: $${weth.feeValue?.toFixed(2)}`); }
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

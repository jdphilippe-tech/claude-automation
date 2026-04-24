// ============================================================
// scripts/fee-check.mjs — Manual Fee Check v2
// Airtable-driven LP position discovery — no hardcoded NFT IDs
// WALLET_WETH_LP added for correct WETH/USDC wallet
// Raydium positions read from Airtable Assets at runtime
// On rollover: update Airtable Assets only, no code change needed
// Triggered manually — run before claiming fees on any LP.
// After claiming, post tx hash in chat to log Claim records.
// ============================================================

import { ethers } from 'ethers';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE    = 'appWojaxYR99bXC1f';
const DAILY_TABLE      = 'tblKsk0QnkOoKNLuk';
const ASSETS_TABLE     = 'tblrATIQI0ld9tz1y';

const WALLET_WETH_LP = '0x2375369D950D49897193EbCad32d99206C37D10A';

const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
const SOL_RPC      = process.env.SOL_RPC_URL ?? 'https://api.mainnet-beta.solana.com';

const RAYDIUM_DRY_RUN      = (process.env.RAYDIUM_DRY_RUN ?? 'true') !== 'false';
const RAYDIUM_CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

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
// STARTUP — Fetch active LP positions from Airtable
// ============================================================

async function fetchActiveLPAssets() {
  console.log('Fetching active LP assets from Airtable...');
  const { default: fetch } = await import('node-fetch');

  // Fetch WETH/USDC directly by record ID — avoids slash encoding issues in filterByFormula
  let wethAsset = null;
  try {
    const wethRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${ASSETS_TABLE}/recbVsmOWh9YOWPBZ`,
      { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }
    );
    if (wethRes.ok) {
      const wethRecord = await wethRes.json();
      if (wethRecord?.fields) wethAsset = wethRecord;
    }
  } catch (e) { console.error(`WETH/USDC asset fetch failed: ${e.message}`); }

  // Fetch Raydium assets — simple single-value filter, no slash encoding issues
  const raydiumAssets = await airtableFetch(
    ASSETS_TABLE,
    [AF.asset, AF.protocol, AF.status, AF.nftMint, AF.poolAddr, AF.cycleId],
    `AND({fldDRyGqgXJTuHTpx} = 'Active', {fldC8oxgDQtxfEKbs} = 'Raydium')`
  );

  console.log(`Found WETH/USDC: ${wethAsset ? 'yes' : 'NO - MISSING'}`);
  console.log(`Found Raydium positions: ${raydiumAssets.length}`);
  return { wethAsset, raydiumAssets };
}

// ============================================================
// MODULE 1 — WETH/USDC PRIMARY (Arbitrum)
// ============================================================

async function getWethPosition(wethAsset) {
  console.log('\n--- WETH/USDC Primary ---');
  try {
    if (!wethAsset) { console.error('No active WETH/USDC asset found in Airtable'); return null; }

    const nftIdFromAirtable = wethAsset.fields[AF.nftMint];
    const cycleId           = wethAsset.fields[AF.cycleId];

    const provider   = new ethers.JsonRpcProvider(ARBITRUM_RPC);
    const nftManagerABI = [
      'function balanceOf(address owner) external view returns (uint256)',
      'function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)',
      'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
    ];
    const factoryABI = ['function getPool(address,address,uint24) external view returns (address)'];
    const poolABI    = ['function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)'];
    const collectABI = ['function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) external returns (uint256 amount0, uint256 amount1)'];

    const NFT_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
    const WETH        = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
    const USDC        = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
    const TARGET_FEE  = 500;

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
// MODULE 2 — Raydium xStocks CLMM (Solana)
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
  if (inRange)                      { a0 = liq * (sqrtU - sqrtC) / (sqrtC * sqrtU); a1 = liq * (sqrtC - sqrtL); }
  else if (tickCurrent < tickLower) { a0 = liq * (sqrtU - sqrtL) / (sqrtL * sqrtU); }
  else                              { a1 = liq * (sqrtU - sqrtL); }
  return { amount0: a0, amount1: a1, inRange };
}

function parsePositionAccount(data) {
  const buf = Buffer.from(data, 'base64');
  const tickLower = buf.readInt32LE(73);
  const tickUpper = buf.readInt32LE(77);
  const liqLo = buf.readBigUInt64LE(81);
  const liqHi = buf.readBigUInt64LE(89);
  const liquidity = liqLo | (liqHi << 64n);
  const fgi0Lo = buf.readBigUInt64LE(97);  const fgi0Hi = buf.readBigUInt64LE(105);
  const fgi1Lo = buf.readBigUInt64LE(113); const fgi1Hi = buf.readBigUInt64LE(121);
  const fgInside0Last = fgi0Lo | (fgi0Hi << 64n);
  const fgInside1Last = fgi1Lo | (fgi1Hi << 64n);
  const feesOwed0 = buf.readBigUInt64LE(129);
  const feesOwed1 = buf.readBigUInt64LE(137);
  return { tickLower, tickUpper, liquidity, fgInside0Last, fgInside1Last, feesOwed0, feesOwed1 };
}

function parsePoolAccount(data) {
  const buf = Buffer.from(data, 'base64');
  const mint0Bytes = buf.slice(73, 105);
  const mint1Bytes = buf.slice(105, 137);
  const dec0       = buf.readUInt8(233);
  const dec1       = buf.readUInt8(234);
  const sqrtLo = buf.readBigUInt64LE(253);
  const sqrtHi = buf.readBigUInt64LE(261);
  const sqrtPriceX64 = sqrtLo | (sqrtHi << 64n);
  const Q64  = 2n ** 64n;
  const Q64f = Number(Q64);
  const sqrtPriceFloat = Number(sqrtPriceX64 / Q64) + Number(sqrtPriceX64 % Q64) / Q64f;
  const rawPrice    = sqrtPriceFloat * sqrtPriceFloat;
  const tickCurrent = Math.round(Math.log(rawPrice) / Math.log(1.0001));
  const fg0Lo = buf.readBigUInt64LE(277); const fg0Hi = buf.readBigUInt64LE(285);
  const fg1Lo = buf.readBigUInt64LE(293); const fg1Hi = buf.readBigUInt64LE(301);
  const feeGrowthGlobal0 = fg0Lo | (fg0Hi << 64n);
  const feeGrowthGlobal1 = fg1Lo | (fg1Hi << 64n);
  return {
    mint0: base58EncodeBytes(Array.from(mint0Bytes)),
    mint1: base58EncodeBytes(Array.from(mint1Bytes)),
    decimals0: dec0, decimals1: dec1, sqrtPriceX64, tickCurrent, feeGrowthGlobal0, feeGrowthGlobal1,
  };
}

async function getRaydiumPositions(raydiumAssets) {
  console.log(`\n--- Raydium xStocks CLMM ${RAYDIUM_DRY_RUN ? '[DRY RUN]' : '[LIVE]'} ---`);
  const results = [];

  if (!raydiumAssets || raydiumAssets.length === 0) {
    console.error('No active Raydium assets found in Airtable');
    return results;
  }

  const xstockPositions = raydiumAssets.map(r => ({
    key:      r.fields[AF.asset],
    recordId: r.id,
    cycleId:  r.fields[AF.cycleId],
    nftMint:  r.fields[AF.nftMint],
    poolId:   r.fields[AF.poolAddr],
  })).filter(p => p.nftMint && p.poolId);

  console.log(`Processing ${xstockPositions.length} Airtable-driven xStock positions`);

  for (const posConfig of xstockPositions) {
    const { key, recordId, cycleId, nftMint, poolId } = posConfig;
    try {
      const programAccounts = await solRpc('getProgramAccounts', [
        RAYDIUM_CLMM_PROGRAM,
        { encoding: 'base64', filters: [{ dataSize: 281 }, { memcmp: { offset: 9, bytes: nftMint } }] },
      ]);
      const posAccount = programAccounts?.[0] ?? null;
      if (!posAccount) { console.log(`  ${key}: position account not found`); continue; }

      const pos = parsePositionAccount(posAccount.account.data[0]);
      console.log(`  ${key}: ticks [${pos.tickLower}, ${pos.tickUpper}], liquidity: ${pos.liquidity}`);
      await new Promise(r => setTimeout(r, 2000));

      let poolRes = null;
      for (let i = 1; i <= 3; i++) {
        poolRes = await solRpc('getAccountInfo', [poolId, { encoding: 'base64' }]);
        if (poolRes?.value?.data) break;
        await new Promise(r => setTimeout(r, 3000));
      }
      if (!poolRes?.value?.data) { console.error(`  ${key}: pool not found`); continue; }

      const pool      = parsePoolAccount(poolRes.value.data[0]);
      const priceData = await fetchWithTimeout(`https://coins.llama.fi/prices/current/solana:${pool.mint0},solana:${pool.mint1}`);
      const price0    = priceData?.coins?.[`solana:${pool.mint0}`]?.price ?? null;
      const price1    = priceData?.coins?.[`solana:${pool.mint1}`]?.price ?? null;
      const sqrtP     = sqrtPriceX64ToFloat(pool.sqrtPriceX64.toString());
      const { amount0, amount1, inRange } = calcAmounts(pos.liquidity, pos.tickLower, pos.tickUpper, pool.tickCurrent, sqrtP);
      const tokens0 = amount0 / Math.pow(10, pool.decimals0);
      const tokens1 = amount1 / Math.pow(10, pool.decimals1);
      const positionValue = (price0 ?? 0) * tokens0 + (price1 ?? 0) * tokens1;

      const Q64  = 2n ** 64n;
      const U128 = 2n ** 128n;
      let pendingYield = 0;

      try {
        const sigRes = await solRpc('getSignaturesForAddress', [nftMint, { limit: 5 }]);
        let lowerTickArrayAddr = null, upperTickArrayAddr = null;

        for (const sigEntry of (sigRes || [])) {
          const txRes = await solRpc('getTransaction', [sigEntry.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }]);
          const keys = txRes?.transaction?.message?.accountKeys ?? [];
          if (!keys.includes(RAYDIUM_CLMM_PROGRAM)) continue;
          const candidateKeys = keys.filter(k => k !== RAYDIUM_CLMM_PROGRAM && k !== nftMint && k !== poolId);
          const infosRes = await solRpc('getMultipleAccounts', [candidateKeys.slice(0, 12), { encoding: 'base64' }]);
          for (let i = 0; i < candidateKeys.length && i < 12; i++) {
            const d = infosRes?.value?.[i]?.data?.[0];
            if (!d) continue;
            const buf = Buffer.from(d, 'base64');
            if (buf.length === 10240) {
              const storedPoolId = base58EncodeBytes(Array.from(buf.slice(8, 40)));
              if (storedPoolId === poolId) {
                const startTick = buf.readInt32LE(40);
                console.log(`  Found tick array: ${candidateKeys[i].slice(0,8)}... startTick=${startTick}`);
                if (startTick <= pos.tickLower && !lowerTickArrayAddr) {
                  lowerTickArrayAddr = { addr: candidateKeys[i], startTick, data: d };
                }
                if (startTick <= pos.tickUpper && startTick > (lowerTickArrayAddr?.startTick ?? -Infinity) && !upperTickArrayAddr) {
                  upperTickArrayAddr = { addr: candidateKeys[i], startTick, data: d };
                }
              }
            }
          }
          if (lowerTickArrayAddr) break;
        }

        const feesOwed0USD = (price0 ?? 0) * Number(pos.feesOwed0) / Math.pow(10, pool.decimals0);
        const feesOwed1USD = (price1 ?? 0) * Number(pos.feesOwed1) / Math.pow(10, pool.decimals1);
        pendingYield = feesOwed0USD + feesOwed1USD;

        if (lowerTickArrayAddr) {
          const TICK_SIZE = 168;
          const TA_HEADER = 44;
          function getTickFeeGrowth(taData, tickIndex, taStartTick, tickSpacing) {
            const buf = Buffer.from(taData, 'base64');
            const tickArraySpacing = tickSpacing ?? 10;
            const offset = (tickIndex - taStartTick) / tickArraySpacing;
            if (offset < 0 || offset >= 60 || !Number.isInteger(offset)) return { fg0: 0n, fg1: 0n };
            const tickStart = TA_HEADER + offset * TICK_SIZE;
            const FG0 = 36; const FG1 = 52;
            const fg0Lo = buf.readBigUInt64LE(tickStart + FG0);
            const fg0Hi = buf.readBigUInt64LE(tickStart + FG0 + 8);
            const fg1Lo = buf.readBigUInt64LE(tickStart + FG1);
            const fg1Hi = buf.readBigUInt64LE(tickStart + FG1 + 8);
            return { fg0: fg0Lo | (fg0Hi << 64n), fg1: fg1Lo | (fg1Hi << 64n) };
          }
          const poolBuf = Buffer.from(poolRes.value.data[0], 'base64');
          const tickSpacing = poolBuf.readUInt16LE(235);
          const lowerTA = lowerTickArrayAddr ?? upperTickArrayAddr;
          const upperTA = upperTickArrayAddr ?? lowerTickArrayAddr;
          const lower = getTickFeeGrowth(lowerTA.data, pos.tickLower, lowerTA.startTick, tickSpacing);
          const upper = getTickFeeGrowth(upperTA.data, pos.tickUpper, upperTA.startTick, tickSpacing);
          const fgBelow0 = pool.tickCurrent >= pos.tickLower ? lower.fg0 : (pool.feeGrowthGlobal0 - lower.fg0 + U128) % U128;
          const fgBelow1 = pool.tickCurrent >= pos.tickLower ? lower.fg1 : (pool.feeGrowthGlobal1 - lower.fg1 + U128) % U128;
          const fgAbove0 = pool.tickCurrent < pos.tickUpper  ? upper.fg0 : (pool.feeGrowthGlobal0 - upper.fg0 + U128) % U128;
          const fgAbove1 = pool.tickCurrent < pos.tickUpper  ? upper.fg1 : (pool.feeGrowthGlobal1 - upper.fg1 + U128) % U128;
          const fgInside0 = (pool.feeGrowthGlobal0 - fgBelow0 - fgAbove0 + U128 * 2n) % U128;
          const fgInside1 = (pool.feeGrowthGlobal1 - fgBelow1 - fgAbove1 + U128 * 2n) % U128;
          const delta0 = (fgInside0 - pos.fgInside0Last + U128) % U128;
          const delta1 = (fgInside1 - pos.fgInside1Last + U128) % U128;
          const rawFee0 = Number(delta0 * pos.liquidity / Q64) + Number(pos.feesOwed0);
          const rawFee1 = Number(delta1 * pos.liquidity / Q64) + Number(pos.feesOwed1);
          const fee0USD = (price0 ?? 0) * rawFee0 / Math.pow(10, pool.decimals0);
          const fee1USD = (price1 ?? 0) * rawFee1 / Math.pow(10, pool.decimals1);
          pendingYield  = fee0USD + fee1USD;
          console.log(`  Fees (tick array): $${fee0USD.toFixed(2)} token0 + $${fee1USD.toFixed(2)} USDC = $${pendingYield.toFixed(2)}`);
        } else {
          console.log(`  Fees (feesOwed floor only): $${pendingYield.toFixed(2)}`);
        }
      } catch(feeErr) { console.error(`  Fee calc error: ${feeErr.message.slice(0, 80)}`); }

      console.log(`  ${key}: $${positionValue.toFixed(2)}, in range: ${inRange}, fees: $${pendingYield.toFixed(2)}`);
      results.push({ key, recordId, cycleId, positionValue, inRange, pendingYield });

    } catch (e) { console.error(`  ${key}: ${e.message}`); }
  }
  return results;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  if (!AIRTABLE_API_KEY) throw new Error('AIRTABLE_API_KEY not set');

  console.log(`\n=== Fee Check — ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PDT ===`);
  console.log('Checking: WETH/USDC Primary + 6 Raydium xStocks CLMMs\n');

  const { wethAsset, raydiumAssets } = await fetchActiveLPAssets();

  const [wethRes, raydiumRes] = await Promise.allSettled([
    getWethPosition(wethAsset),
    getRaydiumPositions(raydiumAssets),
  ]);

  const weth    = wethRes.status    === 'fulfilled' ? wethRes.value    : null;
  const raydium = raydiumRes.status === 'fulfilled' ? raydiumRes.value : [];

  console.log('\n--- Writing to Airtable ---');
  let written = 0;

  if (weth) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.wethPrimary, weth.inRange, {
      [F.positionValue]: weth.positionValue,
      [F.cycleId]:       weth.cycleId,
      ...(weth.feeValue > 0 ? { [F.feeValue]: weth.feeValue } : {}),
      [F.notes]: `ETH: $${weth.ethPrice?.toFixed(0)} | Tick: ${weth.currentTick} | Range: [${weth.tickLower}, ${weth.tickUpper}] | Fee Check triggered manually`,
    })]);
    if (ok) { written++; console.log(`✓ WETH/USDC: $${weth.positionValue?.toFixed(2)}, fees: $${weth.feeValue?.toFixed(2)}`); }
  }

  if (raydium.length > 0) {
    if (RAYDIUM_DRY_RUN) {
      console.log('\nRaydium DRY RUN — set RAYDIUM_DRY_RUN=false in GitHub Variables to go live');
      for (const pos of raydium) console.log(`  ${pos.key}: $${pos.positionValue.toFixed(2)}, fees: $${pos.pendingYield.toFixed(2)}, inRange: ${pos.inRange}`);
    } else {
      const batch = [];
      for (const pos of raydium) {
        batch.push(dailyRecord(pos.recordId, pos.inRange, {
          [F.positionValue]: pos.positionValue,
          [F.cycleId]:       pos.cycleId,
          ...(pos.pendingYield > 0 ? { [F.feeValue]: pos.pendingYield } : {}),
          [F.notes]: `Raydium CLMM | ${pos.key} | Fee Check triggered manually${pos.pendingYield > 0 ? '' : ' | fees: out-of-range (no accumulation)'}`,
        }));
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

  console.log(`\n✓ Fee check complete — ${written} record(s) written to Airtable`);
  console.log('Post the tx hash in chat after claiming to log Claim records.\n');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

// ============================================================
// scripts/fee-check.mjs — Manual Fee Check
//
// Runs a fresh fee snapshot for WETH/USDC Primary (Arbitrum)
// and all Raydium xStocks CLMMs (Solana), then writes Fee Check
// records to Airtable Daily Actions.
//
// Triggered manually via GitHub Actions → Fee Check workflow.
// Use this before claiming fees to get a current fee balance.
// After claiming, post the tx hash in chat to log Claim records.
//
// Logic lifted verbatim from index.js for these two modules.
// ============================================================

import { ethers } from 'ethers';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE    = 'appWojaxYR99bXC1f';
const DAILY_TABLE      = 'tblKsk0QnkOoKNLuk';

const WALLET_EVM  = '0x871fd9a8A6a6E918658eadF46e9c23fE4E377289';
const WETH_POS_ID = 5384162n;

const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
const SOL_RPC      = process.env.SOL_RPC_URL ?? 'https://api.mainnet-beta.solana.com';

const RAYDIUM_DRY_RUN      = (process.env.RAYDIUM_DRY_RUN ?? 'true') !== 'false';
const RAYDIUM_CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

const NOW_UTC = new Date().toISOString();

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

// ---- Asset record IDs ----
const ASSET = {
  wethPrimary: 'recbVsmOWh9YOWPBZ',
  tslax:  { recordId: 'recd33iBRKrMMq710', cycleId: 'TSLAx-C2',  nftMint: '7R5JFSuXL23epYJmX6LhzbM2Nce39at4maWD7NeFK4tU', poolId: '8aDaBQkTrS6HVMjyc6EZebgdiaXhLYGriDWKWWp1NpFF' },
  nvdax:  { recordId: 'recdQq6r8iDl3BGYZ', cycleId: 'NVDAx-C1',  nftMint: 'J7qm9jifiKg7CyWDbmdDUNokhgs7JvwZmy2jnJ7qmN5Z', poolId: '4KqQN6u1pFKroFE2jVEhoepAMRKPcuAzWVDCgm9zRBYN' },
  aaplx:  { recordId: 'recGF59dwIOnE8fm2', cycleId: 'AAPLx-C1',  nftMint: '2NsZvobR13JuYbkYTt5EK1XyyEJh3xB8621FhUW3LYKp', poolId: 'CKwJZwm7oj3nu4653N1EpDrqXbXAYXoPFiPeEnLouF8y' },
  googlx: { recordId: 'recRxStry17D0ZGB5', cycleId: 'GOOGLx-C1', nftMint: '2jznFFq36gfhUsWRzkEigGBY8hDqHBv4W6CdtsSGArWx', poolId: 'B8YAwjGYk6qidWzGBXMAxP7nYfG8g74EZ3Y4gFSsobRw' },
  crclx:  { recordId: 'recPq2Ee2MsoMa21S', cycleId: 'CRCLx-C1',  nftMint: 'AZHgbQL6dfBodYN5yHvNbvwWVYXvRGeqYRbd8ni9NfWq', poolId: 'G39wywquKbHK8F2wZZZFX3fcsyG91VCCbbr6WEVp5axy' },
  spyx:   { recordId: 'rechX4b2anmi82enx', cycleId: 'SPYx-C1',   nftMint: 'HgcTrL1Tb57ZrycTbhcBgRviFcWrfSiJRWSmwELXSyrj', poolId: '6truu3rZuiB9rKQg4VYC3Dt3QwV7DgwGqXrYUcrvnDDE' },
};

// ── Airtable ────────────────────────────────────────────────────────────────

async function airtableCreate(tableId, records) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ records: records.map(f => ({ fields: f })) }),
  });
  if (!res.ok) { console.error(`Airtable error ${res.status}:`, await res.text()); return false; }
  return true;
}

function dailyRecord(assetRecordId, inRange, extra = {}) {
  return {
    [F.asset]:      [assetRecordId],
    [F.actionType]: 'Fee Check',
    [F.date]:       NOW_UTC,
    [F.inRange]:    inRange ? 'Yes' : 'No',
    ...extra,
  };
}

// ── MODULE 1 — WETH/USDC PRIMARY (Arbitrum) — verbatim from index.js ────────

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

    const currentTick = Number(slot0.tick);
    const inRange     = currentTick >= tickLowerN && currentTick < tickUpperN;
    const sqrtP       = Number(slot0.sqrtPriceX96) / Number(2n ** 96n);
    const ethPrice    = sqrtP * sqrtP * 1e12;
    const liq         = Number(liquidity);
    const sqrtLower   = Math.sqrt(1.0001 ** tickLowerN);
    const sqrtUpper   = Math.sqrt(1.0001 ** tickUpperN);
    const sqrtCurrent = Math.sqrt(1.0001 ** currentTick);

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

// ── MODULE 2 — RAYDIUM xSTOCKS CLMMs — verbatim from index.js ───────────────

async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    return res.ok ? res.json() : null;
  } catch { clearTimeout(timer); return null; }
}

async function solRpc(method, params) {
  const res = await fetchWithTimeout(SOL_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }, 12000);
  return res?.result ?? null;
}

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
  const Q64 = 2n ** 64n;
  const Q64f = Number(Q64);
  const sqrtPriceFloat = Number(sqrtPriceX64 / Q64) + Number(sqrtPriceX64 % Q64) / Q64f;
  const rawPrice = sqrtPriceFloat * sqrtPriceFloat;
  const tickCurrent = Math.round(Math.log(rawPrice) / Math.log(1.0001));
  const fg0Lo = buf.readBigUInt64LE(277); const fg0Hi = buf.readBigUInt64LE(285);
  const fg1Lo = buf.readBigUInt64LE(293); const fg1Hi = buf.readBigUInt64LE(301);
  const feeGrowthGlobal0 = fg0Lo | (fg0Hi << 64n);
  const feeGrowthGlobal1 = fg1Lo | (fg1Hi << 64n);
  return {
    mint0: base58EncodeBytes(Array.from(mint0Bytes)),
    mint1: base58EncodeBytes(Array.from(mint1Bytes)),
    decimals0: dec0,
    decimals1: dec1,
    sqrtPriceX64,
    tickCurrent,
    feeGrowthGlobal0,
    feeGrowthGlobal1,
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

      let poolRes = null;
      for (let i = 1; i <= 3; i++) {
        poolRes = await solRpc('getAccountInfo', [poolId, { encoding: 'base64' }]);
        if (poolRes?.value?.data) break;
        await new Promise(r => setTimeout(r, 3000));
      }

      if (!poolRes?.value?.data) { console.error(`  ${key}: pool not found`); continue; }

      const pool = parsePoolAccount(poolRes.value.data[0]);
      const priceData = await fetchWithTimeout(`https://coins.llama.fi/prices/current/solana:${pool.mint0},solana:${pool.mint1}`);
      const price0    = priceData?.coins?.[`solana:${pool.mint0}`]?.price ?? null;
      const price1    = priceData?.coins?.[`solana:${pool.mint1}`]?.price ?? null;

      const sqrtP = sqrtPriceX64ToFloat(pool.sqrtPriceX64.toString());
      const { amount0, amount1, inRange } = calcAmounts(pos.liquidity, pos.tickLower, pos.tickUpper, pool.tickCurrent, sqrtP);

      const tokens0 = amount0 / Math.pow(10, pool.decimals0);
      const tokens1 = amount1 / Math.pow(10, pool.decimals1);
      const positionValue = (price0 ?? 0) * tokens0 + (price1 ?? 0) * tokens1;

      const Q64 = 2n ** 64n;
      const U128 = 2n ** 128n;
      let pendingYield = 0;

      try {
        const sigRes = await solRpc('getSignaturesForAddress', [nftMint, { limit: 5 }]);
        let lowerTickArrayAddr = null, upperTickArrayAddr = null;

        for (const sigEntry of (sigRes || [])) {
          const txRes = await solRpc('getTransaction', [
            sigEntry.signature,
            { encoding: 'json', maxSupportedTransactionVersion: 0 }
          ]);
          const keys = txRes?.transaction?.message?.accountKeys ?? [];
          if (!keys.includes(RAYDIUM_CLMM_PROGRAM)) continue;

          const candidateKeys = keys.filter((k) =>
            k !== RAYDIUM_CLMM_PROGRAM && k !== nftMint && k !== poolId
          );

          const infosRes = await solRpc('getMultipleAccounts', [
            candidateKeys.slice(0, 12),
            { encoding: 'base64' }
          ]);

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
          const fgAbove0 = pool.tickCurrent < pos.tickUpper ? upper.fg0 : (pool.feeGrowthGlobal0 - upper.fg0 + U128) % U128;
          const fgAbove1 = pool.tickCurrent < pos.tickUpper ? upper.fg1 : (pool.feeGrowthGlobal1 - upper.fg1 + U128) % U128;

          const fgInside0 = (pool.feeGrowthGlobal0 - fgBelow0 - fgAbove0 + U128 * 2n) % U128;
          const fgInside1 = (pool.feeGrowthGlobal1 - fgBelow1 - fgAbove1 + U128 * 2n) % U128;

          const delta0 = (fgInside0 - pos.fgInside0Last + U128) % U128;
          const delta1 = (fgInside1 - pos.fgInside1Last + U128) % U128;

          const rawFee0 = Number(delta0 * pos.liquidity / Q64) + Number(pos.feesOwed0);
          const rawFee1 = Number(delta1 * pos.liquidity / Q64) + Number(pos.feesOwed1);
          const fee0USD = (price0 ?? 0) * rawFee0 / Math.pow(10, pool.decimals0);
          const fee1USD = (price1 ?? 0) * rawFee1 / Math.pow(10, pool.decimals1);
          pendingYield = fee0USD + fee1USD;
          console.log(`  Fees (tick array): $${fee0USD.toFixed(2)} token0 + $${fee1USD.toFixed(2)} USDC = $${pendingYield.toFixed(2)}`);
        } else {
          console.log(`  Fees (feesOwed floor only): $${pendingYield.toFixed(2)}`);
        }
      } catch(feeErr) {
        console.error(`  Fee calc error: ${feeErr.message.slice(0, 80)}`);
      }

      console.log(`  ${key}: $${positionValue.toFixed(2)}, in range: ${inRange}, fees: $${pendingYield.toFixed(2)}`);
      results.push({ key, positionValue, inRange, pendingYield });

    } catch (e) { console.error(`  ${key}: ${e.message}`); }
  }

  return results;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!AIRTABLE_API_KEY) throw new Error('AIRTABLE_API_KEY not set');

  console.log(`\n=== Fee Check — ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PDT ===`);
  console.log('Checking: WETH/USDC Primary + 6 Raydium xStocks CLMMs\n');

  const [wethRes, raydiumRes] = await Promise.allSettled([
    getWethPosition(),
    getRaydiumPositions(),
  ]);

  const weth    = wethRes.status    === 'fulfilled' ? wethRes.value    : null;
  const raydium = raydiumRes.status === 'fulfilled' ? raydiumRes.value : [];

  console.log('\n--- Writing to Airtable ---');
  let written = 0;

  // WETH/USDC Primary
  if (weth) {
    const ok = await airtableCreate(DAILY_TABLE, [dailyRecord(ASSET.wethPrimary, weth.inRange, {
      [F.positionValue]: weth.positionValue,
      ...(weth.feeValue > 0 ? { [F.feeValue]: weth.feeValue } : {}),
      [F.notes]: `ETH: $${weth.ethPrice?.toFixed(0)} | Tick: ${weth.currentTick} | Range: [${weth.tickLower}, ${weth.tickUpper}] | Fee Check triggered manually`,
    })]);
    if (ok) { written++; console.log(`✓ WETH/USDC: $${weth.positionValue?.toFixed(2)}, fees: $${weth.feeValue?.toFixed(2)}`); }
  }

  // Raydium xStocks
  if (raydium.length > 0) {
    if (RAYDIUM_DRY_RUN) {
      console.log('\nRaydium DRY RUN — set RAYDIUM_DRY_RUN=false in GitHub Variables to go live');
      for (const pos of raydium) console.log(`  ${pos.key}: $${pos.positionValue.toFixed(2)}, fees: $${pos.pendingYield.toFixed(2)}, inRange: ${pos.inRange}`);
    } else {
      const batch = [];
      for (const pos of raydium) {
        const meta = ASSET[pos.key];
        if (!meta) continue;
        batch.push(dailyRecord(meta.recordId, pos.inRange, {
          [F.positionValue]: pos.positionValue,
          [F.cycleId]:       meta.cycleId,
          ...(pos.pendingYield > 0 ? { [F.feeValue]: pos.pendingYield } : {}),
          [F.notes]: `Raydium CLMM | ${pos.key.toUpperCase()} | Fee Check triggered manually${pos.pendingYield > 0 ? '' : ' | fees: out-of-range (no accumulation)'}`,
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

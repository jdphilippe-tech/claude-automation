import https from 'https';
import fs from 'fs';

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE = 'appWojaxYR99bXC1f';

if (!CLAUDE_API_KEY) { console.error('Missing CLAUDE_API_KEY'); process.exit(1); }
if (!AIRTABLE_API_KEY) { console.error('Missing AIRTABLE_API_KEY'); process.exit(1); }

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = { hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search, headers };
    const req = https.get(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error: ${body.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
  });
}

function httpsPost(hostname, path, headers, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function airtableGetAll(tableId, params) {
  let allRecords = [];
  let cursor = null;
  do {
    const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}?${params}${cursorParam}`;
    const resp = await httpsGet(url, { Authorization: `Bearer ${AIRTABLE_API_KEY}` });
    allRecords = allRecords.concat(resp.records || []);
    cursor = resp.nextCursor || null;
  } while (cursor);
  return allRecords;
}

async function getEthPrice() {
  try {
    const data = await httpsGet('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd');
    return { eth: data.ethereum?.usd, btc: data.bitcoin?.usd };
  } catch (e) {
    console.error('Price fetch error:', e.message);
    return { eth: null, btc: null };
  }
}

async function getFearGreed() {
  try {
    const data = await httpsGet('https://api.alternative.me/fng/?limit=1');
    return { value: data.data[0].value, label: data.data[0].value_classification };
  } catch (e) {
    console.error('Fear/greed fetch error:', e.message);
    return { value: null, label: null };
  }
}

async function getPSFData() {
  const fields = [
    'fldUkwrxtS4AEr52W', // Action Type
    'fldHG3MCcyhkXknyH', // Date
    'fldWElDtJZRYTaZtD', // Position Value
    'fld6QnTv9CKHvglcX', // Fee Value
    'fldE5uO0nwZmgLQtF', // Fees Claimed
    'fldFFts5ByR1EeYBk'  // Cycle ID
  ].map(f => `fields[]=${f}`).join('&');

  // Use filterByFormula to get only C8 records server-side
  const filter = encodeURIComponent("OR(FIND('WETH-PRIMARY-C8', {Cycle ID}), FIND('HEDGE-C8', {Cycle ID}))");
  const params = `${fields}&filterByFormula=${filter}&sort[0][field]=fldHG3MCcyhkXknyH&sort[0][direction]=asc`;

  console.log('Fetching C8 records with server-side filter...');
  const records = await airtableGetAll('tblKsk0QnkOoKNLuk', params);
  console.log(`C8 records found: ${records.length}`);

  const lpRecords = records.filter(r => (r.cellValuesByFieldId?.fldFFts5ByR1EeYBk || '').includes('WETH-PRIMARY-C8'));
  const hedgeRecords = records.filter(r => (r.cellValuesByFieldId?.fldFFts5ByR1EeYBk || '').includes('HEDGE-C8'));

  console.log(`LP records: ${lpRecords.length}, Hedge records: ${hedgeRecords.length}`);

  const lpOpen = lpRecords.find(r => r.cellValuesByFieldId?.fldUkwrxtS4AEr52W?.name === 'Reopen Position');
  const hedgeOpen = hedgeRecords.find(r => r.cellValuesByFieldId?.fldUkwrxtS4AEr52W?.name === 'Reopen Position');
  const lpLatest = [...lpRecords].reverse().find(r => r.cellValuesByFieldId?.fldUkwrxtS4AEr52W?.name === 'Fee Check');
  const hedgeLatest = [...hedgeRecords].reverse().find(r => r.cellValuesByFieldId?.fldUkwrxtS4AEr52W?.name === 'Fee Check');

  const lpOpenVal = lpOpen?.cellValuesByFieldId?.fldWElDtJZRYTaZtD || 0;
  const hedgeOpenVal = hedgeOpen?.cellValuesByFieldId?.fldWElDtJZRYTaZtD || 0;
  const lpNow = lpLatest?.cellValuesByFieldId?.fldWElDtJZRYTaZtD || 0;
  const hedgeNow = hedgeLatest?.cellValuesByFieldId?.fldWElDtJZRYTaZtD || 0;
  const pendingFees = lpLatest?.cellValuesByFieldId?.fld6QnTv9CKHvglcX || 0;
  const openDate = lpOpen?.cellValuesByFieldId?.fldHG3MCcyhkXknyH || '';
  const latestDate = lpLatest?.cellValuesByFieldId?.fldHG3MCcyhkXknyH || '';

  console.log(`LP open: $${lpOpenVal}, LP now: $${lpNow}, Hedge open: $${hedgeOpenVal}, Hedge now: $${hedgeNow}`);

  const totalClaimed = lpRecords
    .filter(r => r.cellValuesByFieldId?.fldUkwrxtS4AEr52W?.name === 'Claim')
    .reduce((sum, r) => sum + (r.cellValuesByFieldId?.fldE5uO0nwZmgLQtF || 0), 0);

  console.log(`Pending fees: $${pendingFees}, Total claimed: $${totalClaimed}`);

  const totalFees = totalClaimed + pendingFees;
  const lpPnl = lpNow - lpOpenVal;
  const hedgePnl = hedgeNow - hedgeOpenVal;
  const netDelta = lpPnl + hedgePnl;
  const netInclFees = netDelta + totalFees;
  const totalDeployed = lpOpenVal + hedgeOpenVal;

  const openTs = new Date(openDate).getTime();
  const latestTs = new Date(latestDate).getTime();
  const hours = (latestTs - openTs) / 3600000;
  const days = hours / 24;
  const avgDailyFee = hours > 0 ? (totalFees / hours) * 24 : 0;
  const pctReturn = totalDeployed > 0 ? (netInclFees / totalDeployed) * 100 : 0;
  const annualized = days > 0 ? (pctReturn / days) * 365 : 0;

  return { lpPnl, hedgePnl, netDelta, totalFees, avgDailyFee, netInclFees, totalDeployed, days: Math.round(days), pctReturn, annualized };
}

async function getLendingSnapshot() {
  const fields = [
    'fldFi5nwRXNC5n0pU',
    'fld5UpfU63qiYEZtp',
    'fldJLDy5yOHq8S6RS',
    'fldWHlp8HCuMYGc9e',
  ].map(f => `fields[]=${f}`).join('&');

  const params = `${fields}&sort[0][field]=fldxsDylRluE1PTJ7&sort[0][direction]=desc&pageSize=20`;
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/tblFw52kzeTRvxTSM?${params}`;
  const resp = await httpsGet(url, { Authorization: `Bearer ${AIRTABLE_API_KEY}` });
  const records = resp.records || [];

  const seen = new Set();
  const latest = [];
  for (const r of records) {
    const pos = r.cellValuesByFieldId?.fldFi5nwRXNC5n0pU?.[0]?.name || '';
    const action = r.cellValuesByFieldId?.fld5UpfU63qiYEZtp?.name || '';
    if (action === 'Rate Check' && !seen.has(pos)) {
      seen.add(pos);
      latest.push({ position: pos, supplyApy: r.cellValuesByFieldId?.fldJLDy5yOHq8S6RS, borrowApy: r.cellValuesByFieldId?.fldWHlp8HCuMYGc9e });
    }
  }
  return latest;
}

async function getXStocks() {
  const fields = [
    'fldtiRIqznncRfJYG',
    'fldUkwrxtS4AEr52W',
    'fldWElDtJZRYTaZtD',
    'fld6QnTv9CKHvglcX',
  ].map(f => `fields[]=${f}`).join('&');

  const params = `${fields}&sort[0][field]=fldErSlMumagkJ12S&sort[0][direction]=desc&pageSize=30`;
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/tblKsk0QnkOoKNLuk?${params}`;
  const resp = await httpsGet(url, { Authorization: `Bearer ${AIRTABLE_API_KEY}` });
  const records = resp.records || [];

  const xStockNames = ['TSLAx','NVDAx','AAPLx','GOOGLx','SPYx','CRCLx'];
  const seen = new Set();
  const latest = [];
  for (const r of records) {
    const asset = r.cellValuesByFieldId?.fldtiRIqznncRfJYG?.[0]?.name || '';
    const action = r.cellValuesByFieldId?.fldUkwrxtS4AEr52W?.name || '';
    const fees = r.cellValuesByFieldId?.fld6QnTv9CKHvglcX;
    if (action === 'Fee Check' && fees && !seen.has(asset) && xStockNames.some(t => asset.includes(t))) {
      seen.add(asset);
      latest.push({ asset, value: r.cellValuesByFieldId?.fldWElDtJZRYTaZtD, fees });
    }
  }
  return latest;
}

function getZoneInfo(ethPrice) {
  const center = 2080, nearDriftUpper = 2181, nearDriftLower = 1979;
  const driftUpper = 2224, driftLower = 1936;
  let zone;
  if (ethPrice >= driftUpper || ethPrice <= driftLower) zone = 'Drift Zone';
  else if (ethPrice >= nearDriftUpper || ethPrice <= nearDriftLower) zone = 'Near Drift Zone';
  else zone = 'Normal Zone';
  return { zone, distFromCenter: Math.round(ethPrice - center), roomToNearDriftUp: Math.round(nearDriftUpper - ethPrice), roomToNearDriftDown: Math.round(ethPrice - nearDriftLower) };
}

async function main() {
  console.log('Fetching all data...');
  const [prices, fearGreed, psf, lending, xstocks] = await Promise.all([
    getEthPrice(), getFearGreed(), getPSFData(), getLendingSnapshot(), getXStocks()
  ]);

  const zoneInfo = getZoneInfo(prices.eth || 2080);
  const notablexStock = xstocks.length > 0 ? xstocks.sort((a, b) => b.fees - a.fees)[0] : null;
  const virtualPos = lending.find(p => p.position.includes('VIRTUAL'));

  const dataSummary = {
    date: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' }),
    eth: { price: prices.eth, ...zoneInfo },
    btc: { price: prices.btc, wma200: 58000 },
    fearGreed,
    psf: {
      cycleDays: psf.days,
      lpPnl: Math.round(psf.lpPnl),
      hedgePnl: Math.round(psf.hedgePnl),
      netDelta: Math.round(psf.netDelta),
      totalFees: Math.round(psf.totalFees),
      avgDailyFee: Math.round(psf.avgDailyFee),
      netInclFees: Math.round(psf.netInclFees),
      totalDeployed: Math.round(psf.totalDeployed),
      pctReturn: psf.pctReturn.toFixed(1),
      annualized: Math.round(psf.annualized)
    },
    notablexStock: notablexStock ? { asset: notablexStock.asset, fees: Math.round(notablexStock.fees), value: Math.round(notablexStock.value) } : null,
    virtualApy: virtualPos?.supplyApy || null
  };

  console.log('Data summary:', JSON.stringify(dataSummary, null, 2));

  const systemPrompt = `You generate a daily morning audio brief for a DeFi portfolio manager named JD.
Return a JSON object with exactly two fields:
1. "brief": The full audio brief as pure conversational prose. No formatting, no line breaks, no markdown. Single flowing paragraph.
2. "description": A 1-2 sentence episode description summarizing what was notable today for the podcast app listing. Smart headline tone. Never start with "Good morning" or mention the date. Present tense.

Rules for the brief:
- Numbers spoken naturally: "two thousand and sixty dollars" not "$2,060"
- Say "Eth" not "ETH", "Bitcoin" not "BTC"
- Target 60-75 seconds when read aloud at 1.2x speed
- Structure: date -> Eth price and zone -> PSF strategy P&L -> one thing to watch -> market sentiment -> "Have a good one."
- For net delta: state LP direction and dollar amount, hedge direction and dollar amount, then net
- Always state: total fees, avg daily fee, net return including fees, annualized return
- Lending stable = one sentence only
- Never explain the strategy, just report numbers with judgment

IMPORTANT: Return ONLY raw JSON. No markdown, no backticks, no preamble. Start with { end with }.`;

  const response = await httpsPost('api.anthropic.com', '/v1/messages',
    { 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
    { model: 'claude-sonnet-4-20250514', max_tokens: 1200, system: systemPrompt, messages: [{ role: 'user', content: `Generate today's morning brief using this live data: ${JSON.stringify(dataSummary)}` }] }
  );

  let rawText = response.content?.[0]?.text;
  if (!rawText) { console.error('No response from Claude:', JSON.stringify(response)); process.exit(1); }
  rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  let parsed;
  try { parsed = JSON.parse(rawText); }
  catch (e) { console.error('Failed to parse Claude JSON:', rawText.slice(0, 500)); process.exit(1); }

  const { brief: briefText, description } = parsed;
  if (!briefText || !description) { console.error('Missing brief or description:', parsed); process.exit(1); }

  console.log('\nBrief:\n', briefText);
  console.log('\nDescription:\n', description);

  fs.writeFileSync('/tmp/brief.txt', briefText);
  fs.writeFileSync('/tmp/description.txt', description);
  fs.appendFileSync(process.env.GITHUB_ENV || '/dev/null', `BRIEF_TEXT_FILE=/tmp/brief.txt\nDESCRIPTION_FILE=/tmp/description.txt\n`);
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });

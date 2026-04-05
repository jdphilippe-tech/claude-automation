import https from 'https';
import fs from 'fs';

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE = 'appWojaxYR99bXC1f';

if (!CLAUDE_API_KEY) { console.error('Missing CLAUDE_API_KEY'); process.exit(1); }
if (!AIRTABLE_API_KEY) { console.error('Missing AIRTABLE_API_KEY'); process.exit(1); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers
    };
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

function airtableGet(tableId, params = '') {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}?${params}`;
  return httpsGet(url, { Authorization: `Bearer ${AIRTABLE_API_KEY}` });
}

// ── Data Fetching ─────────────────────────────────────────────────────────────

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
    'fldtiRIqznncRfJYG',
    'fldUkwrxtS4AEr52W',
    'fldHG3MCcyhkXknyH',
    'fldWElDtJZRYTaZtD',
    'fld6QnTv9CKHvglcX',
    'fldWLVUqSCRJ4NtnQ',
    'fldE5uO0nwZmgLQtF',
    'fldFFts5ByR1EeYBk'
  ].map(f => `fields[]=${f}`).join('&');

  const params = `${fields}&sort[0][field]=fldHG3MCcyhkXknyH&sort[0][direction]=asc`;
  const resp = await airtableGet('tblKsk0QnkOoKNLuk', params);
  const records = resp.records || [];

  console.log(`Total Daily Actions records: ${records.length}`);

  const c8Records = records.filter(r => {
    const cid = r.cellValuesByFieldId?.fldFFts5ByR1EeYBk || '';
    return cid.includes('WETH-PRIMARY-C8') || cid.includes('HEDGE-C8');
  });

  console.log(`C8 records found: ${c8Records.length}`);

  const lpRecords = c8Records.filter(r =>
    (r.cellValuesByFieldId?.fldFFts5ByR1EeYBk || '').includes('WETH-PRIMARY-C8')
  );
  const hedgeRecords = c8Records.filter(r =>
    (r.cellValuesByFieldId?.fldFFts5ByR1EeYBk || '').includes('HEDGE-C8')
  );

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

  console.log(`LP open: ${lpOpenVal}, LP now: ${lpNow}`);
  console.log(`Hedge open: ${hedgeOpenVal}, Hedge now: ${hedgeNow}`);
  console.log(`Pending fees: ${pendingFees}`);

  const totalClaimed = lpRecords
    .filter(r => r.cellValuesByFieldId?.fldUkwrxtS4AEr52W?.name === 'Claim')
    .reduce((sum, r) => sum + (r.cellValuesByFieldId?.fldE5uO0nwZmgLQtF || 0), 0);

  console.log(`Total claimed: ${totalClaimed}`);

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

  return {
    lpPnl, hedgePnl, netDelta, totalFees, avgDailyFee,
    netInclFees, totalDeployed, days: Math.round(days),
    pctReturn, annualized
  };
}

async function getLendingSnapshot() {
  const fields = [
    'fldFi5nwRXNC5n0pU',
    'fld5UpfU63qiYEZtp',
    'fldJ7T452iqgQNiWb',
    'fldTSqf1Yrxg7O0tr',
    'fldJLDy5yOHq8S6RS',
    'fldWHlp8HCuMYGc9e',
  ].map(f => `fields[]=${f}`).join('&');

  const params = `${fields}&sort[0][field]=fldxsDylRluE1PTJ7&sort[0][direction]=desc&maxRecords=20`;
  const resp = await airtableGet('tblFw52kzeTRvxTSM', params);
  const records = resp.records || [];

  const seen = new Set();
  const latest = [];
  for (const r of records) {
    const pos = r.cellValuesByFieldId?.fldFi5nwRXNC5n0pU?.[0]?.name || '';
    const action = r.cellValuesByFieldId?.fld5UpfU63qiYEZtp?.name || '';
    if (action === 'Rate Check' && !seen.has(pos)) {
      seen.add(pos);
      latest.push({
        position: pos,
        supplyValue: r.cellValuesByFieldId?.fldJ7T452iqgQNiWb,
        borrowValue: r.cellValuesByFieldId?.fldTSqf1Yrxg7O0tr,
        supplyApy: r.cellValuesByFieldId?.fldJLDy5yOHq8S6RS,
        borrowApy: r.cellValuesByFieldId?.fldWHlp8HCuMYGc9e,
      });
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

  const params = `${fields}&sort[0][field]=fldErSlMumagkJ12S&sort[0][direction]=desc&maxRecords=30`;
  const resp = await airtableGet('tblKsk0QnkOoKNLuk', params);
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
  return {
    zone,
    distFromCenter: Math.round(ethPrice - center),
    roomToNearDriftUp: Math.round(nearDriftUpper - ethPrice),
    roomToNearDriftDown: Math.round(ethPrice - nearDriftLower)
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching all data...');

  const [prices, fearGreed, psf, lending, xstocks] = await Promise.all([
    getEthPrice(),
    getFearGreed(),
    getPSFData(),
    getLendingSnapshot(),
    getXStocks()
  ]);

  const zoneInfo = getZoneInfo(prices.eth || 2080);
  const notablexStock = xstocks.length > 0 ? xstocks.sort((a, b) => b.fees - a.fees)[0] : null;
  const virtualPos = lending.find(p => p.position.includes('VIRTUAL'));

  const dataSummary = {
    date: new Date().toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      timeZone: 'America/Los_Angeles'
    }),
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
    notablexStock: notablexStock ? {
      asset: notablexStock.asset,
      fees: Math.round(notablexStock.fees),
      value: Math.round(notablexStock.value)
    } : null,
    virtualApy: virtualPos?.supplyApy || null
  };

  console.log('Data summary:', JSON.stringify(dataSummary, null, 2));

  // ── Call Claude API — generate both brief and episode description ──────────

  const systemPrompt = `You generate a daily morning audio brief for a DeFi portfolio manager named JD.
Return a JSON object with exactly two fields:
1. "brief": The full audio brief as pure conversational prose — no formatting, no line breaks, no markdown. Single flowing paragraph.
2. "description": A 1-2 sentence episode description that summarizes what was notable today. This is shown in the podcast app. It should feel like a smart headline — capturing the key signal of the day (zone status, strategy performance, market sentiment, or a notable position). Never start with "Good morning" or mention the date. Write it in present tense. Examples: "Eth holds Normal Zone as C8 fees average forty-eight dollars a day with the hedge nearly perfectly offsetting LP price drag. Fear and Greed sits at Extreme Fear eleven with Bitcoin stable above the two hundred week moving average." or "Eth drifts toward Near Drift Upper with the hedge carrying the strategy — total C8 return sits at two percent in thirteen days. Market sentiment remains Extreme Fear amid macro risk-off."

Rules for the brief:
- Numbers spoken naturally: "two thousand and sixty dollars" not "$2,060"
- Say "Eth" not "ETH", "Bitcoin" not "BTC"
- Target 60-75 seconds when read aloud at 1.2x speed
- Structure: date → Eth price and zone → PSF strategy P&L → one thing to watch → market sentiment → "Have a good one."
- For net delta: state LP direction and amount, hedge direction and amount, then net
- State total fees, avg daily fee, net return including fees, annualized return
- Lending stable = one sentence only
- Never explain the strategy, just report numbers with judgment
- Return ONLY valid JSON, no markdown, no code fences`;

  const userPrompt = `Generate today's morning brief and episode description using this live data: ${JSON.stringify(dataSummary)}`;

  const response = await httpsPost(
    'api.anthropic.com',
    '/v1/messages',
    {
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    }
  );

  const rawText = response.content?.[0]?.text;
  if (!rawText) {
    console.error('No response from Claude:', JSON.stringify(response));
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    console.error('Failed to parse Claude JSON response:', rawText.slice(0, 500));
    process.exit(1);
  }

  const briefText = parsed.brief;
  const description = parsed.description;

  if (!briefText || !description) {
    console.error('Missing brief or description in response:', parsed);
    process.exit(1);
  }

  console.log('\nBrief:\n', briefText);
  console.log('\nDescription:\n', description);

  fs.writeFileSync('/tmp/brief.txt', briefText);
  fs.writeFileSync('/tmp/description.txt', description);
  fs.appendFileSync(process.env.GITHUB_ENV || '/dev/null',
    `BRIEF_TEXT_FILE=/tmp/brief.txt\nDESCRIPTION_FILE=/tmp/description.txt\n`);

  console.log('Files saved.');
}

main().catch(e => { console.error(e); process.exit(1); });

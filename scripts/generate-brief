import https from 'https';
import fs from 'fs';

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE = 'appWojaxYR99bXC1f';

if (!CLAUDE_API_KEY) { console.error('Missing CLAUDE_API_KEY'); process.exit(1); }
if (!AIRTABLE_API_KEY) { console.error('Missing AIRTABLE_API_KEY'); process.exit(1); }

// ── Helpers ──────────────────────────────────────────────────────────────────

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error: ${body.slice(0, 200)}`)); }
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
        catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function airtableGet(path) {
  return httpsGet(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}${path}`,
    { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
  );
}

// ── Data Fetching ─────────────────────────────────────────────────────────────

async function getEthPrice() {
  try {
    const data = await httpsGet('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd');
    return { eth: data.ethereum.usd, btc: data.bitcoin.usd };
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

async function getAirtableRecords(tableId, fields, filterField, filterValue) {
  const fieldParams = fields.map(f => `fields[]=${f}`).join('&');
  const url = `/v0/${AIRTABLE_BASE}/${tableId}?${fieldParams}&sort[0][field]=fldHG3MCcyhkXknyH&sort[0][direction]=asc`;
  const resp = await httpsGet(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}?${fieldParams}&sort%5B0%5D%5Bdirection%5D=asc`,
    { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
  );
  return resp.records || [];
}

async function getPSFData() {
  // Get all C8 records for both LP and hedge
  const fields = ['fldtiRIqznncRfJYG','fldUkwrxtS4AEr52W','fldHG3MCcyhkXknyH',
                  'fldWElDtJZRYTaZtD','fld6QnTv9CKHvglcX','fldWLVUqSCRJ4NtnQ',
                  'fldE5uO0nwZmgLQtF','fldFFts5ByR1EeYBk'].join('&fields[]=');

  const resp = await httpsGet(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/tblKsk0QnkOoKNLuk?fields[]=${fields}&sort%5B0%5D%5Bfield%5D=fldHG3MCcyhkXknyH&sort%5B0%5D%5Bdirection%5D=asc`,
    { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
  );

  const records = (resp.records || []).filter(r => {
    const cid = r.cellValuesByFieldId?.fldFFts5ByR1EeYBk || '';
    return cid.includes('WETH-PRIMARY-C8') || cid.includes('HEDGE-C8');
  });

  // Separate LP and hedge
  const lpRecords = records.filter(r => (r.cellValuesByFieldId?.fldFFts5ByR1EeYBk || '').includes('WETH-PRIMARY-C8'));
  const hedgeRecords = records.filter(r => (r.cellValuesByFieldId?.fldFFts5ByR1EeYBk || '').includes('HEDGE-C8'));

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

  // Sum all claimed fees
  const totalClaimed = lpRecords
    .filter(r => r.cellValuesByFieldId?.fldUkwrxtS4AEr52W?.name === 'Claim')
    .reduce((sum, r) => sum + (r.cellValuesByFieldId?.fldE5uO0nwZmgLQtF || 0), 0);

  const totalFees = totalClaimed + pendingFees;
  const lpPnl = lpNow - lpOpenVal;
  const hedgePnl = hedgeNow - hedgeOpenVal;
  const netDelta = lpPnl + hedgePnl;
  const netInclFees = netDelta + totalFees;
  const totalDeployed = lpOpenVal + hedgeOpenVal;

  // Time-normalized avg daily fee
  const openTs = new Date(openDate).getTime();
  const latestTs = new Date(latestDate).getTime();
  const hours = (latestTs - openTs) / 3600000;
  const days = hours / 24;
  const avgDailyFee = (totalFees / hours) * 24;
  const pctReturn = (netInclFees / totalDeployed) * 100;
  const annualized = (pctReturn / days) * 365;

  return {
    lpPnl, hedgePnl, netDelta, totalFees, avgDailyFee,
    netInclFees, totalDeployed, days: Math.round(days),
    pctReturn, annualized
  };
}

async function getLendingRates() {
  const fields = ['fldFi5nwRXNC5n0pU','fld5UpfU63qiYEZtp','fldJ7T452iqgQNiWb',
                  'fldTSqf1Yrxg7O0tr','fldJLDy5yOHq8S6RS','fldWHlp8HCuMYGc9e'].join('&fields[]=');
  const resp = await httpsGet(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/tblFw52kzeTRvxTSM?fields[]=${fields}&sort%5B0%5D%5Bfield%5D=fldxsDylRluE1PTJ7&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=20`,
    { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
  );
  return resp.records || [];
}

async function getXStocks() {
  const fields = ['fldtiRIqznncRfJYG','fldUkwrxtS4AEr52W','fldWElDtJZRYTaZtD','fld6QnTv9CKHvglcX'].join('&fields[]=');
  const resp = await httpsGet(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/tblKsk0QnkOoKNLuk?fields[]=${fields}&sort%5B0%5D%5Bfield%5D=fldErSlMumagkJ12S&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=30`,
    { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
  );
  // Get latest fee check per xStock position
  const seen = new Set();
  const latest = [];
  for (const r of (resp.records || [])) {
    const asset = r.cellValuesByFieldId?.fldtiRIqznncRfJYG?.[0]?.name || '';
    const action = r.cellValuesByFieldId?.fldUkwrxtS4AEr52W?.name || '';
    const fees = r.cellValuesByFieldId?.fld6QnTv9CKHvglcX;
    if (action === 'Fee Check' && fees && !seen.has(asset) &&
        ['TSLAx','NVDAx','AAPLx','GOOGLx','SPYx','CRCLx'].some(t => asset.includes(t))) {
      seen.add(asset);
      latest.push({ asset, value: r.cellValuesByFieldId?.fldWElDtJZRYTaZtD, fees });
    }
  }
  return latest;
}

// ── Band calculations ─────────────────────────────────────────────────────────

function getBandZone(ethPrice) {
  const center = 2080, nearDriftUpper = 2181, nearDriftLower = 1979;
  const driftUpper = 2224, driftLower = 1936;
  if (ethPrice >= driftUpper || ethPrice <= driftLower) return 'Drift Zone';
  if (ethPrice >= nearDriftUpper || ethPrice <= nearDriftLower) return 'Near Drift Zone';
  return 'Normal Zone';
}

function getDistances(ethPrice) {
  return {
    fromCenter: ethPrice - 2080,
    toNearDriftUp: 2181 - ethPrice,
    toNearDriftDown: ethPrice - 1979
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching data...');

  const [prices, fearGreed, psf, lending, xstocks] = await Promise.all([
    getEthPrice(),
    getFearGreed(),
    getPSFData(),
    getLendingRates(),
    getXStocks()
  ]);

  const zone = getBandZone(prices.eth);
  const dist = getDistances(prices.eth);

  // Find notable xStock fee
  const notablexStock = xstocks.sort((a, b) => b.fees - a.fees)[0];

  // Build data summary to pass to Claude
  const dataSummary = {
    date: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' }),
    eth: { price: prices.eth, zone, distFromCenter: Math.round(dist.fromCenter), roomToNearDriftUp: Math.round(dist.toNearDriftUp), roomToNearDriftDown: Math.round(dist.toNearDriftDown) },
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
    notablexStock: notablexStock ? { asset: notablexStock.asset, fees: Math.round(notablexStock.fees), value: Math.round(notablexStock.value) } : null
  };

  console.log('Data fetched:', JSON.stringify(dataSummary, null, 2));

  // ── Call Claude API ───────────────────────────────────────────────────────

  const systemPrompt = `You generate a daily morning audio brief for a DeFi portfolio manager named JD. 
The brief is spoken aloud via text-to-speech so it must be pure conversational prose — no bullet points, no headers, no markdown.
Follow these rules exactly:
- Speak numbers naturally: "two thousand and sixty-two dollars" not "$2,062"  
- Say "Eth" not "ETH", "Bitcoin" not "BTC"
- Target 60-75 seconds when read aloud
- Structure: date → ETH zone → PSF strategy P&L → one thing to watch → market sentiment → "Have a good one."
- No scaffolding, no strategy explanations, just the signal
- For net delta: say whether LP is up or down, hedge is up or down, then the net
- Total fees and avg daily fee go in the strategy paragraph naturally
- Close lending section in one sentence if stable
- The brief must be a single paragraph of flowing prose with no line breaks between sections`;

  const userPrompt = `Generate today's morning brief using this live data: ${JSON.stringify(dataSummary)}`;

  const response = await httpsPost(
    'api.anthropic.com',
    '/v1/messages',
    {
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    }
  );

  const briefText = response.content?.[0]?.text;
  if (!briefText) {
    console.error('No brief text returned:', JSON.stringify(response));
    process.exit(1);
  }

  console.log('Brief generated:\n', briefText);

  // Save to file for next steps
  fs.writeFileSync('/tmp/brief.txt', briefText);
  fs.appendFileSync(process.env.GITHUB_ENV || '/dev/null', `BRIEF_TEXT_FILE=/tmp/brief.txt\n`);

  console.log('Brief saved to /tmp/brief.txt');
}

main().catch(e => { console.error(e); process.exit(1); });

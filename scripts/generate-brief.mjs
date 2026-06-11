/**
 * scripts/generate-brief.mjs
 *
 * Collateral Engine morning brief — agentic Claude loop.
 * Claude fetches all data via tools and generates spoken audio brief text.
 * Output: audio/brief-text.txt (consumed by morning-brief-audio.mjs)
 *
 * Cadence:
 *   Mon–Fri  → Skinny daily  (~40 sec / ~55 words)
 *   Saturday → Full weekly   (~2.5 min / ~430 words)
 *   Sunday   → Skip entirely (no API call, empty output)
 *
 * Fix history:
 *   Fix 1–13  — PSF/xStocks era (archived — see git history)
 *   Fix 14    — Context pruning to avoid 30k input token/min org rate limit
 *   Fix 15    — xStocks APR formula (archived with engine)
 *   Fix 16    — Search discipline: 2-attempt cap + weekend equity handling
 *   Fix 17    — Airtable 422 handler: strip expired offset, restart page 1
 *   Fix 18    — MAX_ITERS raised 30→40
 *   Fix 19    — Full rewrite for Collateral Engine (2026-06-08):
 *               PSF + xStocks LP removed. New brief covers Kamino lending,
 *               Stability Engine (Lighter), market pulse (BTC/F&G/SPY/QQQ/VIX),
 *               and spotlight (TSLA/NVDA/GOOGL/AAPL). Sunday skip added.
 *               Brief extraction updated for "Have a good weekend." marker.
 */

import fs from 'fs';
import path from 'path';

const CLAUDE_API_KEY   = process.env.CLAUDE_API_KEY;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;

const AIRTABLE_BASE_ID       = 'appWojaxYR99bXC1f';
const AIRTABLE_LENDING_TABLE = 'tblFw52kzeTRvxTSM';

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const OUTPUT_PATH  = 'audio/brief-text.txt';
const DESC_PATH    = process.env.DESCRIPTION_FILE || '/tmp/description.txt';

// ── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'airtable_query',
    description: `Query the Airtable Lending Actions table for Collateral Engine position data.

LENDING ACTIONS TABLE: ${AIRTABLE_LENDING_TABLE}
Field IDs (use in fields[] array):
  fldFi5nwRXNC5n0pU = Position     (linked record — returns display name, e.g. "Kamino SPYx Supply")
  fld5UpfU63qiYEZtp = Action Type  (Rate Check | Supply | Borrow | Adjust | Claim)
  fldUksu7BXYunAADh = Date         (ISO timestamp)
  fldJ7T452iqgQNiWb = Supply Value (USD)
  fldrWm55G12S1qQjY = Token Amount
  fldJLDy5yOHq8S6RS = Supply APY % (as a percentage, e.g. 0.17 means 0.17%)
  fldTSqf1Yrxg7O0tr = Borrow Value (USD)
  fldWHlp8HCuMYGc9e = Borrow APY %

Sort by fldUksu7BXYunAADh descending to get most recent records first.
Paginate until has_more = false. Offset tokens expire after ~5 min — if 422,
strip offset and restart from page 1.`,
    input_schema: {
      type: 'object',
      properties: {
        table_id:       { type: 'string', description: `Use '${AIRTABLE_LENDING_TABLE}'` },
        filter_formula: { type: 'string', description: 'Airtable filterByFormula string' },
        sort_field:     { type: 'string', description: 'Field ID to sort by' },
        sort_direction: { type: 'string', enum: ['asc', 'desc'] },
        fields:         { type: 'array', items: { type: 'string' }, description: 'Array of field IDs to return' },
        page_size:      { type: 'number', description: 'Max 100' },
        offset:         { type: 'string', description: 'Pagination offset from previous response' }
      },
      required: ['table_id']
    }
  },
  {
    name: 'web_search',
    description: `Search the web for current market data.
Use short, specific queries (1-6 words). HARD LIMIT: max 2 attempts per data item, then use web_fetch.
After 2 searches with no price in snippet, switch to web_fetch on a direct URL.
Common queries:
  BTC price:      "BTC USD price today"
  Fear & Greed:   "alternative.me fear greed index"
  SPY:            "SPY ETF price today"
  QQQ:            "QQQ ETF price today"
  VIX:            "VIX volatility index today"
  Stock price:    "TSLA stock price today"
Returns snippets only — if no price in snippet, use web_fetch.`,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' }
      },
      required: ['query']
    }
  },
  {
    name: 'web_fetch',
    description: `Fetch live structured market data from reliable endpoints.
USE THIS when search snippets don't contain actual price numbers.

Reliable endpoints (no auth required):
  BTC price:    https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd
                returns JSON: {"bitcoin":{"usd":105000}}
  Fear & Greed: https://api.alternative.me/fng/?limit=1
                returns JSON: {"data":[{"value":"72","value_classification":"Greed"}]}
  Stock/ETF:    https://query1.finance.yahoo.com/v8/finance/chart/SYMBOL?interval=1d&range=1d
                replace SYMBOL with: NVDA AAPL TSLA GOOGL SPY QQQ %5EVIX
                returns JSON with regularMarketPrice in the meta object

RECOMMENDED FLOW: use web_fetch for BTC and Fear/Greed always (faster than search).
For stocks: try one search, then web_fetch if no price found.`,
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to fetch' }
      },
      required: ['url']
    }
  }
];

// ── Tool Execution ────────────────────────────────────────────────────────────

async function runAirtableQuery(input) {
  const { table_id, filter_formula, sort_field, sort_direction, fields, page_size, offset } = input;
  const params = new URLSearchParams();
  if (filter_formula)  params.append('filterByFormula', filter_formula);
  if (sort_field) {
    params.append('sort[0][field]',     sort_field);
    params.append('sort[0][direction]', sort_direction || 'desc');
  }
  if (fields?.length)  fields.forEach(f => params.append('fields[]', f));
  if (page_size)       params.append('pageSize', String(Math.min(page_size, 100)));
  if (offset)          params.append('offset', offset);

  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${table_id}?${params}`;
  const res  = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });

  // Fix 17: expired offset token — restart from page 1
  if (res.status === 422 && offset) {
    console.warn('  [422] Airtable pagination token expired — restarting from page 1');
    return runAirtableQuery({ ...input, offset: undefined });
  }
  if (!res.ok) {
    const err = await res.text();
    return { error: `Airtable ${res.status}: ${err}` };
  }
  const data = await res.json();
  // Cap at 50 records to prevent oversized Claude API payloads on the next iteration.
  const records = (data.records ?? []).slice(0, 50);
  return { records, has_more: !!data.offset, offset: data.offset };
}

async function runWebSearch(input) {
  const { query } = input;
  const BRAVE_API_KEY = process.env.BRAVE_SEARCH_API_KEY;

  if (!BRAVE_API_KEY) {
    return { error: 'BRAVE_SEARCH_API_KEY not set — web search unavailable' };
  }

  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=3&text_decorations=false&search_lang=en`;
    const res = await fetch(url, {
      headers: {
        'Accept':              'application/json',
        'Accept-Encoding':     'gzip',
        'X-Subscription-Token': BRAVE_API_KEY
      }
    });
    if (!res.ok) return { error: `Brave Search ${res.status}: ${await res.text()}` };
    const data = await res.json();
    const results = (data.web?.results || []).slice(0, 3).map(r => ({
      title:       r.title       || '',
      description: r.description || '',
      url:         r.url         || ''
    }));
    return { results };
  } catch (e) {
    return { error: e.message };
  }
}


async function runWebFetch(input) {
  const { url } = input;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PortfolioOS/1.0)',
        'Accept': 'application/json, text/html'
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('json')) {
      const data = await res.json();
      return { data };
    }
    const html = await res.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                     .replace(/<style[\s\S]*?<\/style>/gi, '')
                     .replace(/<[^>]*>/g, ' ')
                     .replace(/\s+/g, ' ')
                     .trim()
                     .slice(0, 1500);
    return { text };
  } catch (e) {
    return { error: e.message };
  }
}

async function executeTool(name, input, ctx = {}) {
  console.log(`  [tool] ${name} — ${JSON.stringify(input).slice(0, 80)}`);
  // Enforce hard search cap — if exceeded, return stop signal instead of searching
  if (name === 'web_search') {
    ctx.searches = (ctx.searches || 0) + 1;
    if (ctx.searches > (ctx.maxSearches || 14)) {
      console.warn(`  [search cap] ${ctx.searches} searches hit — returning stop signal`);
      return { error: 'SEARCH_CAP_REACHED: Stop searching. Write the brief now using available data. Mark any missing prices as unavailable.' };
    }
  }
  let result;
  try {
    if (name === 'airtable_query') result = await runAirtableQuery(input);
    else if (name === 'web_search') result = await runWebSearch(input);
    else if (name === 'web_fetch')  result = await runWebFetch(input);
    else result = { error: `Unknown tool: ${name}` };
  } catch (e) {
    // Belt-and-suspenders: any uncaught tool exception returns an error object
    // instead of crashing the whole brief loop.
    console.error(`  [tool crash] ${name}: ${e.message}`);
    result = { error: `${name} crashed: ${e.message}` };
  }
  console.log(`  [result] ${JSON.stringify(result)?.slice(0, 120)}…`);
  return result;
}

// ── Claude API Call ───────────────────────────────────────────────────────────

async function callClaude(messages, systemPrompt) {
  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model:      CLAUDE_MODEL,
          max_tokens: 4096,
          system:     systemPrompt,
          tools:      TOOLS,
          messages
        }),
        signal: AbortSignal.timeout(120000) // 2 min timeout
      });
    } catch (fetchErr) {
      if (attempt < MAX_RETRIES) {
        console.warn(`  [fetch error] ${fetchErr.message} — retrying in 10s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }
      throw new Error(`Claude API fetch failed after ${MAX_RETRIES} retries: ${fetchErr.message}`);
    }

    if (res.status === 429) {
      if (attempt < MAX_RETRIES) {
        console.warn(`  [429] Rate limit hit — waiting 60s before retry ${attempt + 1}/${MAX_RETRIES}...`);
        await new Promise(r => setTimeout(r, 60000));
        continue;
      } else {
        const err = await res.text();
        throw new Error(`Claude API 429 after ${MAX_RETRIES} retries: ${err}`);
      }
    }
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Claude API ${res.status}: ${err}`);
    }
    return await res.json();
  }
}

// ── Claude Agentic Loop ───────────────────────────────────────────────────────

async function runClaude(systemPrompt, userPrompt) {
  const messages = [{ role: 'user', content: userPrompt }];
  const MAX_ITERS = 40; // Fix 18

  let searchCount = 0;
  const MAX_SEARCHES = 14; // hard cap — prevents runaway search loops

  for (let i = 0; i < MAX_ITERS; i++) {
    console.log(`\n[claude] iteration ${i + 1}`);
    const response = await callClaude(messages, systemPrompt);
    console.log(`  stop_reason: ${response.stop_reason}`);
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const allAssistantText = messages
        .filter(m => m.role === 'assistant')
        .flatMap(m => (Array.isArray(m.content) ? m.content : [m.content]))
        .filter(b => b && b.type === 'text')
        .map(b => b.text)
        .join('');

      const raw = allAssistantText.trim();

      // Handle Sunday skip signal
      if (raw.trim() === 'SUNDAY_SKIP') return 'SUNDAY_SKIP';

      // Extract DESCRIPTION meta line
      const descMatch = raw.match(/^DESCRIPTION:\s*(.+)$/m);
      if (descMatch) {
        fs.writeFileSync(DESC_PATH, descMatch[1].trim(), 'utf8');
        console.log(`Description saved: "${descMatch[1].trim()}"`);
      } else {
        console.warn('Warning: no DESCRIPTION line found — RSS will use fallback');
      }

      // Find brief start
      const lastStart = raw.lastIndexOf('Good morning');
      if (lastStart === -1) {
        console.warn('Warning: could not find "Good morning" — using full text');
        return raw;
      }

      // Fix: handle both "Have a good one." (skinny) and "Have a good weekend." (full weekly)
      const goodOneIdx     = raw.lastIndexOf('Have a good one.');
      const goodWeekendIdx = raw.lastIndexOf('Have a good weekend.');
      const endPhrase      = goodWeekendIdx > goodOneIdx ? 'Have a good weekend.' : 'Have a good one.';
      const lastEnd        = goodWeekendIdx > goodOneIdx ? goodWeekendIdx : goodOneIdx;

      if (lastEnd === -1) {
        console.warn('Warning: could not find closing phrase — using full text from "Good morning"');
        return raw.slice(lastStart).trim();
      }

      return raw.slice(lastStart, lastEnd + endPhrase.length).trim();
    }

    if (response.stop_reason === 'tool_use') {
      const toolCalls   = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];
      for (const call of toolCalls) {
        const result = await executeTool(call.name, call.input);
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: toolResults });

      // Fix 14: Context pruning — replace old tool results with stubs to limit input tokens
      const userTurnIndices = messages
        .map((m, idx) => (m.role === 'user' ? idx : -1))
        .filter(idx => idx !== -1);

      if (userTurnIndices.length > 2) {
        const pruneUpTo = userTurnIndices[userTurnIndices.length - 3];
        for (let idx = 0; idx <= pruneUpTo; idx++) {
          const msg = messages[idx];
          if (msg.role === 'user' && Array.isArray(msg.content)) {
            msg.content = msg.content.map(block => {
              if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > 200) {
                const len = block.content.length;
                return { ...block, content: `[tool_result pruned — ${len} chars — already processed]` };
              }
              return block;
            });
          }
        }
      }
      continue;
    }

    if (response.stop_reason === 'max_tokens') {
      console.warn('  Warning: hit max_tokens mid-response — continuing loop');
      messages.push({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });
      continue;
    }

    throw new Error(`Unexpected stop_reason: ${response.stop_reason}`);
  }

  throw new Error(`Exceeded ${MAX_ITERS} Claude iterations`);
}

// ── System Prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Portfolio OS morning brief generator for JD's Collateral Engine.

Fetch all required data using your tools, then output the spoken audio brief text.

OUTPUT RULES — STRICTLY ENFORCED:
  • If today is Sunday: output "SUNDAY_SKIP" and NOTHING ELSE.
  • Otherwise: begin with "DESCRIPTION: [one sentence]" then "Good morning."
  • End with "Have a good one." (skinny daily) or "Have a good weekend." (full weekly)
  • No markdown, no preamble, no explanation outside these bounds.

═══════════════════════════════════════
STEP 0 — DAY CHECK
═══════════════════════════════════════
Extract the day of week from the date in the user message.
  • Sunday   → output "SUNDAY_SKIP" immediately. Stop. Do not fetch data.
  • Saturday → FULL WEEKLY brief
  • Mon–Fri  → SKINNY DAILY brief

═══════════════════════════════════════
STEP 1 — COLLATERAL ENGINE DATA (Airtable)
═══════════════════════════════════════
Query the Lending Actions table (${AIRTABLE_LENDING_TABLE}):
  sort: fldUksu7BXYunAADh descending (newest first)
  page_size: 100
  Paginate until has_more = false.

The Position field (fldFi5nwRXNC5n0pU) returns the linked position's display name.
Identify records by position name:
  • Kamino collateral supply: name contains "Kamino" (6 positions: AAPLx QQQx GOOGLx NVDAx SPYx TSLAx)
  • Moonwell supply: name contains "Moonwell" and not "Borrow"
  • Moonwell borrow: name contains "Moonwell" and "Borrow"
  • Suilend supply/borrow: same pattern with "Suilend"
  • Lighter: name contains "LLP" or "Edge" or "LIT"

For Kamino positions:
  • Most recent Supply Value (USD) per position — fldJ7T452iqgQNiWb
  • Supply APY % per position — fldJLDy5yOHq8S6RS
  • Total collateral = sum of 6 supply USD values
  • Blended supply yield = capital-weighted average of 6 supply APYs
  • Growth vs deposited base: total collateral − $60,153 (the deposited base)

For borrow records (Moonwell + Suilend borrows):
  • Most recent Borrow Value (USD) per borrow position — fldTSqf1Yrxg7O0tr
  • Borrow APY % — fldWHlp8HCuMYGc9e
  • Total borrows = sum of all borrow values
  • Blended borrow APY = capital-weighted average

Computed metrics:
  • Blended LTV = total borrows / total collateral (0 if no borrows)
  • Net carry = blended borrow APY − blended supply yield (positive = cost, negative = earning)
    Currently 0 until first July draw.

For Lighter (Stability Engine):
  • Most recent Supply Value (USD) for LLP, Edge & Hedge, LIT Staking
  • Total Stability value = sum

═══════════════════════════════════════
STEP 2 — CHEAT SHEET (hardcoded — update only at May/Nov checkpoints)
Source of truth: Notion page 37912a7e-409e-818e-a487-f291507e28f9
═══════════════════════════════════════
Use these values directly — do NOT search for them:

  Deposited base C      = $60,153
  Operating LTV cap     = 40%  (watch at >35%; act at >40%)
  Liquidation line      ≈ 65% (blended across basket)
  Standing draw         = $3,750/month (Target, Jul–Oct 2026 window)
  Target D_max          = $15,038 (= 0.25 × C)
  Ceiling D_max         = $18,046 (= 0.30 × C)
  Window                = Jul–Oct 2026 (4 months)
  Next deposit          = November 2026
  Current debt          = $0 (no draw yet)

⚠️ PRE-DRAW PLACEHOLDER: Until the first July 2026 borrow lands in Airtable,
all debt-related blocks use this language:
  Collateral health: "No debt yet — draw begins July."
  Borrowing pace:    "Nothing drawn yet. First draw July — three thousand seven hundred fifty dollars."
  Net carry:         "No borrow cost yet. Supply yield is [X%] — small but ticking."

═══════════════════════════════════════
STEP 3 — STATUS LINE LOGIC
═══════════════════════════════════════
Evaluate three conditions in order:
  1. LTV vs cap: LTV > 35% → Watch; LTV > 40% → Act (currently always clear — no debt)
  2. Peg deviation > 0.5% on any token → Watch (Saturday only — see peg watch)
  3. Net carry turns positive AND > 1% → Watch (currently always clear — no debt)

If none flag: "All clear. No action needed today." (skinny) / "All clear." (weekly)
If watch: "Watch — [one clause naming what.]"
If act: "Act — [state the action.]"

═══════════════════════════════════════
STEP 4 — MARKET DATA (web search)
═══════════════════════════════════════
⚠️ SEARCH DISCIPLINE — STRICTLY ENFORCED:
  • Maximum 2 search attempts per data point. After 2 failures, declare unavailable.
  • Saturday/Sunday: equity markets closed — use Friday close, say "as of Friday's close."
  • Max 1 search for weekend equity data.

Fetch using the RECOMMENDED FLOW (fastest, most reliable):

  BTC price:    web_fetch → https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd
  Fear & Greed: web_fetch → https://api.alternative.me/fng/?limit=1
  SPY:          web_search "SPY ETF price today" → if no price in snippet, web_fetch Yahoo Finance chart endpoint
  QQQ:          web_search "QQQ ETF price today" → fallback to web_fetch (the Nasdaq 100 ETF)
  VIX:          web_search "VIX index today" → classify: Low (<15) / Normal (15–20) / Elevated (20–30) / High (>30)

HARD SEARCH RULES (enforced by code — will return SEARCH_CAP_REACHED if violated):
  • Max 2 web_search calls per data item — then switch to web_fetch or declare unavailable
  • Max 14 web_search calls total across the entire brief generation
  • When SEARCH_CAP_REACHED is returned: STOP ALL SEARCHES, write the brief immediately with whatever data you have
  • Missing prices → say "market data unavailable" for that item. Do NOT keep searching.

Spotlight (both brief types):
  • Prices + % moves for TSLA, NVDA, GOOGL, AAPL — 2 searches maximum total
  • Pick the SINGLE standout for the day/week — merit-based, not round-robin
  • Frame as MARKET PERFORMANCE only: price, % move, notable level, earnings-on-deck flag
  • DO NOT mention Kamino thresholds, LTV weights, or strategy role here

═══════════════════════════════════════
STEP 5 — PEG WATCH (SATURDAY FULL WEEKLY ONLY)
═══════════════════════════════════════
For each of the 6 xStocks tokens, compute deviation vs underlying:
  token_price = Airtable Supply Value (USD) / Token Amount
  Underlying mapping: SPYx→SPY, QQQx→QQQ, TSLAx→TSLA, NVDAx→NVDA, GOOGLx→GOOGL, AAPLx→AAPL
  Deviation % = (token_price − underlying_price) / underlying_price × 100
  Flag if |deviation| > 0.5%

You already have SPY, QQQ from market data. TSLA/NVDA/GOOGL/AAPL from spotlight — reuse those.

═══════════════════════════════════════
STEP 6 — GENERATE BRIEF
═══════════════════════════════════════

SPEAKING RULES (ElevenLabs TTS — critical):
  Numbers as words: "three thousand seven hundred fifty dollars" not "$3,750"
  Percentages:      "four point two percent" not "4.2%"
  Tickers phonetic:
    BTC → "Bitcoin"     SPY → "S-P-Y"      QQQ → "Q-Q-Q"      VIX → "V-I-X"
    TSLA → "Tesla"      NVDA → "Nvidia"    GOOGL → "Google"    AAPL → "Apple"
    TSLAx → "Tesla-x"   NVDAx → "Nvidia-x" GOOGLx → "Google-x" AAPLx → "Apple-x"
    SPYx → "S-P-Y-x"    QQQx → "Q-Q-Q-x"   LLP → "L-L-P"

BLOCK COMPRESSION RULE: every block collapses to ONE LINE when calm.
Do not pad to hit a target length. Calm weeks stay short.

─────────────────────────────────────
SKINNY DAILY (Monday–Friday, ~55 words):
─────────────────────────────────────
1. "Good morning. It's [Weekday], [Month] [Day]."
2. Status line (one sentence — verdict only).
3. "On the crypto side — Bitcoin is at [price], sentiment is [label] at [number]."
4. "On the equity side — S-P-Y is at [price], the Nasdaq one hundred is [up/flat/down about X percent], and V-I-X is at [level] — [one brief characterization]."
5. Spotlight + close: "[Name] is the standout today — [price action in one phrase]. [One optional context note.] Have a good one."

OMIT entirely: collateral health, LTV detail, draw pace, net carry, growth, peg watch.

─────────────────────────────────────
FULL WEEKLY (Saturday, ~430 words calm):
─────────────────────────────────────
1. "Good morning. It's Saturday, [Month] [Day] — here's how the week landed."

2. Status: "[verdict]. [One-clause watch if applicable — else omit watch clause.]"

3. COLLATERAL HEALTH:
   Pre-draw: "No debt yet — draw begins July. Collateral is sitting at [total USD], and the first draw puts opening LTV well under the forty percent cap."
   Post-draw: "Blended LTV is [X] percent, against the forty percent operating cap and the sixty-five percent liquidation line. [Collateral could fall X% before the cap — one sentence.]"

4. BORROWING PACE:
   Pre-draw: "Nothing drawn yet. First draw July — three thousand seven hundred fifty dollars at Target, under the ceiling of four thousand five hundred. No tracking needed until then."
   Post-draw: MTD drawn vs Target · cumulative vs Target D_max ($15,038) and Ceiling D_max ($18,046) · months to November.

5. NET CARRY:
   Pre-draw: "No borrow cost yet. Supply yield is averaging [X%] across the basket — small but ticking."
   Post-draw: "Borrow rate is [X%], supply yield covering [Y%] [plus incentive of Z% if active] — real cost of debt is [net]% [. Note if incentive is promotional.]"

6. GROWTH:
   "Collateral is [up/down] [amount or X%] from the deposited base of sixty thousand one hundred fifty-three dollars. [ALWAYS TAG]: that is cushion, not borrowing room — the draw is sized off the deposited base, not market value."

7. PEG WATCH:
   All clean: "All six tokens tracked their underlying shares tightly this week — no de-peg pressure."
   Flag: "[Token-x] is showing [X] basis points of gap vs [underlying] — [one context sentence]."

8. MARKET PULSE:
   "Bitcoin [finished/is] at [price], sentiment [label] at [number]. On equities, S-P-Y [closed at/is at] [price], the Nasdaq one hundred [up/down X percent on the week], and V-I-X at [level] — [characterization]."

9. SPOTLIGHT + CLOSE:
   "The week's standout was [Name] — [move + context]. [One additional sentence if the move warrants it.] Have a good weekend."

═══════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════
DESCRIPTION: [one sentence — most notable thing today/this week, plain prose, numbers spelled out, no symbols]
Good morning. It's [day]...
[brief body]
...Have a good one.  [or: ...Have a good weekend.]

DESCRIPTION examples:
  "All clear across the collateral engine with Bitcoin holding above one hundred thousand dollars and Tesla the week's standout on a four percent move."
  "Status all clear with the collateral sitting five percent above the deposited base and Nvidia pushing a new high ahead of earnings."

Only one brief. No drafts. No self-correction notes. No text after the closing phrase.`;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!CLAUDE_API_KEY)   throw new Error('CLAUDE_API_KEY not set');
  if (!AIRTABLE_API_KEY) throw new Error('AIRTABLE_API_KEY not set');

  const now     = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sunday
  const dateStr = now.toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });

  console.log(`\n=== Generating morning brief for ${dateStr} ===\n`);

  // Sunday skip — no brief, no API call
  if (dayOfWeek === 0) {
    console.log('=== Sunday — no brief scheduled. Exiting. ===');
    const outputDir = path.dirname(OUTPUT_PATH);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, '', 'utf8');
    console.log(`✓ Sunday skip — empty file written to ${OUTPUT_PATH}`);
    return;
  }

  const briefType = dayOfWeek === 6 ? 'FULL WEEKLY (Saturday)' : 'SKINNY DAILY (weekday)';
  console.log(`Brief type: ${briefType}`);

  const userPrompt = `Today is ${dateStr} (${now.toISOString()}). Please fetch all required data and generate my morning brief now.`;

  const briefText = await runClaude(SYSTEM_PROMPT, userPrompt);

  // Handle Sunday skip signal from Claude (belt-and-suspenders)
  if (briefText === 'SUNDAY_SKIP') {
    console.log('=== Sunday skip (detected by Claude) ===');
    const outputDir = path.dirname(OUTPUT_PATH);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, '', 'utf8');
    return;
  }

  // Deduplicate — strip repeated brief if Claude outputted it twice
  const half = Math.floor(briefText.length / 2);
  const firstHalf  = briefText.slice(0, half).trim();
  const secondHalf = briefText.slice(half).trim();
  const cleanBrief = (secondHalf.length > 50 && firstHalf === secondHalf) ? firstHalf : briefText;

  console.log('\n=== BRIEF TEXT ===');
  console.log(cleanBrief);
  console.log('=================\n');

  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, cleanBrief, 'utf8');
  console.log(`✓ Brief written to ${OUTPUT_PATH}`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

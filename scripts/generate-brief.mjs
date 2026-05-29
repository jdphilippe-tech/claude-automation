/**
 * scripts/generate-brief.mjs
 *
 * Calls the Claude API with tool definitions so Claude autonomously fetches
 * all data it needs — Airtable (with full pagination), Notion band params,
 * and live market prices — then writes the morning audio brief.
 *
 * Output: writes brief text to audio/brief-text.txt for the next step
 * (morning-brief-audio.mjs) to consume.
 *
 * Architecture: Claude tool use (agentic loop)
 * Claude fetches its own data — nothing is pre-fetched and passed to it.
 * This eliminates the pagination bug where Reopen Position records were
 * missed because they live on page 2+ of Airtable results.
 *
 * Fixes applied 2026-04-12:
 *   Fix 1 — System prompt hardened with single-output rule to prevent
 *            Claude rewriting the brief multiple times in one response.
 *   Fix 2 — Extraction uses lastIndexOf('Good morning') + lastIndexOf
 *            ('Have a good one.') so only the final clean version is
 *            captured even if Claude does produce multiple drafts.
 *
 * Fixes applied 2026-04-14:
 *   Fix 3 — 429 rate limit retry with 60s backoff instead of Fatal crash.
 *   Fix 4 — max_tokens reduced from 4096 to 2048 to slow context growth.
 *            (Reversed by Fix 10 — 2048 was insufficient for expanded brief.)
 *   Fix 5 — System prompt band values removed — Claude now fetches current
 *            cycle band values from Notion at runtime instead of using
 *            hardcoded C8 values that go stale every cycle.
 *
 * Fixes applied 2026-05-19:
 *   Fix 6 — Removed duplicate net price delta dollar amount from P&L sentence.
 *            Delta balance sentence now carries the number — not both.
 *   Fix 7 — Removed net return (fees + delta) as primary performance metric.
 *            Replaced with Fee APR = total fees / total deployed × annualized.
 *            total deployed = LP open + hedge open (full capital normalization).
 *            Net price delta reported separately as health indicator only.
 *
 * Fixes applied 2026-05-19 (2):
 *   Fix 8 — Removed Notion dependency for band values. Band levels now derived
 *            from cycle open ETH price already in Airtable Reopen Position Notes.
 *            Formula: Center = open ETH price, Band ±180, Drift ±144, Near Drift ±87.
 *            notion_fetch tool and NOTION_API_KEY no longer needed for band values.
 *
 * Fixes applied 2026-05-27:
 *   Fix 9 — Added xStocks block to brief. xStocks data fetched from Airtable
 *            using Cycle IDs containing ticker suffixes (TSLAx, SPYx, NVDAx,
 *            CRCLx, AAPLx, GOOGLx). Block mirrors PSF block structure:
 *            weighted blended fee APR, avg daily fees, avg cycle age, OOR
 *            detection with 2-consecutive-weekday escalation, one thing to
 *            watch, and market close with SPY + VIX instead of BTC + ETH vol.
 *            Brief flow: Date → ETH/PSF zone → PSF P&L → PSF watch →
 *            PSF market close → xStocks P&L → xStocks watch → xStocks market.
 *
 * Fixes applied 2026-05-27 (2):
 *   Fix 10 — max_tokens raised from 2048 → 4096. Expanded brief (PSF + xStocks)
 *            was hitting the token ceiling mid-sentence during final generation,
 *            causing multiple max_tokens continuations, context fragmentation,
 *            and loss of the "Good morning"/"Have a good one." markers.
 *   Fix 11 — xStocks weighted blended APR now computed as capital-weighted
 *            average of per-position APRs, not aggregate-fees/aggregate-capital
 *            annualized by avg days. Each position's APR = (fees / open value)
 *            × (365 / own days). Blend = Σ(APR × open value) / Σ(open value).
 *            This correctly handles mixed-age positions (e.g. day-1 positions
 *            alongside day-30 positions) without annualization distortion.
 *   Fix 12 — Positions with 0 elapsed days (opened same day, no full day yet)
 *            are excluded from the blended APR and flagged in spoken text as
 *            "too new to rate" so they don't distort the blended figure.
 *   Fix 13 — Brief extraction now scans ALL assistant text blocks across the
 *            full message history, not just the final response block. Prevents
 *            marker loss when Claude resumes mid-brief after a max_tokens split.
 *
 * Fixes applied 2026-05-29:
 *   Fix 14 — Context pruning added to runClaude(). After each tool result has
 *            been consumed (i.e. once Claude has replied to it), the raw payload
 *            is replaced with a short stub in the message history. This prevents
 *            accumulated Airtable 100-record payloads from blowing past the
 *            30,000 input tokens/minute org rate limit by iterations 4+.
 *            Stub format: "[tool_result pruned — N chars — already processed]"
 */

import fs from 'fs';
import path from 'path';

const CLAUDE_API_KEY   = process.env.CLAUDE_API_KEY;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;

const AIRTABLE_BASE_ID       = 'appWojaxYR99bXC1f';
const AIRTABLE_DAILY_TABLE   = 'tblKsk0QnkOoKNLuk';
const AIRTABLE_LENDING_TABLE = 'tblFw52kzeTRvxTSM';

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const OUTPUT_PATH  = 'audio/brief-text.txt';
const DESC_PATH    = process.env.DESCRIPTION_FILE || '/tmp/description.txt';

// ── Tool Definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'airtable_query',
    description: `Query the Airtable REST API directly.

DAILY ACTIONS TABLE: ${AIRTABLE_DAILY_TABLE}
Field IDs:
  fldUkwrxtS4AEr52W = Action Type  (Fee Check | Reopen Position | Close Position | Claim | Open Position)
  fldHG3MCcyhkXknyH = Date         (ISO timestamp — sort ascending to get oldest first)
  fldWElDtJZRYTaZtD = Position Value
  fld6QnTv9CKHvglcX = Fee Value    (pending fees, only on Fee Check records)
  fldE5uO0nwZmgLQtF = Fees Claimed (only on Claim records)
  fldFFts5ByR1EeYBk = Cycle ID     (e.g. WETH-PRIMARY-C9, HEDGE-C9, TSLAx-C2, SPYx-C1)
  fldxWdSuQ09uhadFo = Notes        (HEDGE Fee Check records contain "PnL: $XX.XX | Entry: $XXXX | Size: -X.X ETH")
  fldQxXuK9uTwRQsX8 = In Range     (1 = in range, 0 = out of range — present on Fee Check records)

LENDING ACTIONS TABLE: ${AIRTABLE_LENDING_TABLE}

PAGINATION IS REQUIRED. Always pass the offset from each response into the
next call until has_more = false. The Reopen Position records that
define opening deposit values are the OLDEST records in the cycle — they
will NOT appear on the first page when sorted descending. You MUST paginate
through all pages sorted ascending to find them.

For PSF data use filterByFormula:
  OR(FIND('WETH-PRIMARY-C',{Cycle ID}),FIND('HEDGE-C',{Cycle ID}))
Sort ascending by fldHG3MCcyhkXknyH so Reopen Position records come first.

For xStocks data use filterByFormula:
  OR(FIND('TSLAx',{Cycle ID}),FIND('SPYx',{Cycle ID}),FIND('NVDAx',{Cycle ID}),FIND('CRCLx',{Cycle ID}),FIND('AAPLx',{Cycle ID}),FIND('GOOGLx',{Cycle ID}))
Sort ascending by fldHG3MCcyhkXknyH. Always paginate fully.`,
    input_schema: {
      type: 'object',
      properties: {
        table_id: {
          type: 'string',
          description: `Airtable table ID. Use '${AIRTABLE_DAILY_TABLE}' for PSF/xStock data, '${AIRTABLE_LENDING_TABLE}' for lending rates.`
        },
        filter_formula: {
          type: 'string',
          description: 'Airtable filterByFormula string (URL-encoded automatically by the tool)'
        },
        sort_field: {
          type: 'string',
          description: 'Field ID to sort by'
        },
        sort_direction: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'asc = oldest first (use this to find Reopen/Open Position records). desc = newest first.'
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of field IDs to return. Always include fldFFts5ByR1EeYBk (Cycle ID), fldUkwrxtS4AEr52W (Action Type), and fldxWdSuQ09uhadFo (Notes). For xStocks also include fldQxXuK9uTwRQsX8 (In Range). Request ONLY the fields you need.'
        },
        page_size: {
          type: 'number',
          description: 'Records per page. Max 100. Use 100 to minimize API calls.'
        },
        offset: {
          type: 'string',
          description: 'Pagination offset token from previous response. Omit for first page. MUST be passed to get all records including Reopen/Open Position.'
        }
      },
      required: ['table_id']
    }
  },
  {
    name: 'web_search',
    description: `Search the web for current market data.
Use short, specific queries:
- ETH price: "ETH USD price today"
- BTC price: "BTC USD price today"
- Fear & Greed: "alternative.me fear greed index"
- SPY price: "SPY ETF price today"
- VIX: "VIX volatility index today"
- ETH volatility: "ETH 30 day volatility"
Returns a summary of top results.`,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' }
      },
      required: ['query']
    }
  }
];

// ── Tool Execution ──────────────────────────────────────────────────────────

async function runAirtableQuery(input) {
  const { table_id, filter_formula, sort_field, sort_direction, fields, page_size, offset } = input;

  const params = new URLSearchParams();
  if (filter_formula)  params.append('filterByFormula', filter_formula);
  if (sort_field) {
    params.append('sort[0][field]', sort_field);
    params.append('sort[0][direction]', sort_direction || 'asc');
  }
  if (fields?.length)  fields.forEach(f => params.append('fields[]', f));
  if (page_size)       params.append('pageSize', String(Math.min(page_size, 100)));
  if (offset)          params.append('offset', offset);

  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${table_id}?${params}`;
  const res  = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
  });

  if (!res.ok) {
    const err = await res.text();
    return { error: `Airtable ${res.status}: ${err}` };
  }

  const data = await res.json();
  return {
    records:        data.records,
    offset:         data.offset || null,
    total_returned: data.records?.length ?? 0,
    has_more:       !!data.offset
  };
}

async function runWebSearch(input) {
  const { query } = input;
  const BRAVE_API_KEY = process.env.BRAVE_SEARCH_API_KEY;

  if (!BRAVE_API_KEY) {
    return { error: 'BRAVE_SEARCH_API_KEY not set — web search unavailable' };
  }

  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=3&text_decorations=false&search_lang=en`;
    const res  = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': BRAVE_API_KEY
      }
    });
    if (!res.ok) {
      return { error: `Brave Search ${res.status}: ${await res.text()}` };
    }
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

async function executeTool(name, input) {
  console.log(`  [tool] ${name} — ${JSON.stringify(input).substring(0, 100)}`);
  let result;
  switch (name) {
    case 'airtable_query': result = await runAirtableQuery(input); break;
    case 'web_search':     result = await runWebSearch(input);     break;
    default:               result = { error: `Unknown tool: ${name}` };
  }
  const preview = JSON.stringify(result).substring(0, 120);
  console.log(`  [result] ${preview}${preview.length >= 120 ? '…' : ''}`);
  return result;
}

// ── Claude API call with 429 retry ──────────────────────────────────────────

async function callClaude(messages, systemPrompt) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 60000; // 60 seconds

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
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
      })
    });

    if (res.status === 429) {
      if (attempt < MAX_RETRIES) {
        console.warn(`  [429] Rate limit hit — waiting 60s before retry ${attempt}/${MAX_RETRIES - 1}...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
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

// ── Claude Agentic Loop ─────────────────────────────────────────────────────

async function runClaude(systemPrompt, userPrompt) {
  const messages = [{ role: 'user', content: userPrompt }];
  const MAX_ITERS = 30;

  for (let i = 0; i < MAX_ITERS; i++) {
    console.log(`\n[claude] iteration ${i + 1}`);

    const response = await callClaude(messages, systemPrompt);
    console.log(`  stop_reason: ${response.stop_reason}`);

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      // Fix 13: Scan ALL assistant text blocks across the entire message history.
      // When Claude hits max_tokens mid-brief and resumes via "Continue.", the
      // "Good morning" marker may be in an earlier assistant block while "Have a
      // good one." is in a later one. Concatenating all blocks recovers the full brief.
      const allAssistantText = messages
        .filter(m => m.role === 'assistant')
        .flatMap(m => (Array.isArray(m.content) ? m.content : [m.content]))
        .filter(b => b && b.type === 'text')
        .map(b => b.text)
        .join('');

      const raw = allAssistantText.trim();

      // Extract DESCRIPTION line if present and save to DESC_PATH
      const descMatch = raw.match(/^DESCRIPTION:\s*(.+)$/m);
      if (descMatch) {
        const description = descMatch[1].trim();
        fs.writeFileSync(DESC_PATH, description, 'utf8');
        console.log(`Description saved: "${description}"`);
      } else {
        console.warn('Warning: no DESCRIPTION line found — RSS will use fallback');
      }

      // Fix 2: Use lastIndexOf to extract only the final clean brief,
      // discarding any earlier drafts or self-revision Claude may have output.
      const lastStart = raw.lastIndexOf('Good morning');
      const lastEnd   = raw.lastIndexOf('Have a good one.');

      if (lastStart === -1 || lastEnd === -1) {
        console.warn('Warning: could not find brief markers — using full text');
        return raw;
      }

      return raw.slice(lastStart, lastEnd + 'Have a good one.'.length).trim();
    }

    if (response.stop_reason === 'tool_use') {
      const toolCalls = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];
      for (const call of toolCalls) {
        const result = await executeTool(call.name, call.input);
        toolResults.push({
          type:        'tool_result',
          tool_use_id: call.id,
          content:     JSON.stringify(result)
        });
      }
      messages.push({ role: 'user', content: toolResults });

      // Fix 14: Context pruning — once Claude has replied to a tool result,
      // that raw payload is no longer needed in full. Replace older tool_result
      // messages (anything before the last two user turns) with a short stub
      // to keep input token count below the 30k/min org rate limit.
      // We keep the last two user turns intact so Claude always has the
      // most recent tool results available for reasoning.
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
                const originalLen = block.content.length;
                return {
                  ...block,
                  content: `[tool_result pruned — ${originalLen} chars — already processed]`
                };
              }
              return block;
            });
          }
        }
      }

      continue;
    }

    // max_tokens during reasoning — continue so Claude can finish
    if (response.stop_reason === 'max_tokens') {
      console.warn('  Warning: hit max_tokens mid-response — continuing loop');
      messages.push({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });
      continue;
    }

    throw new Error(`Unexpected stop_reason: ${response.stop_reason}`);
  }

  throw new Error(`Exceeded ${MAX_ITERS} Claude iterations`);
}

// ── System Prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the morning brief generator for JD's Portfolio OS — a personal DeFi portfolio management system with two parallel cashflow engines: PSF (delta-neutral ETH LP) and xStocks (tokenized equity LP on Raydium).

Your job: fetch all required data using your tools, compute everything yourself, and return the spoken audio brief text. Nothing else — no JSON wrapper, no markdown, no preamble, no explanation. Your ENTIRE response must start with "Good morning." and end with "Have a good one." Any text before "Good morning" or after "Have a good one." will be stripped and discarded.

═══════════════════════════════════════
SECTION 1 — PSF (DELTA-NEUTRAL ETH LP)
═══════════════════════════════════════

STEP 1 — Band Values (derived from Airtable cycle open price)
Do NOT fetch Notion for band values. Instead, derive them from the cycle open ETH price
you will read from Airtable in Step 2.

The cycle open ETH price is in the Notes field of the earliest Reopen Position record
for WETH-PRIMARY-C[n]. The Notes field looks like:
  "ETH: $2226 | Tick: -XXXXX | Range: [-XXXXXX, -XXXXXX]"
Extract the ETH price after "ETH: $".

Then compute all band levels using the fixed 360-point band formula:
  • Center            = cycle open ETH price (rounded to nearest dollar)
  • Band Upper        = Center + 180
  • Band Lower        = Center − 180
  • Drift Upper       = Center + 144
  • Drift Lower       = Center − 144
  • Near Drift Upper  = Center + 87
  • Near Drift Lower  = Center − 87

STEP 2 — PSF Cycle Data (Airtable Daily Actions)
Query table ${AIRTABLE_DAILY_TABLE} with:
  filterByFormula: OR(FIND('WETH-PRIMARY-C',{Cycle ID}),FIND('HEDGE-C',{Cycle ID}))
  sort: fldHG3MCcyhkXknyH ascending (oldest first)
  fields: fldUkwrxtS4AEr52W, fldHG3MCcyhkXknyH, fldWElDtJZRYTaZtD, fld6QnTv9CKHvglcX, fldE5uO0nwZmgLQtF, fldFFts5ByR1EeYBk, fldxWdSuQ09uhadFo
  page_size: 100

⚠️  PAGINATION IS MANDATORY. Keep calling airtable_query with the offset from
each response until has_more = false.

From the complete record set, determine:
  • Current cycle number = highest number in Cycle ID (e.g. C9 from WETH-PRIMARY-C9)
  • LP open value       = Position Value on earliest Reopen Position for WETH-PRIMARY-C[n]
  • Hedge open value    = Position Value on earliest Reopen Position for HEDGE-C[n]
  • Total deployed      = LP open + hedge open
  • LP current value    = Position Value on latest Fee Check for WETH-PRIMARY-C[n]
  • Hedge current value = Position Value on latest Fee Check for HEDGE-C[n]
  • Pending fees        = Fee Value on latest Fee Check for WETH-PRIMARY-C[n]
  • Total claimed       = sum of all Fees Claimed on all Claim records for WETH-PRIMARY-C[n]
  • Total fees          = total claimed + pending fees
  • LP PnL              = LP current − LP open
  • Hedge PnL           = READ from Notes field on latest HEDGE-C[n] Fee Check.
                          The Notes field contains "PnL: $48.95 | Entry: $2078.1 | Size: -5.5 ETH".
                          Extract the dollar amount after "PnL: $". Can be negative.
                          NEVER compute hedge PnL from position value delta.
  • Net price delta     = LP PnL + Hedge PnL
  • Delta balance       = |Net price delta|
  • Delta tolerance     = Normal Zone: 0.5% of LP current value | Near Drift Zone: 0.25%
  • Cycle open date     = Date on earliest Reopen Position for WETH-PRIMARY-C[n]
  • Elapsed hours       = hours from cycle open date to now
  • Days in cycle       = floor(elapsed hours / 24) — whole number only
  • Avg daily fee       = (total fees / elapsed hours) × 24
  • Fee APR             = (total fees / total deployed) × (365 / days in cycle) × 100
                          NEVER use LP current value alone as denominator.
                          NEVER add net price delta to fees.

STEP 3 — PSF Market Data (web search)
  • ETH current price
  • BTC current price
  • Crypto Fear & Greed index — search "alternative.me fear greed index". Extract number
    and label (e.g. "28 — Fear"). If no specific number found, say "Market sentiment data
    was unavailable at brief time." Do NOT guess.
  • ETH 30-day volatility or ATR — to assess whether 360-point band remains appropriate.

STEP 4 — PSF Zone Determination
Zone rules:
  • Between Near Drift Lower and Near Drift Upper → Normal Zone
  • Between Drift Lower and Near Drift Lower OR between Near Drift Upper and Drift Upper → Near Drift Zone
  • Below Drift Lower OR above Drift Upper → Drift Zone (flag clearly, action required)

═══════════════════════════════════════
SECTION 2 — xSTOCKS (TOKENIZED EQUITY LP)
═══════════════════════════════════════

STEP 5 — xStocks Cycle Data (Airtable Daily Actions)
Query table ${AIRTABLE_DAILY_TABLE} with:
  filterByFormula: OR(FIND('TSLAx',{Cycle ID}),FIND('SPYx',{Cycle ID}),FIND('NVDAx',{Cycle ID}),FIND('CRCLx',{Cycle ID}),FIND('AAPLx',{Cycle ID}),FIND('GOOGLx',{Cycle ID}))
  sort: fldHG3MCcyhkXknyH ascending (oldest first)
  fields: fldUkwrxtS4AEr52W, fldHG3MCcyhkXknyH, fldWElDtJZRYTaZtD, fld6QnTv9CKHvglcX, fldE5uO0nwZmgLQtF, fldFFts5ByR1EeYBk, fldxWdSuQ09uhadFo, fldQxXuK9uTwRQsX8
  page_size: 100

⚠️  PAGINATION IS MANDATORY. Keep calling with offset until has_more = false.

The 6 active positions are: TSLAx, SPYx, NVDAx, CRCLx, AAPLx, GOOGLx.
Each has its own Cycle ID (e.g. TSLAx-C2, SPYx-C1, NVDAx-C3, etc.)
The current cycle for each ticker = the highest cycle number seen in the records for that ticker.

For EACH position, determine:
  • Ticker           = extracted from Cycle ID prefix (e.g. TSLAx)
  • Open value       = Position Value on earliest Open Position or Reopen Position record for this ticker's current cycle
  • Current value    = Position Value on latest Fee Check for this ticker's current cycle
  • Pending fees     = Fee Value on latest Fee Check for this ticker's current cycle
  • Total claimed    = sum of all Fees Claimed on Claim records for this ticker's current cycle
  • Total fees       = total claimed + pending fees
  • Cycle open date  = Date on earliest Open/Reopen Position record for this ticker's current cycle
  • Elapsed hours    = hours from cycle open date to now
  • Days in cycle    = floor(elapsed hours / 24) — whole number only
  • Avg daily fee    = (total fees / elapsed hours) × 24
  • Fee APR          = (total fees / open value) × (365 / days in cycle) × 100
                       Use open value (capital deployed at open) as denominator.
                       If days in cycle = 0 (position opened today, less than 24hrs old):
                         → Mark as "too new to rate" — EXCLUDE from blended APR entirely.
                         → Note it in spoken text: "[Ticker] opened today — APR not yet meaningful."
  • OOR status       = In Range field (fldQxXuK9uTwRQsX8) on the latest Fee Check:
                       1 = in range, 0 = out of range
  • OOR consecutive  = Count the number of consecutive most-recent Fee Check records
                       where In Range = 0. A "consecutive weekday OOR streak" means
                       2 or more Fee Check records with In Range = 0 with no in-range
                       record between them. Weekends are non-trading days — if the
                       OOR records span a weekend gap, they still count as consecutive
                       for this purpose (the position was OOR going into the weekend
                       and OOR coming out).

Then compute AGGREGATE xStocks metrics:
  • Eligible positions        = positions where days in cycle ≥ 1 (exclude 0-day positions)
  • Too-new positions         = positions where days in cycle = 0 (opened today)
  • Total deployed (xStocks)  = sum of open values across ALL 6 positions
  • Total fees (xStocks)      = sum of total fees across ALL 6 positions
  • Total avg daily fee       = sum of avg daily fees across ALL 6 positions
  • Avg days in cycle         = floor(average of days in cycle across ALL 6 positions) — whole number
  • Weighted blended fee APR  = capital-weighted average of per-position Fee APRs
                                for ELIGIBLE positions only (days ≥ 1).

                                Formula:
                                  Weighted Blended APR = Σ(position_APR × open_value) / Σ(open_value)
                                  where the sum is only over eligible positions.

                                Example:
                                  CRCLx: APR=63%, open=$1,579 → contribution = 63 × 1579 = 99,477
                                  NVDAx: APR=28%, open=$2,100 → contribution = 28 × 2100 = 58,800
                                  SPYx:  APR=41%, open=$3,200 → contribution = 41 × 3200 = 131,200
                                  TSLAx: days=0, EXCLUDED
                                  AAPLx: days=0, EXCLUDED
                                  Blended APR = (99477 + 58800 + 131200) / (1579 + 2100 + 3200) = 41.8%

                                This correctly handles mixed-age positions — a day-1 position
                                earning fees over its own actual 1 day gets its own real APR,
                                not under-annualized by a longer avg days figure.
                                If no eligible positions exist, skip APR entirely.
  • OOR positions             = list of tickers where latest Fee Check In Range = 0
  • Action-needed OOR         = list of tickers with consecutive OOR streak ≥ 2 weekday
                                Fee Check records — these require rebalancing per playbook

STEP 6 — xStocks Market Data (web search)
  • SPY ETF current price and direction (up/down from previous close)
  • VIX current level — classify as: Low (<15), Normal (15–20), Elevated (20–30), High (>30)

═══════════════════════════════════════
BRIEF FORMAT (follow exactly, in order)
═══════════════════════════════════════

──────────────────────
BLOCK 1: Date
──────────────────────
"Good morning. It's [Weekday], [Month] [Day]."

──────────────────────
BLOCK 2: ETH + PSF Zone
──────────────────────
Normal Zone:
  "Eth is at [price], sitting in Normal Zone. You have about [distance] dollars of breathing room before Near Drift. No action needed."
Near Drift Zone:
  "Eth is at [price], in Near Drift Zone — [distance] dollars from the Drift boundary. Monitor closely."
Drift Zone:
  "Eth is at [price] and has crossed into Drift Zone. Action may be required — review the position."

──────────────────────
BLOCK 3: PSF P&L
──────────────────────
"The current delta neutral strategy cycle is [X] days in. The LP is [up/down] [amount] on price since open, the hedge is [up/down] [amount]. Delta balance is [amount], which is [within/outside] tolerance for [Normal/Near Drift] Zone. [If outside tolerance: hedge adjustment may be needed.] Total fees this cycle are [amount], averaging about [amount] a day — a fee rate of around [fee APR]% annualized on total deployed capital."

KEY RULES:
- Do NOT repeat net price delta dollar amount before the delta balance sentence.
- Fee APR is fees-only. Never mix delta into APR.
- State fee APR as whole number or one decimal spoken as words.

──────────────────────
BLOCK 4: PSF One Thing to Watch
──────────────────────
"One thing to watch on the delta neutral side: [single most notable item — two sentences max. Examples: delta outside tolerance, position approaching Drift, unclaimed fees building on LP, cooldown period status.]"

──────────────────────
BLOCK 5: PSF Market Close
──────────────────────
"On the crypto side — market sentiment is [label] at [number]. Bitcoin is at [price]. [Band width verdict — one sentence: is 360-point band still appropriate given current ETH volatility?]"

──────────────────────
BLOCK 6: xStocks P&L
──────────────────────
"Switching to the equity side. The six xStocks positions are averaging [X] days into their current cycles. Total fees across all positions are [amount], averaging about [amount] a day — a blended fee rate of around [blended APR]% annualized on deployed capital. [If any position has days = 0: "[Ticker] opened today — APR not yet meaningful."] [If any position OOR but streak < 2: "[Ticker] is currently out of range — watching it."] [If any position with streak ≥ 2: "[Ticker] has been out of range for [N] consecutive sessions — rebalancing required per playbook."]"

NOTE: The blended APR is the capital-weighted average of eligible positions only (days ≥ 1).
If ALL positions are too new (all days = 0), omit the APR sentence entirely and say
"All positions opened today — fee rate not yet meaningful."

──────────────────────
BLOCK 7: xStocks One Thing to Watch
──────────────────────
"One thing to watch on the equity side: [single most notable item — two sentences max. Examples: specific position with high unclaimed fees, a position with unusually high or low APR, a position approaching its range boundary, a rebalancing action due.]"

──────────────────────
BLOCK 8: xStocks Market Close
──────────────────────
"On the equity side — S-P-Y is at [price], [up/down] on the day. The VIX is at [level], which is [Low/Normal/Elevated/High] — [one sentence: what this means for xStocks range management, e.g. 'range boundaries are holding comfortably' or 'elevated volatility increases out-of-range risk across all positions' or 'compressed volatility is keeping positions well-centered']. Have a good one."

═══════════════════════════════════════
SPEAKING RULES — CRITICAL
═══════════════════════════════════════

ElevenLabs will read this text aloud. Numbers must be written as words:
  ✓ "two thousand and fifty-eight dollars"    ✗ "$2,058"
  ✓ "one hundred and forty-six dollars"       ✗ "$146"
  ✓ "sixty-four percent"                      ✗ "64%"
  ✓ "thirty thousand dollars"                 ✗ "$30,000"
  ✓ "sixteen days"                            ✗ "16 days" or "sixteen point one days"
  ✓ "S-P-Y"  (hyphenated so ElevenLabs spells it) ✗ "SPY"
  ✓ "VIX" is fine as-is — ElevenLabs reads it correctly
  ✓ "LP" is fine as-is

Tickers must be phonetic:
  ETH → "Eth"   BTC → "Bitcoin"   USDC → "U-S-D-C"
  TSLAx → "Tesla-x"   SPYx → "S-P-Y-x"   NVDAx → "Nvidia-x"
  CRCLx → "C-R-C-L-x"   AAPLx → "Apple-x"   GOOGLx → "Google-x"

Never use raw ticker symbols. Never explain band structure or hedge mechanics.
Target length: 90–120 seconds at 1.2× speed (~200–260 words).

═══════════════════════════════════════
OUTPUT RULES — CRITICAL
═══════════════════════════════════════

Output the brief EXACTLY ONCE, preceded by a single description line.

FORMAT YOUR ENTIRE RESPONSE LIKE THIS:
DESCRIPTION: [one sentence — the single most notable thing across BOTH strategies today, plain prose, no symbols]
Good morning. It's [day]...
[rest of brief]
...Have a good one.

DESCRIPTION line rules:
- Must be the very first line of your response
- One sentence only, ending with a period
- Plain prose — spell out numbers, no dollar signs, percent signs, or ticker symbols
- Capture the most actionable or notable thing today across either strategy
- Examples:
  "Delta neutral cycle sits in Normal Zone with fees averaging fifty dollars a day while all six equity positions remain in range."
  "Near Drift alert on the crypto side while Tesla-x has been out of range for two consecutive sessions requiring rebalancing."
  "Strong fee momentum across both strategies with a blended equity rate above forty percent and the delta neutral cycle on pace."

- If you catch an error or inconsistency while writing, correct it silently and continue.
- Do not restart. Do not show multiple drafts. Do not explain your reasoning.
- Do not include anything after "Have a good one." — not a note, not a correction, nothing.

═══════════════════════════════════════
EXAMPLE OUTPUT — MATCH THIS STYLE EXACTLY
═══════════════════════════════════════

DESCRIPTION: Delta neutral cycle holds in Normal Zone while the equity side shows strong blended fee momentum with all six positions in range.

Good morning. It's Friday, April 4th.

Eth is at two thousand and fifty-eight dollars, sitting in Normal Zone. You have about one hundred and twenty dollars of breathing room before Near Drift. No action needed.

The current delta neutral strategy cycle is thirteen days in. The LP is down one hundred and forty-six dollars on price since open, the hedge is up one hundred and seventy-eight dollars. Delta balance is thirty-two dollars, within tolerance for Normal Zone. Total fees this cycle are six hundred and fifteen dollars, averaging about fifty-one dollars a day — a fee rate of around forty-one percent annualized on total deployed capital.

One thing to watch on the delta neutral side: pending fees on the LP are approaching three hundred dollars — worth deciding today whether to claim or let them compound into the weekend.

On the crypto side — market sentiment is Extreme Fear at nine. Bitcoin is at sixty-six thousand eight hundred dollars. Volatility looks normal — the three-sixty point band remains appropriate.

Switching to the equity side. The six xStocks positions are averaging eleven days into their current cycles. Total fees across all positions are four hundred and twenty dollars, averaging about thirty-eight dollars a day — a blended fee rate of around thirty-four percent annualized on total deployed capital. C-R-C-L-x is currently out of range — watching it.

One thing to watch on the equity side: C-R-C-L-x has three hundred and twenty-two dollars in unclaimed fees on a fifteen hundred dollar position — worth deciding today whether to claim or wait for rebalancing.

On the equity side — S-P-Y is at five hundred and twelve dollars, down on the day. The VIX is at eighteen, which is Normal — range boundaries are holding comfortably across all positions. Have a good one.`;

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!CLAUDE_API_KEY)   throw new Error('CLAUDE_API_KEY not set');
  if (!AIRTABLE_API_KEY) throw new Error('AIRTABLE_API_KEY not set');

  const now     = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });

  console.log(`\n=== Generating morning brief for ${dateStr} ===\n`);

  const userPrompt = `Today is ${dateStr} (${now.toISOString()}). Please fetch all required data and generate my morning brief now.`;

  const briefText = await runClaude(SYSTEM_PROMPT, userPrompt);

  // Deduplicate — if Claude returns the brief twice in one response, strip the repeat
  const half = Math.floor(briefText.length / 2);
  const firstHalf  = briefText.slice(0, half).trim();
  const secondHalf = briefText.slice(half).trim();
  const cleanBrief = (secondHalf.length > 50 && firstHalf === secondHalf)
    ? firstHalf
    : briefText;

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

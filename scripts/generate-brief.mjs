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
 */

import fs from 'fs';
import path from 'path';

const CLAUDE_API_KEY   = process.env.CLAUDE_API_KEY;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;

const AIRTABLE_BASE_ID     = 'appWojaxYR99bXC1f';
const AIRTABLE_DAILY_TABLE = 'tblKsk0QnkOoKNLuk';
const AIRTABLE_LENDING_TABLE = 'tblFw52kzeTRvxTSM';

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const OUTPUT_PATH  = 'audio/brief-text.txt';

// ── Tool Definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'airtable_query',
    description: `Query the Airtable REST API directly.

DAILY ACTIONS TABLE: ${AIRTABLE_DAILY_TABLE}
Field IDs:
  fldUkwrxtS4AEr52W = Action Type  (Fee Check | Reopen Position | Close Position | Claim)
  fldHG3MCcyhkXknyH = Date         (ISO timestamp — sort ascending to get oldest first)
  fldWElDtJZRYTaZtD = Position Value
  fld6QnTv9CKHvglcX = Fee Value    (pending fees, only on Fee Check records)
  fldE5uO0nwZmgLQtF = Fees Claimed (only on Claim records)
  fldFFts5ByR1EeYBk = Cycle ID     (e.g. WETH-PRIMARY-C8, HEDGE-C8)
  fldxWdSuQ09uhadFo = Notes        (HEDGE Fee Check records contain "PnL: $XX.XX | Entry: $XXXX | Size: -X.X ETH")

LENDING ACTIONS TABLE: ${AIRTABLE_LENDING_TABLE}

PAGINATION IS REQUIRED. Always pass the offset from each response into the
next call until no offset is returned. The Reopen Position records that
define opening deposit values are the OLDEST records in the cycle — they
will NOT appear on the first page when sorted descending. You MUST paginate
through all pages sorted ascending to find them.

For PSF data use filterByFormula:
  OR(FIND('WETH-PRIMARY-C',{Cycle ID}),FIND('HEDGE-C',{Cycle ID}))
Sort ascending by fldHG3MCcyhkXknyH so Reopen Position records come first.`,
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
          description: 'asc = oldest first (use this to find Reopen Position records). desc = newest first.'
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of field IDs to return. Always include fldFFts5ByR1EeYBk (Cycle ID), fldUkwrxtS4AEr52W (Action Type), and fldxWdSuQ09uhadFo (Notes — required for hedge PnL).'
        },
        page_size: {
          type: 'number',
          description: 'Records per page. Max 100.'
        },
        offset: {
          type: 'string',
          description: 'Pagination offset token from previous response. Omit for first page. MUST be passed to get all records including Reopen Position.'
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
- Fear & Greed: "crypto fear greed index"
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
    records: data.records,
    offset: data.offset || null,
    total_returned: data.records?.length ?? 0,
    has_more: !!data.offset
  };
}

async function runWebSearch(input) {
  const { query } = input;
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  try {
    const res  = await fetch(url);
    const data = await res.json();
    return {
      answer:   data.Answer   || '',
      abstract: data.Abstract || '',
      results:  (data.RelatedTopics || [])
                  .slice(0, 5)
                  .map(t => t.Text || '')
                  .filter(Boolean)
    };
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

// ── Claude Agentic Loop ─────────────────────────────────────────────────────

async function runClaude(systemPrompt, userPrompt) {
  const messages = [{ role: 'user', content: userPrompt }];
  const MAX_ITERS = 25;

  for (let i = 0; i < MAX_ITERS; i++) {
    console.log(`\n[claude] iteration ${i + 1}`);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       CLAUDE_API_KEY,
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

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Claude API ${res.status}: ${err}`);
    }

    const response = await res.json();
    console.log(`  stop_reason: ${response.stop_reason}`);

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      if (!textBlock) throw new Error('end_turn but no text block');
      return textBlock.text.trim();
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
      continue;
    }

    throw new Error(`Unexpected stop_reason: ${response.stop_reason}`);
  }

  throw new Error(`Exceeded ${MAX_ITERS} Claude iterations`);
}

// ── System Prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the morning brief generator for JD's Portfolio OS — a personal DeFi portfolio management system.

Your job: fetch all required data using your tools, compute everything yourself, and return the spoken audio brief text. Nothing else — no JSON wrapper, no markdown, just the words to be spoken aloud.

═══════════════════════════════════════
DATA FETCHING INSTRUCTIONS
═══════════════════════════════════════

STEP 1 — PSF Cycle Data (Airtable Daily Actions)
Query table ${AIRTABLE_DAILY_TABLE} with:
  filterByFormula: OR(FIND('WETH-PRIMARY-C',{Cycle ID}),FIND('HEDGE-C',{Cycle ID}))
  sort: fldHG3MCcyhkXknyH ascending (oldest first)
  fields: fldUkwrxtS4AEr52W, fldHG3MCcyhkXknyH, fldWElDtJZRYTaZtD, fld6QnTv9CKHvglcX, fldE5uO0nwZmgLQtF, fldFFts5ByR1EeYBk, fldxWdSuQ09uhadFo

⚠️  PAGINATION IS MANDATORY. Keep calling airtable_query with the offset from
each response until has_more = false. The Reopen Position records you need to
determine opening deposit values are the OLDEST records — they will only appear
once you have paginated through all pages. Do not stop after one page.

From the complete record set, determine:
  • Current cycle number = highest number in Cycle ID (e.g. C8 from WETH-PRIMARY-C8)
  • LP open value       = Position Value on earliest Reopen Position for WETH-PRIMARY-C[n]
  • Hedge open value    = Position Value on earliest Reopen Position for HEDGE-C[n]
  • Total deployed      = LP open + Hedge open
  • LP current value    = Position Value on latest Fee Check for WETH-PRIMARY-C[n]
  • Hedge current value = Position Value on latest Fee Check for HEDGE-C[n]
  • Pending fees        = Fee Value on latest Fee Check for WETH-PRIMARY-C[n]
  • Total claimed       = sum of all Fees Claimed on all Claim records for WETH-PRIMARY-C[n]
  • Total fees          = total claimed + pending fees
  • LP PnL              = LP current − LP open
  • Hedge PnL           = READ from the Notes field on the latest HEDGE-C[n] Fee Check record.
                          The Notes field contains text like "PnL: $48.95 | Entry: $2078.1 | Size: -5.5 ETH".
                          Extract the dollar amount after "PnL: $". This can be negative (e.g. "PnL: $-431.75").
                          NEVER compute hedge PnL from position value delta — always use the Notes field value.
  • Net price delta     = LP PnL + Hedge PnL
  • Cycle open date     = Date on earliest Reopen Position for WETH-PRIMARY-C[n]
  • Elapsed hours       = hours from cycle open date to now
  • Days in cycle       = floor(elapsed hours / 24) — always a WHOLE NUMBER, never a decimal.
                          Example: 16.1 days → say "sixteen days". 13.8 days → say "thirteen days".
  • Avg daily fee       = (total fees / elapsed hours) × 24
  • Net return          = net price delta + total fees
  • Return %            = net return / total deployed × 100
  • Annualized %        = return % / (elapsed hours / 24) × 365

STEP 2 — Market Data (web search)
Search for:
  • ETH current price in USD
  • BTC current price in USD
  • Crypto Fear & Greed index (number and label)

STEP 3 — Zone Determination
You must know the current band parameters. Check the Airtable records — the
Cycle ID tells you which cycle is active. The band for C8 is:
  Center: $2,080 | Lower: $1,900 | Upper: $2,260
  Drift Lower: $1,936 | Near Drift Lower: $1,979
  Near Drift Upper: $2,181 | Drift Upper: $2,224
(If a new cycle has opened, use the band values seeded in Notion for that cycle.)

Zone rules using ETH price:
  • Between Near Drift Lower and Near Drift Upper → Normal Zone
  • Between Drift Lower and Near Drift Lower, OR between Near Drift Upper and Drift Upper → Near Drift Zone  
  • Below Drift Lower OR above Drift Upper → Drift Zone (action required — flag clearly)

Distance to nearest Near Drift = min(ETH − Near Drift Lower, Near Drift Upper − ETH)

═══════════════════════════════════════
BRIEF FORMAT (follow exactly, in order)
═══════════════════════════════════════

1. Date
   "Good morning. It's [Weekday], [Month] [Day]."

2. ETH and Zone
   Normal Zone example: "Eth is at [price], sitting in Normal Zone. You have about [distance] dollars of breathing room before Near Drift. No action needed."
   Near Drift example: "Eth is at [price], in Near Drift Zone — [distance] dollars from the Drift boundary. Monitor closely."
   Drift example: "Eth is at [price] and has crossed into Drift Zone. Action may be required — review the position."

3. Strategy P&L
   "[Strategy] is [X] days in. The LP is [up/down] [amount] on price since open, the hedge is [up/down] [amount] — net price delta is [positive/negative] [amount]. Total fees this cycle are [amount], averaging about [amount] a day. Net strategy return including all fees is [amount] on [total deployed] deployed — about [percent] in [X] days, annualizing around [percent]."

4. One Thing to Watch
   The single most notable item requiring attention today. Two sentences max.
   Examples: unclaimed fees building up on an xStock LP, a lending rate that spiked, the position approaching Near Drift.

5. Market Close
   "Market sentiment is [label] at [number]. Bitcoin is at [price]. [One macro sentence if relevant.] Have a good one."

═══════════════════════════════════════
SPEAKING RULES — CRITICAL
═══════════════════════════════════════

ElevenLabs will read this text aloud. Numbers must be written as words:
  ✓ "two thousand and fifty-eight dollars"    ✗ "$2,058" or "twenty fifty-eight"
  ✓ "one hundred and forty-six dollars"       ✗ "$146"
  ✓ "sixty-four percent"                      ✗ "64%"
  ✓ "thirty thousand dollars"                 ✗ "$30,000"
  ✓ "sixteen days"                            ✗ "sixteen point one days"

Tickers must be phonetic:
  ETH → "Eth"   BTC → "Bitcoin"   USDC → "U-S-D-C"   SOL → "Sol"

Never use raw ticker symbols. Never explain the band structure or hedge mechanics.
Target length: 60–75 seconds at 1.2× speed (~130–160 words).

Return ONLY the brief text. No preamble, no explanation, no JSON.`;

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

  console.log('\n=== BRIEF TEXT ===');
  console.log(briefText);
  console.log('=================\n');

  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, briefText, 'utf8');

  console.log(`✓ Brief written to ${OUTPUT_PATH}`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

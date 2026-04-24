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
 *   Fix 5 — System prompt band values removed — Claude now fetches current
 *            cycle band values from Notion at runtime instead of using
 *            hardcoded C8 values that go stale every cycle.
 */

import fs from 'fs';
import path from 'path';

const CLAUDE_API_KEY   = process.env.CLAUDE_API_KEY;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const NOTION_API_KEY   = process.env.NOTION_API_KEY;

const AIRTABLE_BASE_ID       = 'appWojaxYR99bXC1f';
const AIRTABLE_DAILY_TABLE   = 'tblKsk0QnkOoKNLuk';
const AIRTABLE_LENDING_TABLE = 'tblFw52kzeTRvxTSM';

// Notion page ID for Current Cycle Parameters (Live) — contains live band values
const NOTION_CYCLE_PARAMS_PAGE = '32a12a7e-409e-80f0-bbbe-c3e53fa89343';

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
  fldUkwrxtS4AEr52W = Action Type  (Fee Check | Reopen Position | Close Position | Claim)
  fldHG3MCcyhkXknyH = Date         (ISO timestamp — sort ascending to get oldest first)
  fldWElDtJZRYTaZtD = Position Value
  fld6QnTv9CKHvglcX = Fee Value    (pending fees, only on Fee Check records)
  fldE5uO0nwZmgLQtF = Fees Claimed (only on Claim records)
  fldFFts5ByR1EeYBk = Cycle ID     (e.g. WETH-PRIMARY-C9, HEDGE-C9)
  fldxWdSuQ09uhadFo = Notes        (HEDGE Fee Check records contain "PnL: $XX.XX | Entry: $XXXX | Size: -X.X ETH")

LENDING ACTIONS TABLE: ${AIRTABLE_LENDING_TABLE}

PAGINATION IS REQUIRED. Always pass the offset from each response into the
next call until has_more = false. The Reopen Position records that
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
          description: 'Array of field IDs to return. Always include fldFFts5ByR1EeYBk (Cycle ID), fldUkwrxtS4AEr52W (Action Type), and fldxWdSuQ09uhadFo (Notes — required for hedge PnL). Request ONLY the fields you need.'
        },
        page_size: {
          type: 'number',
          description: 'Records per page. Max 100. Use 100 to minimize API calls.'
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
    name: 'notion_fetch',
    description: `Fetch a Notion page by ID to read current cycle band values.
Use this to fetch the Current Cycle Parameters page which contains live band values
(Center, Lower, Upper, Drift Lower, Drift Upper, Near Drift Lower, Near Drift Upper).
Always fetch this page to get current band values — never rely on hardcoded values.`,
    input_schema: {
      type: 'object',
      properties: {
        page_id: {
          type: 'string',
          description: 'Notion page ID (with or without dashes)'
        }
      },
      required: ['page_id']
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
    records:       data.records,
    offset:        data.offset || null,
    total_returned: data.records?.length ?? 0,
    has_more:      !!data.offset
  };
}

async function runNotionFetch(input) {
  const { page_id } = input;
  const cleanId = page_id.replace(/-/g, '');

  if (!NOTION_API_KEY) {
    return { error: 'NOTION_API_KEY not set' };
  }

  try {
    const res = await fetch(`https://api.notion.com/v1/blocks/${cleanId}/children?page_size=100`, {
      headers: {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
      }
    });
    if (!res.ok) {
      return { error: `Notion ${res.status}: ${await res.text()}` };
    }
    const data = await res.json();
    // Extract plain text from all blocks
    const text = (data.results || []).map(block => {
      const richText = block[block.type]?.rich_text ?? [];
      return richText.map(rt => rt.plain_text).join('');
    }).filter(Boolean).join('\n');
    return { text };
  } catch (e) {
    return { error: e.message };
  }
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
    case 'notion_fetch':   result = await runNotionFetch(input);   break;
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
        max_tokens: 2048,
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
  const MAX_ITERS = 25;

  for (let i = 0; i < MAX_ITERS; i++) {
    console.log(`\n[claude] iteration ${i + 1}`);

    const response = await callClaude(messages, systemPrompt);
    console.log(`  stop_reason: ${response.stop_reason}`);

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      if (!textBlock) throw new Error('end_turn but no text block');

      const raw = textBlock.text.trim();

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

const SYSTEM_PROMPT = `You are the morning brief generator for JD's Portfolio OS — a personal DeFi portfolio management system.

Your job: fetch all required data using your tools, compute everything yourself, and return the spoken audio brief text. Nothing else — no JSON wrapper, no markdown, no preamble, no explanation. Your ENTIRE response must start with "Good morning." and end with "Have a good one." Any text before "Good morning" or after "Have a good one." will be stripped and discarded.

═══════════════════════════════════════
DATA FETCHING INSTRUCTIONS
═══════════════════════════════════════

STEP 1 — Current Cycle Band Values (Notion)
Fetch the Current Cycle Parameters page from Notion using the notion_fetch tool:
  page_id: ${NOTION_CYCLE_PARAMS_PAGE}

Extract from the page content:
  • Center price
  • Band Lower and Upper
  • Drift Lower and Drift Upper
  • Near Drift Lower and Near Drift Upper
  • Current cycle number (e.g. C9)

Use these values for all zone calculations. Never use hardcoded band values.

STEP 2 — PSF Cycle Data (Airtable Daily Actions)
Query table ${AIRTABLE_DAILY_TABLE} with:
  filterByFormula: OR(FIND('WETH-PRIMARY-C',{Cycle ID}),FIND('HEDGE-C',{Cycle ID}))
  sort: fldHG3MCcyhkXknyH ascending (oldest first)
  fields: fldUkwrxtS4AEr52W, fldHG3MCcyhkXknyH, fldWElDtJZRYTaZtD, fld6QnTv9CKHvglcX, fldE5uO0nwZmgLQtF, fldFFts5ByR1EeYBk, fldxWdSuQ09uhadFo
  page_size: 100

⚠️  PAGINATION IS MANDATORY. Keep calling airtable_query with the offset from
each response until has_more = false. The Reopen Position records you need to
determine opening deposit values are the OLDEST records — they will only appear
once you have paginated through all pages. Do not stop after one page.

From the complete record set, determine:
  • Current cycle number = highest number in Cycle ID (e.g. C9 from WETH-PRIMARY-C9)
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
  • Delta balance       = |Net price delta| = |LP PnL + Hedge PnL|
                          Example: LP PnL = +$428, Hedge PnL = -$798 → Net price delta = -$370 → Delta balance = $370
  • Delta tolerance     = Normal Zone: 0.5% of LP current value | Near Drift Zone: 0.25% of LP current value
  • Delta status        = if delta balance ≤ tolerance → "within tolerance, no action needed"
                          if delta balance > tolerance → "outside tolerance, hedge adjustment may be needed"
  • Net price delta     = LP PnL + Hedge PnL
  • Cycle open date     = Date on earliest Reopen Position for WETH-PRIMARY-C[n]
  • Elapsed hours       = hours from cycle open date to now
  • Days in cycle       = floor(elapsed hours / 24) — always a WHOLE NUMBER, never a decimal.
                          Example: 16.1 days → say "sixteen days". 13.8 days → say "thirteen days".
  • Avg daily fee       = (total fees / elapsed hours) × 24
  • Net return          = net price delta + total fees
  • Return %            = net return / total deployed × 100
  • Annualized %        = return % / (elapsed hours / 24) × 365
                          If elapsed hours < 24: include the annualized figure but follow it with
                          "though that figure carries little weight this early in the cycle" — then
                          move on. Do not flag it as a problem or revise the brief.

STEP 3 — Market Data (web search)
Search for:
  • ETH current price in USD
  • BTC current price in USD
  • Crypto Fear & Greed index — search "alternative.me fear greed index" and look for a number between 0-100 in the description. It will say something like "Now: 28" or "Current value is 28 (Fear)". Extract just the number and label. If you cannot find a specific number, say "Market sentiment data was unavailable at brief time" — do NOT estimate or guess a number.
  • ETH 30-day volatility or ATR — search "ETH 30 day volatility" or "Ethereum ATR" to get a sense of whether current volatility is elevated, normal, or compressed relative to recent history. This is used to assess whether the current band width remains appropriate.

STEP 4 — Zone Determination
Using the band values fetched from Notion in Step 1 and the ETH price from Step 3:

Zone rules:
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
   "The current delta neutral strategy cycle is [X] days in. The LP is [up/down] [amount] on price since open, the hedge is [up/down] [amount] — net price delta is [positive/negative] [amount]. Delta balance is [amount], which is [within/outside] tolerance for [Normal/Near Drift] Zone. [If outside tolerance: hedge adjustment may be needed.] Total fees this cycle are [amount], averaging about [amount] a day. Net strategy return including all fees is [amount] on [total deployed] deployed — about [percent] in [X] days, annualizing around [percent]."

   Always refer to the strategy as "The current delta neutral strategy cycle" — never "PSF", "P S F", "WETH-USDC strategy", or any other name.

4. One Thing to Watch
   The single most notable item requiring attention today. Two sentences max.
   Examples: unclaimed fees building up on an xStock LP, a lending rate that spiked, the position approaching Near Drift, delta outside tolerance.

5. Market Close
   "Market sentiment is [label] at [number]. Bitcoin is at [price]. [Band width verdict — one sentence assessing whether the current band width remains appropriate given current ETH volatility: e.g. 'Volatility looks normal — the band remains appropriate.' or 'Volatility is elevated — worth reviewing whether the band needs widening.' or 'Volatility is compressed — the band has comfortable room.'] Have a good one."

═══════════════════════════════════════
SPEAKING RULES — CRITICAL
═══════════════════════════════════════

ElevenLabs will read this text aloud. Numbers must be written as words:
  ✓ "two thousand and fifty-eight dollars"    ✗ "$2,058" or "twenty fifty-eight"
  ✓ "one hundred and forty-six dollars"       ✗ "$146"
  ✓ "sixty-four percent"                      ✗ "64%"
  ✓ "thirty thousand dollars"                 ✗ "$30,000"
  ✓ "LP" is spoken as "el-pee" by ElevenLabs — write it as "LP" not "L-P"
  ✓ "sixteen days"                            ✗ "sixteen point one days"

Tickers must be phonetic:
  ETH → "Eth"   BTC → "Bitcoin"   USDC → "U-S-D-C"   SOL → "Sol"

Never use raw ticker symbols. Never explain the band structure or hedge mechanics.
Target length: 60–75 seconds at 1.2× speed (~130–160 words).

═══════════════════════════════════════
OUTPUT RULES — CRITICAL
═══════════════════════════════════════

Output the brief EXACTLY ONCE, preceded by a single description line.

FORMAT YOUR ENTIRE RESPONSE LIKE THIS:
DESCRIPTION: [one sentence capturing the single most notable thing about today's portfolio situation — written in plain prose, no dollar signs, no percent symbols, no tickers. This becomes the podcast episode description in Overcast.]
Good morning. It's [day]...
[rest of brief]
...Have a good one.

DESCRIPTION line rules:
- Must be the very first line of your response
- One sentence only, ending with a period
- Plain prose — spell out numbers and avoid symbols (same rules as the brief itself)
- Capture the single most actionable or notable thing today: zone status, delta situation, fee milestone, market condition
- Examples:
  "Delta neutral cycle sits in Normal Zone with fees averaging fifty dollars a day and ETH holding near the center."
  "Near Drift alert as Eth approaches the upper boundary — hedge adjustment may be needed today."
  "Strategy enters day two of cycle ten with strong fee momentum following yesterday's market rally."

- If you catch an error or inconsistency while writing, correct it silently and continue.
- Do not restart. Do not show multiple drafts. Do not explain your reasoning.
- Do not include anything after "Have a good one." — not a note, not a correction, nothing.

═══════════════════════════════════════
EXAMPLE OUTPUT — MATCH THIS STYLE EXACTLY
═══════════════════════════════════════

Good morning. It's Friday, April 4th.

Eth is at two thousand and fifty-eight dollars, sitting in Normal Zone. You have about one hundred and twenty dollars of breathing room before Near Drift. No action needed.

The current delta neutral strategy cycle is thirteen days in. The LP is down one hundred and forty-six dollars on price since open, the hedge is up one hundred and seventy-eight dollars — net price delta is positive thirty-two dollars. Delta balance is thirty-two dollars, within tolerance for Normal Zone. Total fees this cycle are six hundred and fifteen dollars, averaging about fifty-one dollars a day. Net strategy return including all fees is six hundred and forty-seven dollars on thirty thousand six hundred and eighty-seven dollars deployed — about two percent in thirteen days, annualizing around sixty-four percent.

One thing to watch: the C-R-C-L-x position has three hundred and twenty-two dollars in unclaimed fees on a fifteen hundred dollar position. Worth deciding today whether to claim or let it ride into the weekend.

Market sentiment is Extreme Fear at nine. Bitcoin is at sixty-six thousand eight hundred dollars. Volatility looks normal — the band remains appropriate. Have a good one.`;

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

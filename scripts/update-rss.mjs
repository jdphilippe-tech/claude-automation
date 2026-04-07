import fs from 'fs';

const AUDIO_FILE = process.env.AUDIO_FILE;
const BRIEF_DATE = process.env.BRIEF_DATE;
const REPO_URL   = process.env.REPO_URL;
const BRIEF_FILE = process.env.BRIEF_TEXT_FILE || 'audio/brief-text.txt';
const DESC_FILE  = process.env.DESCRIPTION_FILE || '/tmp/description.txt';

if (!AUDIO_FILE || !BRIEF_DATE || !REPO_URL) {
  console.error('Missing required env vars: AUDIO_FILE, BRIEF_DATE, REPO_URL');
  process.exit(1);
}

if (!fs.existsSync(BRIEF_FILE)) {
  console.error(`Brief file not found: ${BRIEF_FILE}`);
  process.exit(1);
}

const description = fs.existsSync(DESC_FILE)
  ? fs.readFileSync(DESC_FILE, 'utf8').trim()
  : 'Daily portfolio and market intelligence brief.';

const RSS_FILE   = 'feed.xml';
const audioUrl   = `${REPO_URL}/${AUDIO_FILE}`;
const fileSize   = fs.statSync(AUDIO_FILE).size;
const pubDate    = new Date().toUTCString();
const ARTWORK_URL = `${REPO_URL}/artwork.jpg`;

let existingItems = '';
if (fs.existsSync(RSS_FILE)) {
  const existing = fs.readFileSync(RSS_FILE, 'utf8');
  const match = existing.match(/<item>[\s\S]*?<\/item>/g);
  if (match) existingItems = match.slice(0, 29).join('\n    ');
}

// BRIEF_DATE is always YYYY-MM-DD from the audio script — parse safely
const [year, month, day] = BRIEF_DATE.split('-').map(Number);
const d = new Date(Date.UTC(year, month - 1, day));
const displayDate = d.toLocaleDateString('en-US', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  timeZone: 'UTC'
});

const episodeTitle = `Morning Brief - ${displayDate}`;

const newItem = `<item>
      <title>${episodeTitle}</title>
      <description><![CDATA[${description}]]></description>
      <enclosure url="${audioUrl}" length="${fileSize}" type="audio/mpeg"/>
      <guid isPermaLink="false">morning-brief-${BRIEF_DATE}</guid>
      <pubDate>${pubDate}</pubDate>
      <itunes:duration>90</itunes:duration>
      <itunes:image href="${ARTWORK_URL}"/>
    </item>`;

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1_0.dtd"
  xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>The Plug</title>
    <description>Daily Signals - No Noise</description>
    <language>en-us</language>
    <itunes:author>Daily Signals - No Noise</itunes:author>
    <itunes:image href="${ARTWORK_URL}"/>
    <itunes:category text="Business"/>
    <itunes:explicit>false</itunes:explicit>
    <itunes:owner>
      <itunes:name>The Plug</itunes:name>
    </itunes:owner>
    <link>https://github.com/jdphilippe-tech/claude-automation</link>
    ${newItem}
    ${existingItems}
  </channel>
</rss>`;

fs.writeFileSync(RSS_FILE, rss);
console.log(`RSS updated. Episode: "${episodeTitle}"`);
console.log(`Description: "${description}"`);
console.log(`Feed URL: ${REPO_URL}/feed.xml`);

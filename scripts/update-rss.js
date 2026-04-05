const fs = require('fs');
const path = require('path');

const AUDIO_FILE = process.env.AUDIO_FILE;
const BRIEF_DATE = process.env.BRIEF_DATE;
const BRIEF_TEXT = process.env.BRIEF_TEXT;
const REPO_URL = process.env.REPO_URL; // e.g. https://raw.githubusercontent.com/jdphilippe-tech/claude-automation/main

if (!AUDIO_FILE || !BRIEF_DATE || !BRIEF_TEXT || !REPO_URL) {
  console.error('Missing required env vars');
  process.exit(1);
}

const RSS_FILE = 'feed.xml';
const audioUrl = `${REPO_URL}/${AUDIO_FILE}`;
const fileSize = fs.statSync(AUDIO_FILE).size;

// Format date for RSS (RFC 2822)
const pubDate = new Date().toUTCString();

// Read existing RSS or create new
let existingItems = '';
if (fs.existsSync(RSS_FILE)) {
  const existing = fs.readFileSync(RSS_FILE, 'utf8');
  const match = existing.match(/<item>[\s\S]*?<\/item>/g);
  if (match) {
    // Keep last 30 episodes
    existingItems = match.slice(0, 29).join('\n    ');
  }
}

// Format display date
const d = new Date(BRIEF_DATE);
const displayDate = d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

// Build new item
const newItem = `<item>
      <title>Morning Brief â€” ${displayDate}</title>
      <description><![CDATA[${BRIEF_TEXT.substring(0, 200)}...]]></description>
      <enclosure url="${audioUrl}" length="${fileSize}" type="audio/mpeg"/>
      <guid isPermaLink="false">morning-brief-${BRIEF_DATE}</guid>
      <pubDate>${pubDate}</pubDate>
    </item>`;

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1_0.dtd">
  <channel>
    <title>JD Morning Brief</title>
    <description>Daily portfolio and market intelligence brief</description>
    <language>en-us</language>
    <itunes:author>JD</itunes:author>
    <itunes:category text="Business"/>
    <itunes:explicit>false</itunes:explicit>
    <link>https://github.com/jdphilippe-tech/claude-automation</link>
    ${newItem}
    ${existingItems}
  </channel>
</rss>`;

fs.writeFileSync(RSS_FILE, rss);
console.log(`RSS updated: ${RSS_FILE}`);
console.log(`Feed URL will be: ${REPO_URL}/feed.xml`);

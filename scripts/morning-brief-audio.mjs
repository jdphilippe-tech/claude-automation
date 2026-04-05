import https from 'https';
import fs from 'fs';
import path from 'path';

const VOICE_ID = 'ewxUvnyvvOehYjKjUVKC'; // Mike
const MODEL_ID = 'eleven_turbo_v2_5';
const API_KEY = process.env.ELEVENLABS_API_KEY;
const BRIEF_TEXT = process.env.BRIEF_TEXT;

if (!API_KEY) { console.error('Missing ELEVENLABS_API_KEY'); process.exit(1); }
if (!BRIEF_TEXT) { console.error('Missing BRIEF_TEXT'); process.exit(1); }

const payload = JSON.stringify({
  text: BRIEF_TEXT,
  model_id: MODEL_ID,
  voice_settings: {
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0.0,
    use_speaker_boost: true
  }
});

const options = {
  hostname: 'api.elevenlabs.io',
  path: `/v1/text-to-speech/${VOICE_ID}`,
  method: 'POST',
  headers: {
    'xi-api-key': API_KEY,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
};

const date = new Date().toISOString().split('T')[0];
const outputDir = 'audio';
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
const outputFile = path.join(outputDir, `brief-${date}.mp3`);

console.log(`Generating audio for ${date}...`);

const req = https.request(options, (res) => {
  if (res.statusCode !== 200) {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      console.error(`ElevenLabs error ${res.statusCode}: ${body}`);
      process.exit(1);
    });
    return;
  }
  const file = fs.createWriteStream(outputFile);
  res.pipe(file);
  file.on('finish', () => {
    file.close();
    console.log(`Audio saved: ${outputFile}`);
    fs.appendFileSync(process.env.GITHUB_ENV || '/dev/null',
      `AUDIO_FILE=${outputFile}\nBRIEF_DATE=${date}\n`);
  });
});

req.on('error', (e) => { console.error(e); process.exit(1); });
req.write(payload);
req.end();

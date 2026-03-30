const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const multer = require('multer');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const convertedFiles = new Map();
const CLEANUP_MS = 15 * 60 * 1000;

app.get('/', (req, res) => {
  res.json({ status: 'Editorial Assistant Server running' });
});

app.post('/audio', async (req, res) => {
  const { text, voiceId, elevenLabsKey } = req.body;
  if (!text || !elevenLabsKey) {
    return res.status(400).json({ error: 'Missing text or API key' });
  }
  try {
    const audioBuffer = await generateElevenLabsAudio(
      text,
      voiceId || 'pNInz6obpgDQGcFmaJgB',
      elevenLabsKey
    );
    const base64Audio = audioBuffer.toString('base64');
    res.json({ success: true, audio: base64Audio, mimeType: 'audio/mpeg' });
  } catch (err) {
    console.error('Audio error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }
});

app.post('/convert', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file' });
  const id = crypto.randomBytes(8).toString('hex');
  const inputPath = path.join(os.tmpdir(), `input_${id}.webm`);
  const outputPath = path.join(os.tmpdir(), `tiktok_${id}.mp4`);
  try {
    fs.writeFileSync(inputPath, req.file.buffer);
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-c:v libx264',
          '-c:a aac',
          '-preset ultrafast',
          '-crf 23',
          '-movflags +faststart',
          '-pix_fmt yuv420p'
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    convertedFiles.set(id, outputPath);
    setTimeout(() => {
      try { fs.unlinkSync(outputPath); } catch(e) {}
      convertedFiles.delete(id);
    }, CLEANUP_MS);
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    res.json({
      success: true,
      downloadUrl: `${protocol}://${host}/download/${id}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.unlinkSync(inputPath); } catch(e) {}
  }
});

app.get('/download/:id', (req, res) => {
  const filePath = convertedFiles.get(req.params.id);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found or expired' });
  }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="tiktok-video.mp4"');
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(filePath).pipe(res);
});

function generateElevenLabsAudio(text, voiceId, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      text,
      model_id: 'eleven_monolingual_v1',
      voice_settings: { stability: 0.75, similarity_boost: 0.85, style: 0.15 }
    });
    const options = {
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${voiceId}`,
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const chunks = [];
    const req = https.request(options, (response) => {
      if (response.statusCode !== 200) {
        let errData = '';
        response.on('data', d => errData += d);
        response.on('end', () => reject(new Error(`ElevenLabs ${response.statusCode}: ${errData}`)));
        return;
      }
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
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
const renderedFiles = new Map();
const CLEANUP_MS = 15 * 60 * 1000;

const W = 1080, H = 1920;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

// ── Helpers ────────────────────────────────────────────

function wrapText(text, maxChars) {
  const words = String(text).split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (test.length <= maxChars) { cur = test; }
    else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function esc(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '\u2019')
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,')
    .replace(/=/g, '\\=');
}

function downloadImage(url, destPath) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    mod.get(url, { headers: { 'User-Agent': 'Editorial-Assistant/1.0' } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Image download failed: ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
  });
}

// ── Render a single scene to an MP4 clip ───────────────

async function renderScene(scene, voiceId, apiKey, id, idx) {
  const tmpDir = os.tmpdir();
  const imgPath   = path.join(tmpDir, `img_${id}_${idx}.jpg`);
  const audioPath = path.join(tmpDir, `audio_${id}_${idx}.mp3`);
  const clipPath  = path.join(tmpDir, `clip_${id}_${idx}.mp4`);

  const hasImage     = !!scene.imageUrl;
  const hasNarration = !!(scene.narration && scene.narration.trim() && apiKey && voiceId);

  try {
    if (hasImage)     await downloadImage(scene.imageUrl, imgPath);
    if (hasNarration) {
      const buf = await generateElevenLabsAudio(scene.narration, voiceId, apiKey);
      fs.writeFileSync(audioPath, buf);
    }

    const hookLines = wrapText(scene.overlay_text || '', 22).slice(0, 2);
    const narLines  = wrapText(scene.narration || '', 30).slice(0, 3);
    const hookY     = Math.floor(H * 0.08);
    const narY      = Math.floor(H * 0.42);

    const filters = [
      `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`,
      `drawbox=x=0:y=0:w=iw:h=ih:color=black@0.5:t=fill`,
    ];

    hookLines.forEach((line, i) => {
      filters.push(
        `drawtext=fontfile='${FONT}':text='${esc(line)}':x=(w-text_w)/2:y=${hookY + i * 68}:fontsize=56:fontcolor=white:shadowcolor=black@0.7:shadowx=2:shadowy=2`
      );
    });

    narLines.forEach((line, i) => {
      filters.push(
        `drawtext=fontfile='${FONT}':text='${esc(line)}':x=(w-text_w)/2:y=${narY + i * 54}:fontsize=44:fontcolor=white:shadowcolor=black@0.7:shadowx=1:shadowy=1`
      );
    });

    filters.push(
      `drawtext=fontfile='${FONT}':text='angelakim87':x=w-text_w-30:y=h-50:fontsize=34:fontcolor=#c9a99a@0.8`
    );

    const filterStr = filters.join(',');
    const audioExists = hasNarration && fs.existsSync(audioPath);

    await new Promise((resolve, reject) => {
      const cmd = ffmpeg();

      if (hasImage && fs.existsSync(imgPath)) {
        cmd.input(imgPath).inputOptions(['-loop 1']);
      } else {
        cmd.input(`color=c=black:size=${W}x${H}:rate=30`).inputOptions(['-f lavfi']);
      }

      if (audioExists) cmd.input(audioPath);

      const opts = [
        '-vf', filterStr,
        '-c:v libx264',
        '-preset fast',
        '-crf 23',
        '-pix_fmt yuv420p',
        '-movflags +faststart',
      ];

      if (audioExists) {
        opts.push('-c:a', 'aac', '-shortest');
      } else {
        opts.push('-t', String(scene.duration_seconds || 6), '-an');
      }

      cmd.outputOptions(opts)
        .output(clipPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    return clipPath;

  } finally {
    try { fs.unlinkSync(imgPath); }   catch(e) {}
    try { fs.unlinkSync(audioPath); } catch(e) {}
  }
}

// ── Routes ─────────────────────────────────────────────

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

// Render full video server-side — browser sends scene data, server returns MP4 download URL
app.post('/render-video', async (req, res) => {
  const { scenes, elevenLabsKey, voiceId } = req.body;
  if (!scenes || !scenes.length) {
    return res.status(400).json({ error: 'No scenes provided' });
  }

  const id = crypto.randomBytes(8).toString('hex');
  const tmpDir = os.tmpdir();
  const outputPath = path.join(tmpDir, `final_${id}.mp4`);
  const clipPaths = [];

  try {
    for (let i = 0; i < scenes.length; i++) {
      console.log(`Rendering scene ${i + 1}/${scenes.length}...`);
      const clipPath = await renderScene(scenes[i], voiceId, elevenLabsKey, id, i);
      clipPaths.push(clipPath);
    }

    if (clipPaths.length === 1) {
      fs.copyFileSync(clipPaths[0], outputPath);
    } else {
      const concatFile = path.join(tmpDir, `concat_${id}.txt`);
      fs.writeFileSync(concatFile, clipPaths.map(p => `file '${p}'`).join('\n'));
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(concatFile)
          .inputOptions(['-f concat', '-safe 0'])
          .outputOptions(['-c copy'])
          .output(outputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      try { fs.unlinkSync(concatFile); } catch(e) {}
    }

    renderedFiles.set(id, outputPath);
    setTimeout(() => {
      try { fs.unlinkSync(outputPath); } catch(e) {}
      renderedFiles.delete(id);
    }, CLEANUP_MS);

    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host  = req.get('host');
    res.json({ success: true, downloadUrl: `${proto}://${host}/rendered/${id}` });

  } catch (err) {
    console.error('Render error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    clipPaths.forEach(p => { try { fs.unlinkSync(p); } catch(e) {} });
  }
});

app.get('/rendered/:id', (req, res) => {
  const filePath = renderedFiles.get(req.params.id);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found or expired' });
  }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="tiktok-video.mp4"');
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(filePath).pipe(res);
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
    res.json({ success: true, downloadUrl: `${protocol}://${host}/download/${id}` });
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

// ── ElevenLabs helper ──────────────────────────────────

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

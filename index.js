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
app.use(express.json({ limit: '50mb' }));

// Single map for all downloadable files (render + convert)
const downloadFiles = new Map();
const CLEANUP_MS = 15 * 60 * 1000;

const W = 1080, H = 1920;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

// ── Helpers ────────────────────────────────────────────

// Split narration into lines of 5 words each
function wrapWords(text, wordsPerLine) {
  const words = String(text).trim().split(/\s+/);
  const lines = [];
  for (let i = 0; i < words.length; i += wordsPerLine) {
    lines.push(words.slice(i, i + wordsPerLine).join(' '));
  }
  return lines;
}

// Wrap hook text by character width
function wrapChars(text, maxChars) {
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

// Escape special chars for FFmpeg drawtext filter
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

  const hasImage     = !!(scene.imageUrl && scene.imageUrl.trim());
  const hasNarration = !!(scene.narration && scene.narration.trim() && apiKey && voiceId);

  try {
    if (hasImage) await downloadImage(scene.imageUrl, imgPath);
    if (hasNarration) {
      const buf = await generateElevenLabsAudio(scene.narration, voiceId, apiKey);
      fs.writeFileSync(audioPath, buf);
    }

    // Hook text: top 12% of frame, bold white 52px, max 2 lines
    const hookLines = wrapChars(scene.overlay_text || '', 22).slice(0, 2);
    const hookY     = Math.floor(H * 0.12);

    // Narration text: center at 55%, white 44px, 5 words per line, max 4 lines
    const narLines  = wrapWords(scene.narration || '', 5).slice(0, 4);
    const narY      = Math.floor(H * 0.55);

    const filters = [
      // Scale image to fill full frame (cover, not letterbox)
      `scale=${W}:${H}:force_original_aspect_ratio=increase`,
      `crop=${W}:${H}`,
      // Dark overlay for readability
      `drawbox=x=0:y=0:w=iw:h=ih:color=black@0.5:t=fill`,
    ];

    // Hook text — bold white, shadow, top 12%
    hookLines.forEach((line, i) => {
      filters.push(
        `drawtext=fontfile='${FONT}':text='${esc(line)}':x=(w-text_w)/2:y=${hookY + i * 68}:fontsize=52:fontcolor=white:shadowcolor=black@0.8:shadowx=3:shadowy=3`
      );
    });

    // Narration text — white 44px, center 55%
    narLines.forEach((line, i) => {
      filters.push(
        `drawtext=fontfile='${FONT}':text='${esc(line)}':x=(w-text_w)/2:y=${narY + i * 54}:fontsize=44:fontcolor=white:shadowcolor=black@0.7:shadowx=2:shadowy=2`
      );
    });

    // Branding — rose color bottom right
    filters.push(
      `drawtext=fontfile='${FONT}':text='angelakim87':x=w-text_w-30:y=h-60:fontsize=34:fontcolor=#c9a99a@0.85`
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
        '-preset ultrafast',
        '-crf 23',
        '-b:v 1000k',
        '-threads 1',
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

    // Delete temp files immediately after ffmpeg finishes, before next scene
    try { fs.unlinkSync(imgPath); }   catch(e) {}
    try { fs.unlinkSync(audioPath); } catch(e) {}

    return clipPath;

  } catch(err) {
    try { fs.unlinkSync(imgPath); }   catch(e) {}
    try { fs.unlinkSync(audioPath); } catch(e) {}
    throw err;
  }
}

// ── Routes ─────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'running' });
});

// Generate audio for one scene — returns base64 MP3
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
    res.json({ success: true, audio: audioBuffer.toString('base64'), mimeType: 'audio/mpeg' });
  } catch (err) {
    console.error('Audio error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Full server-side video render — receives scene data, returns MP4 download URL
app.post('/render', express.json({ limit: '10mb' }), async (req, res) => {
  const { scenes, elevenLabsKey, voiceId } = req.body;
  if (!scenes || !scenes.length) return res.status(400).json({ error: 'No scenes' });
  if (!elevenLabsKey) return res.status(400).json({ error: 'No ElevenLabs key' });

  const jobId = crypto.randomBytes(8).toString('hex');
  const clipPaths = [];

  try {
    // Render each scene to a clip via FFmpeg
    for (let i = 0; i < scenes.length; i++) {
      console.log(`Rendering scene ${i + 1}/${scenes.length}`);
      const clipPath = await renderScene(scenes[i], voiceId, elevenLabsKey, jobId, i);
      clipPaths.push(clipPath);
    }

    const outputPath = path.join(os.tmpdir(), `tiktok_${jobId}.mp4`);

    if (clipPaths.length === 1) {
      // Single scene — just move/copy the clip
      fs.renameSync(clipPaths[0], outputPath);
    } else {
      // Concatenate all clips
      const listFile = path.join(os.tmpdir(), `list_${jobId}.txt`);
      fs.writeFileSync(listFile, clipPaths.map(p => `file '${p}'`).join('\n'));

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(listFile)
          .inputOptions(['-f concat', '-safe 0'])
          .outputOptions(['-c copy'])
          .output(outputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      // Clean up clips and list file
      try { fs.unlinkSync(listFile); } catch(e) {}
      for (const p of clipPaths) { try { fs.unlinkSync(p); } catch(e) {} }
    }

    // Store for download
    downloadFiles.set(jobId, outputPath);
    setTimeout(() => {
      try { fs.unlinkSync(outputPath); } catch(e) {}
      downloadFiles.delete(jobId);
    }, CLEANUP_MS);

    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    console.log(`Render complete: ${jobId}`);
    res.json({ success: true, downloadUrl: `${protocol}://${host}/download/${jobId}` });

  } catch(err) {
    console.error('Render error:', err);
    for (const p of clipPaths) { try { fs.unlinkSync(p); } catch(e) {} }
    res.status(500).json({ error: err.message });
  }
});

// Convert webm to mp4 (browser-recorded fallback)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }
});

app.post('/convert', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file' });
  const id = crypto.randomBytes(8).toString('hex');
  const inputPath  = path.join(os.tmpdir(), `input_${id}.webm`);
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
    downloadFiles.set(id, outputPath);
    setTimeout(() => {
      try { fs.unlinkSync(outputPath); } catch(e) {}
      downloadFiles.delete(id);
    }, CLEANUP_MS);
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.get('host');
    res.json({ success: true, downloadUrl: `${protocol}://${host}/download/${id}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.unlinkSync(inputPath); } catch(e) {}
  }
});

// Serve any rendered or converted MP4
app.get('/download/:id', (req, res) => {
  const filePath = downloadFiles.get(req.params.id);
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

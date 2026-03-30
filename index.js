const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const renderedFiles = new Map();
const CLEANUP_MS = 15 * 60 * 1000;

const W = 1080, H = 1920;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

// ── Helpers ────────────────────────────────────────────

async function downloadFile(url, destPath) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Editorial-Assistant/1.0' } });
  if (!res.ok) throw new Error(`Image download failed: ${res.status}`);
  const buffer = await res.buffer();
  fs.writeFileSync(destPath, buffer);
}

async function generateAudio(text, voiceId, apiKey, destPath) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: 'eleven_monolingual_v1',
      voice_settings: { stability: 0.75, similarity_boost: 0.85 }
    })
  });
  if (!res.ok) throw new Error(`ElevenLabs error: ${res.status}`);
  const buffer = await res.buffer();
  fs.writeFileSync(destPath, buffer);
}

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

// Escape special chars for FFmpeg drawtext
function esc(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '\u2019')   // smart quote — avoids shell quoting issues
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,')
    .replace(/=/g, '\\=');
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
    if (hasImage)     await downloadFile(scene.imageUrl, imgPath);
    if (hasNarration) await generateAudio(scene.narration, voiceId, apiKey, audioPath);

    // Text layout
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

    // Branding — rose color bottom right
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
  res.json({ status: 'Editorial Assistant Video Renderer running ✦' });
});

app.post('/render', async (req, res) => {
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

    console.log('Concatenating clips...');
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
    console.log(`Render complete: ${id}`);
    res.json({ success: true, downloadUrl: `${proto}://${host}/download/${id}`, id });

  } catch(err) {
    console.error('Render error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    clipPaths.forEach(p => { try { fs.unlinkSync(p); } catch(e) {} });
  }
});

app.get('/download/:id', (req, res) => {
  const filePath = renderedFiles.get(req.params.id);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found or expired' });
  }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="tiktok-video.mp4"');
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(filePath).pipe(res);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

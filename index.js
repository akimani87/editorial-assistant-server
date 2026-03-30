const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const PORT = process.env.PORT || 3000;

// Store converted files temporarily
const convertedFiles = new Map(); // id -> filepath
const CLEANUP_MS = 10 * 60 * 1000; // delete after 10 minutes

app.use(cors({ origin: '*' }));

app.get('/', (req, res) => {
  res.json({ status: 'Editorial Assistant Video Converter running' });
});

// Convert webm to mp4 and return download URL
app.post('/convert', multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }
}).single('video'), async (req, res) => {
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
          '-preset fast',
          '-crf 23',
          '-movflags +faststart',
          '-pix_fmt yuv420p'
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Store file reference
    convertedFiles.set(id, outputPath);

    // Auto cleanup after 10 minutes
    setTimeout(() => {
      try { fs.unlinkSync(outputPath); } catch(e) {}
      convertedFiles.delete(id);
    }, CLEANUP_MS);

    // Return download URL
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    res.json({
      success: true,
      downloadUrl: `${protocol}://${host}/download/${id}`,
      id
    });

  } catch(err) {
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.unlinkSync(inputPath); } catch(e) {}
  }
});

// Serve the converted MP4 file
app.get('/download/:id', (req, res) => {
  const filePath = convertedFiles.get(req.params.id);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found or expired' });
  }

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="tiktok-video.mp4"`);
  res.setHeader('Cache-Control', 'no-cache');

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

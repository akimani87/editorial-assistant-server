const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const PORT = process.env.PORT || 3000;

// Allow requests from your Cloudflare tool
app.use(cors({
  origin: [
    'https://editorial-assistant.pages.dev',
    'https://angela-eii.pages.dev',
    'http://localhost:3000',
    '*'
  ]
}));

// Store uploaded file in memory temporarily
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB max
});

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'Editorial Assistant Video Converter is running ✦',
    version: '1.0.0'
  });
});

// Convert webm to mp4
app.post('/convert', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No video file received' });
  }

  console.log(`Converting video: ${req.file.size} bytes`);

  // Write webm to temp file
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `input_${Date.now()}.webm`);
  const outputPath = path.join(tempDir, `output_${Date.now()}.mp4`);

  try {
    fs.writeFileSync(inputPath, req.file.buffer);

    // Convert with ffmpeg
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-c:v libx264',      // H.264 video codec — TikTok compatible
          '-c:a aac',          // AAC audio — TikTok compatible  
          '-preset fast',      // Fast encoding
          '-crf 23',           // Good quality
          '-movflags +faststart', // Optimise for web streaming
          '-pix_fmt yuv420p',  // Maximum compatibility
          '-vf scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2' // TikTok 9:16 format
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Send MP4 back
    const mp4Buffer = fs.readFileSync(outputPath);
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="tiktok-${Date.now()}.mp4"`,
      'Content-Length': mp4Buffer.length
    });
    res.send(mp4Buffer);

    console.log(`Conversion successful: ${mp4Buffer.length} bytes`);

  } catch (err) {
    console.error('Conversion error:', err);
    res.status(500).json({ error: 'Conversion failed: ' + err.message });
  } finally {
    // Clean up temp files
    try { fs.unlinkSync(inputPath); } catch(e) {}
    try { fs.unlinkSync(outputPath); } catch(e) {}
  }
});

app.listen(PORT, () => {
  console.log(`Editorial Assistant Video Converter running on port ${PORT} ✦`);
});

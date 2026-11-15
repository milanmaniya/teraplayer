const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const {
  USER_AGENT,
  TERABOX_HOST,
  resolveToSurl,
  fetchShareInfo,
  listFolderFiles,
  getStreamingM3U8
} = require('./lib/resolver');

// Load .env manually if exists
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (!process.env[key] && val) {
          process.env[key] = val;
        }
      }
    }
  });
}

// Built-in default NDUS token for zero-setup deployments
if (!process.env.TERABOX_NDUS) {
  process.env.TERABOX_NDUS = 'YbbOLXupeHuiW6-qutQMS9aDgf9xNC5JDZDRR-Cu';
}
if (!process.env.TERABOX_HOST) {
  process.env.TERABOX_HOST = 'dm.1024terabox.com';
}

const app = express();
const PORT = process.env.PORT || 3000;

app.enable('trust proxy');
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getHostUrl(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = forwardedProto || (req.get('host') && req.get('host').includes('localhost') ? 'http' : 'https');
  return `${proto}://${req.get('host')}`;
}

// In-memory cache for share sessions (10 minutes)
const shareCache = new Map();

async function getCachedShareInfo(surl) {
  const cached = shareCache.get(surl);
  if (cached && Date.now() - cached.timestamp < 10 * 60 * 1000) {
    return cached.share;
  }
  const share = await fetchShareInfo(surl);
  shareCache.set(surl, { share, timestamp: Date.now() });
  return share;
}

// 0. API: Status & Cookie Management
app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    hasNdus: Boolean(process.env.TERABOX_NDUS && process.env.TERABOX_NDUS.length > 5),
    mode: process.env.TERABOX_NDUS ? 'Full HD Mode (Unlimited)' : 'Preview Mode (30s)'
  });
});

app.post('/api/set-cookie', (req, res) => {
  const { ndus } = req.body;
  if (!ndus || ndus.trim().length < 5) {
    return res.status(400).json({ success: false, error: 'Invalid cookie value' });
  }

  const clean = ndus.replace(/^ndus=/, '').trim();
  process.env.TERABOX_NDUS = clean;

  // Persist to .env
  try {
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    if (content.includes('TERABOX_NDUS=')) {
      content = content.replace(/TERABOX_NDUS=.*(\r?\n|$)/, `TERABOX_NDUS=${clean}$1`);
    } else {
      content += `\nTERABOX_NDUS=${clean}\n`;
    }
    fs.writeFileSync(envPath, content);
  } catch (e) {
    console.error('Failed to write .env:', e.message);
  }

  // Clear cache to apply fresh cookie
  shareCache.clear();

  res.json({
    success: true,
    message: 'TeraBox cookie updated successfully! Full duration streaming unlocked.',
    hasNdus: true
  });
});

// 1. API: Resolve URL
app.post('/api/resolve', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, error: 'URL is required' });
    }

    const surl = await resolveToSurl(url);
    const share = await getCachedShareInfo(surl);

    let files = [];
    let primaryFile = null;

    if (String(share.fileInfo.isdir) === '1') {
      const list = await listFolderFiles(share);
      files = list.map(f => {
        const sizeBytes = parseInt(f.size || 0, 10);
        const isDir = String(f.isdir) === '1';
        const isVideo = !isDir && (String(f.category) === '1' || /\.(mp4|mkv|mov|avi|flv|webm|m4v)$/i.test(f.server_filename));
        return {
          fs_id: f.fs_id,
          filename: f.server_filename,
          size_bytes: sizeBytes,
          size_formatted: (sizeBytes / (1024 * 1024)).toFixed(2) + ' MB',
          thumbnail: f.thumbs ? (f.thumbs.url3 || f.thumbs.url2 || f.thumbs.url1) : '',
          isVideo
        };
      });

      const videoFiles = files.filter(f => f.isVideo);
      if (videoFiles.length > 0) {
        primaryFile = videoFiles.sort((a, b) => b.size_bytes - a.size_bytes)[0];
      } else {
        primaryFile = files[0];
      }
    } else {
      const sizeBytes = parseInt(share.fileInfo.size || 0, 10);
      primaryFile = {
        fs_id: share.fileInfo.fs_id,
        filename: share.fileInfo.server_filename,
        size_bytes: sizeBytes,
        size_formatted: (sizeBytes / (1024 * 1024)).toFixed(2) + ' MB',
        thumbnail: share.fileInfo.thumbs ? (share.fileInfo.thumbs.url3 || share.fileInfo.thumbs.url2 || share.fileInfo.thumbs.url1) : '',
        isVideo: true
      };
      files = [primaryFile];
    }

    if (!primaryFile) {
      return res.status(404).json({ success: false, error: 'No playable video found in this link' });
    }

    const hasNdus = Boolean(process.env.TERABOX_NDUS && process.env.TERABOX_NDUS.length > 5);

    res.json({
      success: true,
      surl,
      title: primaryFile.filename,
      size: primaryFile.size_formatted,
      thumbnail: primaryFile.thumbnail,
      activeFid: primaryFile.fs_id,
      files,
      hasNdus,
      streamUrl: `/api/m3u8?surl=${encodeURIComponent(surl)}&fid=${primaryFile.fs_id}`,
      downloadUrl: `/api/download?surl=${encodeURIComponent(surl)}&fid=${primaryFile.fs_id}`
    });
  } catch (err) {
    console.error('Resolve error:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to resolve link' });
  }
});

// 2. API: HLS M3U8 Playlist
app.get('/api/m3u8', async (req, res) => {
  try {
    const { surl, fid, quality } = req.query;
    if (!surl || !fid) {
      return res.status(400).send('surl and fid are required');
    }

    const share = await getCachedShareInfo(surl);
    const host = getHostUrl(req);
    const { playlist } = await getStreamingM3U8(share, fid, host, quality || 'M3U8_AUTO_480');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(playlist);
  } catch (err) {
    console.error('M3U8 error:', err);
    res.status(500).send(err.message || 'Failed to generate playlist');
  }
});

// 3. API: Video Segment Proxy
app.get('/api/segment', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) {
      return res.status(400).send('url parameter required');
    }

    const headers = {
      'User-Agent': USER_AGENT,
      'Referer': `https://${TERABOX_HOST}/`
    };
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const segmentRes = await fetch(targetUrl, { headers });
    res.status(segmentRes.status);

    const copyHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
    for (const h of copyHeaders) {
      const val = segmentRes.headers.get(h);
      if (val) res.setHeader(h, val);
    }
    res.setHeader('Access-Control-Allow-Origin', '*');

    const arrayBuffer = await segmentRes.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    console.error('Segment proxy error:', err);
    res.status(502).send('Error proxying video chunk');
  }
});

// 4. API: Direct Video Download Proxy
app.get('/api/download', async (req, res) => {
  try {
    const { surl, fid } = req.query;
    if (!surl || !fid) {
      return res.status(400).send('surl and fid are required');
    }

    const share = await getCachedShareInfo(surl);
    const host = `${req.protocol}://${req.get('host')}`;
    const { playlist } = await getStreamingM3U8(share, fid, host, 'M3U8_AUTO_480');

    const lines = playlist.split('\n').map(l => l.trim()).filter(Boolean);
    const segmentProxyUrls = lines.filter(l => l.startsWith('http://') || l.startsWith('https://'));

    if (segmentProxyUrls.length === 0) {
      return res.status(404).send('No downloadable segments found');
    }

    const filename = `video_${fid}.mp4`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'video/mp4');

    for (const segUrl of segmentProxyUrls) {
      const chunkRes = await fetch(segUrl);
      const chunkBuffer = await chunkRes.arrayBuffer();
      res.write(Buffer.from(chunkBuffer));
    }
    res.end();
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).send('Download failed: ' + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` TeraBox & TeraViralHub Player Server Running!`);
  console.log(` Local URL: http://localhost:${PORT}`);
  console.log(` Mode: ${process.env.TERABOX_NDUS ? 'Full HD Unlimited' : 'Guest Preview (30s)'}`);
  console.log(`====================================================`);
});

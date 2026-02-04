require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const { v4: uuidv4 } = require('uuid');
const { execSync } = require('child_process');

const ytDlp = require('yt-dlp-exec');

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || 'localhost';

const activeDownloads = new Map();
const downloadReadyCallbacks = new Map();

//  aria2c detection 
let hasAria2c = false;
let aria2cPath = 'aria2c';
const userLocalAppData = process.env.LOCALAPPDATA || '';
const aria2cPaths = [
  'aria2c',
  path.join(userLocalAppData, 'Microsoft', 'WinGet', 'Links', 'aria2c.exe'),
  path.join(process.env.PROGRAMFILES || '', 'aria2', 'aria2c.exe'),
  'C:\\ProgramData\\chocolatey\\bin\\aria2c.exe',
];

try {
  const wingetPackages = path.join(userLocalAppData, 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(wingetPackages)) {
    const findAria2c = (dir) => {
      try {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          const fullPath = path.join(dir, item);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            const result = findAria2c(fullPath);
            if (result) return result;
          } else if (item === 'aria2c.exe') {
            return fullPath;
          }
        }
      } catch {}
      return null;
    };
    const found = findAria2c(wingetPackages);
    if (found) aria2cPaths.unshift(found);
  }
} catch {}

for (const p of aria2cPaths) {
  try {
    execSync(`"${p}" --version`, { stdio: 'ignore' });
    hasAria2c = true;
    aria2cPath = p;
    console.log(`aria2c found: ${p.length > 50 ? '...' + p.slice(-47) : p}`);
    break;
  } catch {}
}

if (!hasAria2c) {
  console.log(' aria2c not found (optional).');
}

//  middleware 
const corsOptions = {
  origin: ['http://localhost:3000'],
  methods: ['GET', 'POST', 'DELETE'],
  credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json());

//  downloads dir
const DOWNLOADS_DIR =
  process.env.DOWNLOADS_DIR ||
  (process.env.NODE_ENV === 'production' ? '/tmp/downloads' : path.join(__dirname, 'downloads'));

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

// cookies 
const cookiesPath = path.join(__dirname, 'cookies.txt');
let cookieStatus = { valid: false, message: '', expiringSoon: false };
let hasCookies = fs.existsSync(cookiesPath);

const checkCookieHealth = () => {
  if (!fs.existsSync(cookiesPath)) {
    cookieStatus = { valid: false, message: 'No cookies.txt found', expiringSoon: false };
    return cookieStatus;
  }
  try {
    const cookieContent = fs.readFileSync(cookiesPath, 'utf8');
    const lines = cookieContent.split('\n').filter((line) => !line.startsWith('#') && line.trim());
    if (lines.length === 0) {
      cookieStatus = { valid: false, message: 'cookies.txt is empty', expiringSoon: false };
      return cookieStatus;
    }
    cookieStatus = { valid: true, message: 'Cookies are valid', expiringSoon: false };
    return cookieStatus;
  } catch (e) {
    cookieStatus = { valid: false, message: `Error reading cookies: ${e.message}`, expiringSoon: false };
    return cookieStatus;
  }
};

cookieStatus = checkCookieHealth();
hasCookies = cookieStatus.valid;

const checkDiskSpace = async (requiredBytes = 0) => {
  try {
    const absolutePath = path.resolve(DOWNLOADS_DIR);
    const driveLetter = absolutePath.charAt(0).toUpperCase();

    if (process.platform === 'win32') {
      const result = execSync(`powershell -command "(Get-PSDrive ${driveLetter}).Free"`, {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();

      const freeBytes = parseInt(result, 10);
      const freeGB = (freeBytes / (1024 * 1024 * 1024)).toFixed(2);
      const minRequired = Math.max(1024 * 1024 * 1024, requiredBytes + 500 * 1024 * 1024);

      return {
        freeBytes,
        freeGB: Number(freeGB),
        sufficient: freeBytes >= minRequired,
        message:
          freeBytes < minRequired
            ? `Low disk space: ${freeGB}GB free. Need at least ${(minRequired / (1024 * 1024 * 1024)).toFixed(2)}GB.`
            : `${freeGB}GB available`,
      };
    } else {
      const result = execSync(`df -B1 "${DOWNLOADS_DIR}" | tail -1 | awk '{print $4}'`, {
        encoding: 'utf8',
      }).trim();
      const freeBytes = parseInt(result, 10);
      const freeGB = (freeBytes / (1024 * 1024 * 1024)).toFixed(2);
      const minRequired = Math.max(1024 * 1024 * 1024, requiredBytes + 500 * 1024 * 1024);

      return {
        freeBytes,
        freeGB: Number(freeGB),
        sufficient: freeBytes >= minRequired,
        message: freeBytes < minRequired ? `Low disk space: ${freeGB}GB free` : `${freeGB}GB available`,
      };
    }
  } catch {
    return { freeBytes: 0, freeGB: 0, sufficient: true, message: 'Unable to check disk space' };
  }
};

// cleanup old downloads
app.use((req, res, next) => {
  if (Math.random() < 0.01) {
    fs.readdir(DOWNLOADS_DIR, (err, files) => {
      if (err) return;
      const now = Date.now();
      files.forEach((file) => {
        const filePath = path.join(DOWNLOADS_DIR, file);
        fs.stat(filePath, (err, stats) => {
          if (err) return;
          if (now - stats.mtimeMs > 3600000) fs.unlink(filePath, () => {});
        });
      });
    });
  }
  next();
});

// helpers
const cleanYouTubeUrl = (url) => {
  try {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/,
    ];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) return `https://www.youtube.com/watch?v=${match[1]}`;
    }
    const u = new URL(url);
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.slice(1).substring(0, 11);
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }
    if (u.hostname.includes('youtube.com')) {
      const id = u.searchParams.get('v');
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }
    return url;
  } catch {
    return url;
  }
};

const sendProgress = (downloadId, data) => {
  const res = activeDownloads.get(downloadId);
  if (res) res.write(`data: ${JSON.stringify(data)}\n\n`);
};

//  health
app.get('/api/health', async (req, res) => {
  const diskInfo = await checkDiskSpace();
  const freshCookieStatus = checkCookieHealth();
  res.json({
    status: 'Server is running!',
    ffmpeg: !!ffmpegStatic,
    hasCookies: freshCookieStatus.valid,
    cookieStatus: freshCookieStatus,
    diskSpace: diskInfo,
    aria2c: hasAria2c,
  });
});

// youtube: metadata 
app.post('/api/video-metadata', async (req, res) => {
  try {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    url = cleanYouTubeUrl(url);

    const options = {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      skipDownload: true,
      noPlaylist: true,
      playlistItems: '1',
    };
    if (hasCookies) options.cookies = cookiesPath;

    const info = await ytDlp(url, options);

    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      author: info.uploader || info.channel,
      viewCount: info.view_count,
      isLive: info.is_live,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to fetch video metadata' });
  }
});

// youtube  formats
app.post('/api/video-formats', async (req, res) => {
  try {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    url = cleanYouTubeUrl(url);

    const options = {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      skipDownload: true,
      noPlaylist: true,
      playlistItems: '1',
    };
    if (hasCookies) options.cookies = cookiesPath;

    const info = await ytDlp(url, options);

    const formats = [];
    const seen = new Set();

    const videoFormats = (info.formats || [])
      .filter((f) => f.vcodec !== 'none' && f.height && f.protocol !== 'm3u8_native' && f.protocol !== 'm3u8')
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    formats.push({
      formatId: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
      quality: 'Best Quality',
      container: 'mp4',
      hasVideo: true,
      hasAudio: true,
      filesize: null,
      type: 'video',
    });
    seen.add('Best Quality');

    for (const f of videoFormats) {
      const q = `${f.height}p`;
      if (!seen.has(q) && seen.size < 7) {
        seen.add(q);
        formats.push({
          formatId: `bestvideo[height<=${f.height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${f.height}]+bestaudio/best[height<=${f.height}]`,
          quality: q,
          container: 'mp4',
          hasVideo: true,
          hasAudio: f.acodec !== 'none',
          filesize: f.filesize || f.filesize_approx,
          type: 'video',
        });
      }
    }

    const audioFormats = (info.formats || [])
      .filter((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
      .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));

    const seenAudio = new Set();
    for (const f of audioFormats) {
      const bitrate = Math.round(f.abr || f.tbr || 0);
      const label = bitrate ? `${bitrate}kbps` : 'audio';
      if (!seenAudio.has(label) && seenAudio.size < 5) {
        seenAudio.add(label);
        formats.push({
          formatId: f.format_id,
          quality: label,
          container: f.ext,
          hasVideo: false,
          hasAudio: true,
          filesize: f.filesize || f.filesize_approx,
          type: 'audio',
        });
      }
    }

    res.json({ formats });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to fetch formats' });
  }
});

//  general info endpoint 
app.post('/api/video-info', async (req, res) => {
  try {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const isYT = /youtube\.com|youtu\.be/i.test(url);
    if (isYT) url = cleanYouTubeUrl(url);

    const options = {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      skipDownload: true,
      noPlaylist: true,
      playlistItems: '1',
    };
    if (hasCookies) options.cookies = cookiesPath;

    const info = await ytDlp(url, options);
    const formats = (info.formats || [])
      .filter((f) => f.url && (f.ext === 'mp4' || f.ext === 'm4a' || f.ext === 'webm'))
      .slice(0, 20)
      .map((f) => ({
        formatId: f.format_id,
        quality: f.height ? `${f.height}p` : (f.abr ? `${Math.round(f.abr)}kbps` : 'unknown'),
        container: f.ext,
        hasVideo: f.vcodec && f.vcodec !== 'none',
        hasAudio: f.acodec && f.acodec !== 'none',
        filesize: f.filesize || f.filesize_approx || null,
      }));

    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      author: info.uploader || info.channel,
      viewCount: info.view_count,
      formats,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to fetch video info' });
  }
});

/* FACEBOOK ROUTES  */
app.post('/api/facebook/video-info', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const options = {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      skipDownload: true,
      noPlaylist: true,
      playlistItems: '1',
    };
    if (hasCookies) options.cookies = cookiesPath;

    const info = await ytDlp(url, options);

    // Create formats for your FacebookDownloader UI
    const formats = (info.formats || [])
      .filter((f) => (f.ext === 'mp4' || f.ext === 'webm') && f.vcodec && f.vcodec !== 'none')
      .sort((a, b) => (b.height || 0) - (a.height || 0))
      .slice(0, 8)
      .map((f) => ({
        formatId: f.format_id,
        quality: f.height ? `${f.height}p` : (f.format_note || 'Video'),
        container: f.ext || 'mp4',
        filesize: f.filesize || f.filesize_approx || null,
        hasVideo: true,
        hasAudio: f.acodec && f.acodec !== 'none',
      }));

    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      author: info.uploader || info.channel,
      viewCount: info.view_count,
      isPrivate: false, 
      formats: formats.length ? formats : [{
        formatId: 'best',
        quality: 'Best',
        container: 'mp4',
        filesize: null,
        hasVideo: true,
        hasAudio: true,
      }],
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to fetch Facebook video info' });
  }
});

app.post('/api/facebook/download-start', async (req, res) => {
  try {
    let { url, formatId, estimatedSize } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const downloadId = uuidv4();
    const format = formatId || 'best';

    const diskInfo = await checkDiskSpace(estimatedSize || 500 * 1024 * 1024);
    if (!diskInfo.sufficient) {
      return res.status(507).json({
        error: 'Insufficient disk space',
        message: diskInfo.message,
        freeGB: diskInfo.freeGB,
      });
    }

    res.json({ downloadId, status: 'started', diskSpace: diskInfo });

    await new Promise((resolve) => {
      if (activeDownloads.has(downloadId)) return resolve();
      const timeout = setTimeout(() => {
        downloadReadyCallbacks.delete(downloadId);
        resolve();
      }, 5000);

      downloadReadyCallbacks.set(downloadId, () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    processDownload(downloadId, url, format);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to start Facebook download' });
  }
});

// SSE progress
app.get('/api/download-progress/:downloadId', (req, res) => {
  const { downloadId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  res.write(`data: ${JSON.stringify({ status: 'connected', downloadId })}\n\n`);
  activeDownloads.set(downloadId, res);

  const cb = downloadReadyCallbacks.get(downloadId);
  if (cb) {
    cb();
    downloadReadyCallbacks.delete(downloadId);
  }

  req.on('close', () => {
    activeDownloads.delete(downloadId);
    downloadReadyCallbacks.delete(downloadId);
  });
});

async function processDownload(downloadId, url, format) {
  try {
    sendProgress(downloadId, { status: 'downloading', progress: 5, stage: 'Starting download...' });

    const safeTitle = `download_${downloadId}`;
    const outputPath = path.join(DOWNLOADS_DIR, `${downloadId}_${safeTitle}.mp4`);

    await downloadWithYtDlp(downloadId, url, format, outputPath);

    sendProgress(downloadId, {
      status: 'completed',
      filename: `${safeTitle}.mp4`,
      downloadId,
    });
  } catch (e) {
    sendProgress(downloadId, { status: 'error', message: e.message || 'Download failed' });
  }
}

function downloadWithYtDlp(downloadId, url, format, outputPath) {
  return new Promise((resolve, reject) => {
    const ytDlpExec = require('yt-dlp-exec');

    const options = {
      format,
      output: outputPath,
      noWarnings: true,
      noCheckCertificates: true,
      noPlaylist: true,
      ffmpegLocation: ffmpegStatic,
    };
    if (hasCookies) options.cookies = cookiesPath;

    if (hasAria2c) {
      options.externalDownloader = aria2cPath;
      options.externalDownloaderArgs = '-x 16 -s 16 -k 1M --file-allocation=none';
    }

    let p = 10;
    const t = setInterval(() => {
      p = Math.min(90, p + Math.random() * 7);
      sendProgress(downloadId, { status: 'downloading', progress: Math.round(p), stage: 'Downloading...' });
    }, 900);

    ytDlpExec.exec(url, options)
      .then(() => {
        clearInterval(t);
        sendProgress(downloadId, { status: 'processing', progress: 95, stage: 'Finalizing...' });
        resolve();
      })
      .catch((err) => {
        clearInterval(t);
        reject(err);
      });
  });
}

// download file
app.get('/api/download-file/:downloadId', (req, res) => {
  const { downloadId } = req.params;
  const { filename } = req.query;

  const files = fs.readdirSync(DOWNLOADS_DIR);
  const downloadFile = files.find((f) => f.startsWith(downloadId));
  if (!downloadFile) return res.status(404).json({ error: 'File not found' });

  const filePath = path.join(DOWNLOADS_DIR, downloadFile);
  const outputFilename = filename || downloadFile.replace(`${downloadId}_`, '');

  res.setHeader('Content-Disposition', `attachment; filename="${outputFilename}"`);
  res.setHeader('Content-Type', 'application/octet-stream');

  fs.createReadStream(filePath).pipe(res);
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(` Server running http://${HOST}:${PORT}`);
    console.log(` API base: http://${HOST}:${PORT}/api`);
    console.log('Facebook routes enabled: /api/facebook/video-info and /api/facebook/download-start');
  });
}

module.exports = app;

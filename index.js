const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const { v4: uuidv4 } = require('uuid');
const { spawn, execSync } = require('child_process');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const ytDlpExec = require('yt-dlp-exec');

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';

const activeDownloads = new Map();
const downloadReadyCallbacks = new Map();

// CORS
const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  process.env.CLIENT_URL,
].filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    // Allow requests without origin (server-to-server, curl, health probes)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.error(`CORS blocked for origin: ${origin}`);
    return callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

// Cookie Conversion
const convertCookiesIfMissing = () => {
  const jsonPath = path.join(__dirname, 'cookies.json');
  const txtPath =
    process.env.NODE_ENV === 'production'
      ? '/tmp/cookies.txt'
      : path.join(__dirname, 'cookies.txt');

  if (fs.existsSync(jsonPath)) {
    try {
      const jsonStat = fs.statSync(jsonPath);
      let txtStat = null;

      if (fs.existsSync(txtPath)) {
        txtStat = fs.statSync(txtPath);
      }

      if (!txtStat || jsonStat.mtime > txtStat.mtime) {
        console.log(`Converting cookies.json to ${txtPath}...`);
        const rawContent = fs.readFileSync(jsonPath, 'utf8');
        let allCookies = [];

        try {
          allCookies = JSON.parse(rawContent);
        } catch (e) {
          const fixedContent =
            '[' +
            rawContent.replace(/\]\s*\[/g, ',').replace(/^\s*\[|\]\s*$/g, '') +
            ']';
          allCookies = JSON.parse(fixedContent);
        }

        if (Array.isArray(allCookies)) {
          let output = '# Netscape HTTP Cookie File\n';
          allCookies.forEach((c) => {
            const domain = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
            const sub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
            const exp = Math.floor(c.expirationDate || 0);
            output += `${domain}\t${sub}\t${c.path || '/'}\t${c.secure ? 'TRUE' : 'FALSE'}\t${exp}\t${c.name}\t${c.value}\n`;
          });

          fs.writeFileSync(txtPath, output);
          console.log('Cookies converted successfully');
        }
      }
    } catch (err) {
      console.error('Cookie conversion failed:', err.message);
    }
  }
};

convertCookiesIfMissing();

// aria2c detection
let hasAria2c = false;
let aria2cPath = 'aria2c';
const userLocalAppData = process.env.LOCALAPPDATA || '';

let aria2cPaths = [
  'aria2c',
  path.join(userLocalAppData, 'Microsoft', 'WinGet', 'Links', 'aria2c.exe'),
  path.join(process.env.PROGRAMFILES || '', 'aria2', 'aria2c.exe'),
  'C:\\ProgramData\\chocolatey\\bin\\aria2c.exe',
];

aria2cPaths = Array.from(new Set(aria2cPaths));

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
          } else if (item.toLowerCase() === 'aria2c.exe') {
            return fullPath;
          }
        }
      } catch (e) {}
      return null;
    };

    const found = findAria2c(wingetPackages);
    if (found) aria2cPaths.unshift(found);
    aria2cPaths = Array.from(new Set(aria2cPaths));
  }
} catch (e) {}

for (const p of aria2cPaths) {
  try {
    execSync(`"${p}" --version`, { stdio: 'ignore' });
    hasAria2c = true;
    aria2cPath = p;
    console.log(`aria2c found at: ${p.length > 50 ? '...' + p.slice(-47) : p}`);
    console.log('Multi-threaded downloads enabled (16 connections) for non-YouTube');
    break;
  } catch (e) {}
}

if (!hasAria2c) {
  console.log('aria2c not found - using standard downloads');
}

// Downloads directory
const DOWNLOADS_DIR =
  process.env.DOWNLOADS_DIR ||
  (process.env.NODE_ENV === 'production'
    ? '/tmp/downloads'
    : path.join(__dirname, 'downloads'));

if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Cookies
const cookiesPath =
  process.env.NODE_ENV === 'production'
    ? '/tmp/cookies.txt'
    : path.join(__dirname, 'cookies.txt');

let hasCookies = fs.existsSync(cookiesPath);
let cookieStatus = { valid: false, message: '', expiringSoon: false };

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

    const hasLoginCookie = cookieContent.includes('LOGIN_INFO') || cookieContent.includes('SID');
    const hasSessionCookie = cookieContent.includes('SSID') || cookieContent.includes('HSID');

    const importantCookieNames = [
      'LOGIN_INFO',
      'SID',
      'SSID',
      'HSID',
      'APISID',
      'SAPISID',
      '__Secure-1PSID',
      '__Secure-3PSID',
      '__Secure-1PAPISID',
      '__Secure-3PAPISID',
    ];

    const now = Math.floor(Date.now() / 1000);
    const oneWeekFromNow = now + 604800;

    let hasExpiredImportant = false;
    let expiringSoon = false;
    let earliestExpiry = Infinity;
    let expiredCookieName = '';

    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length >= 7) {
        const cookieName = parts[5];
        const expiry = parseInt(parts[4], 10);
        const isImportant = importantCookieNames.some((name) => cookieName.includes(name));

        if (!isNaN(expiry) && expiry > 0) {
          if (expiry < now && isImportant) {
            hasExpiredImportant = true;
            expiredCookieName = cookieName;
          } else if (expiry < oneWeekFromNow && isImportant) {
            expiringSoon = true;
            earliestExpiry = Math.min(earliestExpiry, expiry);
          }
        }
      }
    }

    if (hasExpiredImportant) {
      cookieStatus = {
        valid: false,
        message: `Important cookie expired (${expiredCookieName}). Please re-export from browser.`,
        expiringSoon: false,
      };
    } else if (!hasLoginCookie && !hasSessionCookie) {
      cookieStatus = {
        valid: false,
        message: 'Missing YouTube login cookies. Make sure you are logged in when exporting.',
        expiringSoon: false,
      };
    } else if (expiringSoon) {
      const daysLeft = Math.ceil((earliestExpiry - now) / 86400);
      cookieStatus = {
        valid: true,
        message: `Cookies will expire in ${daysLeft} day(s). Consider refreshing soon.`,
        expiringSoon: true,
      };
    } else {
      cookieStatus = { valid: true, message: 'Cookies are valid', expiringSoon: false };
    }

    return cookieStatus;
  } catch (error) {
    cookieStatus = {
      valid: false,
      message: `Error reading cookies: ${error.message}`,
      expiringSoon: false,
    };
    return cookieStatus;
  }
};

cookieStatus = checkCookieHealth();
hasCookies = cookieStatus.valid;
console.log(
  cookieStatus.valid
    ? `Found cookies.txt - ${cookieStatus.message}`
    : `Cookie issue: ${cookieStatus.message}`
);

// Disk space check
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
        freeGB: parseFloat(freeGB),
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
        freeGB: parseFloat(freeGB),
        sufficient: freeBytes >= minRequired,
        message: freeBytes < minRequired ? `Low disk space: ${freeGB}GB free` : `${freeGB}GB available`,
      };
    }
  } catch (error) {
    console.error('Disk space check error:', error.message);
    return { freeBytes: 0, freeGB: 0, sufficient: true, message: 'Unable to check disk space' };
  }
};

// Cleanup old files
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

// Helpers
const cleanYouTubeUrl = (url) => {
  try {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        const videoId = match[1];
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
    }

    const urlObj = new URL(url);

    if (urlObj.hostname === 'youtu.be') {
      const videoId = urlObj.pathname.slice(1);
      if (videoId && videoId.length >= 11) {
        const cleanId = videoId.substring(0, 11);
        return `https://www.youtube.com/watch?v=${cleanId}`;
      }
    }

    if (urlObj.hostname.includes('youtube.com')) {
      const videoId = urlObj.searchParams.get('v');
      if (videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
    }

    return url;
  } catch (e) {
    console.error('URL cleaning error:', e.message);
    return url;
  }
};

function isYouTube(url) {
  return /youtube\.com|youtu\.be/i.test(url || '');
}

function isSelectorExpression(fmt) {
  if (!fmt) return false;
  return /bestvideo|bestaudio|worstvideo|worstaudio|\[height<=/i.test(fmt);
}

function sendProgress(downloadId, progressData) {
  const res = activeDownloads.get(downloadId);
  if (!res) return;
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(`data: ${JSON.stringify(progressData)}\n\n`);
  } catch (e) {
    activeDownloads.delete(downloadId);
  }
}

const detectPlatform = (url) => {
  if (!url) return 'unknown';
  if (/youtube\.com|youtu\.be|youtube-nocookie\.com/i.test(url)) return 'youtube';
  if (/facebook\.com|fb\.watch|fb\.com/i.test(url)) return 'facebook';
  if (/instagram\.com|instagr\.am/i.test(url)) return 'instagram';
  if (/tiktok\.com/i.test(url)) return 'tiktok';
  if (/twitter\.com|x\.com|t\.co/i.test(url)) return 'twitter';
  return 'unknown';
};

function parseYtDlpProgress(output) {
  const match = output.match(/(\d+\.?\d*)%/);
  if (match) return parseFloat(match[1]);
  return null;
}

function applyYtDlpHardening(options, url) {
  options.retries = options.retries ?? 10;
  options.fragmentRetries = options.fragmentRetries ?? 10;
  options.forceIpv4 = options.forceIpv4 ?? true;
  options.geoBypass = options.geoBypass ?? true;

  const hdr = [
    'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language: en-US,en;q=0.9',
    'Sec-Fetch-Mode: navigate',
  ];

  if (isYouTube(url)) {
    hdr.push('Referer: https://www.youtube.com/');
  }

  if (!options.addHeader) options.addHeader = hdr;
  else if (Array.isArray(options.addHeader)) options.addHeader = [...options.addHeader, ...hdr];

  options.sleepRequests = options.sleepRequests ?? 1;
  options.sleepInterval = options.sleepInterval ?? 1;
  options.noWarnings = options.noWarnings ?? true;
  options.noCheckCertificates = options.noCheckCertificates ?? true;
  options.noPlaylist = options.noPlaylist ?? true;

  if (hasCookies && fs.existsSync(cookiesPath)) {
    options.cookies = options.cookies ?? cookiesPath;
  }

  return options;
}

// Routes
app.get('/api/health', async (req, res) => {
  const diskInfo = await checkDiskSpace();
  const freshCookieStatus = checkCookieHealth();
  hasCookies = freshCookieStatus.valid;

  res.json({
    status: 'Server is running!',
    ffmpeg: !!ffmpegStatic,
    hasCookies: freshCookieStatus.valid,
    cookieStatus: freshCookieStatus,
    diskSpace: diskInfo,
    aria2c: hasAria2c,
    allowedOrigins,
  });
});

app.post('/api/detect-platform', (req, res) => {
  const { url } = req.body;
  res.json({ platform: detectPlatform(url), url });
});

app.post('/api/video-metadata', async (req, res) => {
  try {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    if (isYouTube(url)) url = cleanYouTubeUrl(url);

    const options = applyYtDlpHardening(
      {
        dumpSingleJson: true,
        skipDownload: true,
        playlistItems: '1',
      },
      url
    );

    const info = await ytDlpExec(url, options);

    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      author: info.uploader || info.channel,
      viewCount: info.view_count,
      isLive: info.is_live,
    });
  } catch (error) {
    console.error('Metadata error:', error.message);
    const msg = error.message || '';

    if (msg.includes('Sign in') || msg.includes('cookies') || msg.includes('confirm your age')) {
      return res.status(403).json({ error: 'Age-restricted or private video. Cookies may be expired.' });
    }
    if (msg.includes('Video unavailable') || msg.includes('404')) {
      return res.status(404).json({ error: 'Video not found or unavailable.' });
    }
    if (msg.includes('Incomplete YouTube ID')) {
      return res.status(400).json({ error: 'Invalid YouTube URL.' });
    }

    res.status(500).json({ error: 'Failed to fetch video metadata' });
  }
});

app.post('/api/video-formats', async (req, res) => {
  try {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    if (isYouTube(url)) url = cleanYouTubeUrl(url);

    const options = applyYtDlpHardening(
      {
        dumpSingleJson: true,
        skipDownload: true,
        playlistItems: '1',
      },
      url
    );

    const info = await ytDlpExec(url, options);

    const formats = [];
    const seenQualities = new Set();

    formats.push({
      formatId: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
      quality: 'Best Quality',
      container: 'mp4',
      hasVideo: true,
      hasAudio: true,
      filesize: null,
      type: 'video',
      isQualitySelector: true,
    });
    seenQualities.add('Best Quality');

    if (info.formats) {
      const videoFormats = info.formats
        .filter((f) => f.vcodec !== 'none' && f.height && f.protocol !== 'm3u8_native' && f.protocol !== 'm3u8')
        .sort((a, b) => (b.height || 0) - (a.height || 0));

      for (const f of videoFormats) {
        const quality = `${f.height}p`;
        if (!seenQualities.has(quality) && seenQualities.size < 6) {
          seenQualities.add(quality);
          const selector = `bestvideo[height<=${f.height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${f.height}]+bestaudio/best[height<=${f.height}]`;
          formats.push({
            formatId: selector,
            quality,
            container: 'mp4',
            hasVideo: true,
            hasAudio: f.acodec !== 'none',
            filesize: f.filesize || f.filesize_approx || null,
            type: 'video',
            fps: f.fps || null,
            vcodec: f.vcodec,
            acodec: f.acodec,
            isQualitySelector: true,
          });
        }
      }

      const audioFormats = info.formats
        .filter((f) => {
          const hasAudio = f.acodec && f.acodec !== 'none';
          const hasNoVideo = !f.vcodec || f.vcodec === 'none' || !f.height;
          return hasAudio && hasNoVideo;
        })
        .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));

      const seenAudio = new Set();
      for (const f of audioFormats) {
        const bitrate = f.abr || f.tbr || 0;
        const q = bitrate ? `${Math.round(bitrate)}kbps` : 'audio';
        if (!seenAudio.has(q) && seenAudio.size < 5) {
          seenAudio.add(q);
          formats.push({
            formatId: f.format_id,
            quality: q,
            container: f.ext,
            hasVideo: false,
            hasAudio: true,
            filesize: f.filesize || f.filesize_approx || null,
            type: 'audio',
            abr: f.abr || f.tbr,
            acodec: f.acodec,
          });
        }
      }
    }

    res.json({
      formats,
      bestAudioFormat: formats.find((f) => !f.hasVideo && f.hasAudio)?.formatId,
    });
  } catch (error) {
    console.error('Formats error:', error.message);
    res.status(500).json({ error: 'Failed to fetch formats' });
  }
});

app.get('/api/download-progress/:downloadId', (req, res) => {
  const { downloadId } = req.params;
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Vary', 'Origin');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  res.write(`data: ${JSON.stringify({ status: 'connected', downloadId })}\n\n`);

  activeDownloads.set(downloadId, res);

  const callback = downloadReadyCallbacks.get(downloadId);
  if (callback) {
    callback();
    downloadReadyCallbacks.delete(downloadId);
  }

  req.on('close', () => {
    activeDownloads.delete(downloadId);
    downloadReadyCallbacks.delete(downloadId);
  });
});

app.post('/api/download-start', async (req, res) => {
  try {
    let { url, itag, formatId, convertToMp3, mp3Bitrate, mergeAudio, estimatedSize } = req.body;
    const downloadId = uuidv4();
    const format = formatId || itag;

    if (!url || !format) return res.status(400).json({ error: 'URL and format are required' });

    if (isYouTube(url)) url = cleanYouTubeUrl(url);

    const diskInfo = await checkDiskSpace(estimatedSize || 500 * 1024 * 1024);
    if (!diskInfo.sufficient) {
      return res.status(507).json({
        error: 'Insufficient disk space',
        message: diskInfo.message,
        freeGB: diskInfo.freeGB,
      });
    }

    const freshCookieStatus = checkCookieHealth();
    hasCookies = freshCookieStatus.valid;
    if (!freshCookieStatus.valid) console.warn('Cookie warning:', freshCookieStatus.message);

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

    processDownload(downloadId, url, format, !!convertToMp3, mp3Bitrate || 192, !!mergeAudio);
  } catch (error) {
    console.error('Download start error:', error);
    res.status(500).json({ error: 'Failed to start download' });
  }
});

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

  const fileStream = fs.createReadStream(filePath);
  fileStream.pipe(res);

  fileStream.on('end', () => {
    setTimeout(() => {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }, 5000);
  });
});

app.post('/api/facebook/video-info', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const options = applyYtDlpHardening(
      {
        dumpSingleJson: true,
        skipDownload: true,
        playlistItems: '1',
      },
      url
    );

    const info = await ytDlpExec(url, options);

    const formats = (info.formats || [])
      .filter((f) => (f.ext === 'mp4' || f.ext === 'webm') && f.vcodec && f.vcodec !== 'none')
      .sort((a, b) => (b.height || 0) - (a.height || 0))
      .slice(0, 8)
      .map((f) => ({
        formatId: f.format_id,
        quality: f.height ? `${f.height}p` : f.format_note || 'Video',
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
      formats:
        formats.length > 0
          ? formats
          : [
              {
                formatId: 'best',
                quality: 'Best',
                container: 'mp4',
                filesize: null,
                hasVideo: true,
                hasAudio: true,
              },
            ],
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to fetch Facebook video info' });
  }
});

app.post('/api/facebook/download-start', async (req, res) => {
  try {
    const { url, formatId, estimatedSize } = req.body;
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

    processDownload(downloadId, url, format, false, 192, false);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to start Facebook download' });
  }
});

const handleGenericPlatformInfo = async (req, res, platform) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const options = applyYtDlpHardening(
      {
        dumpSingleJson: true,
        skipDownload: true,
        playlistItems: '1',
      },
      url
    );

    const info = await ytDlpExec(url, options);

    const formats = (info.formats || [])
      .filter((f) => f.ext === 'mp4' || (f.vcodec && f.vcodec !== 'none'))
      .map((f) => ({
        formatId: f.format_id,
        quality: f.height ? `${f.height}p` : f.format_note || 'Best',
        container: f.ext || 'mp4',
        filesize: f.filesize || f.filesize_approx || null,
        hasVideo: true,
        hasAudio: f.acodec && f.acodec !== 'none',
      }))
      .sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0));

    res.json({
      title: info.title || `${platform} Video`,
      thumbnail: info.thumbnail,
      duration: info.duration,
      author: info.uploader || info.channel || info.uploader_id,
      viewCount: info.view_count || info.reproduction_count,
      likeCount: info.like_count,
      commentCount: info.comment_count,
      description: info.description,
      caption: info.description || info.title,
      isPrivate: false,
      formats:
        formats.length > 0
          ? formats
          : [
              {
                formatId: 'best',
                quality: 'Best Quality',
                container: 'mp4',
                filesize: null,
                hasVideo: true,
                hasAudio: true,
              },
            ],
    });
  } catch (e) {
    console.error(`${platform} info error:`, e.message);
    res.status(500).json({ error: e.message || `Failed to fetch ${platform} video info` });
  }
};

const handleGenericPlatformDownloadStart = async (req, res, platform) => {
  try {
    const { url, formatId, estimatedSize } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const downloadId = uuidv4();
    const format = formatId || 'best';

    const diskInfo = await checkDiskSpace(estimatedSize || 500 * 1024 * 1024);
    if (!diskInfo.sufficient) {
      return res.status(507).json({ error: 'Insufficient disk space', message: diskInfo.message });
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

    processDownload(downloadId, url, format, false, 192, false);
  } catch (e) {
    res.status(500).json({ error: e.message || `Failed to start ${platform} download` });
  }
};

app.post('/api/instagram/video-info', (req, res) => handleGenericPlatformInfo(req, res, 'Instagram'));
app.post('/api/instagram/download-start', (req, res) => handleGenericPlatformDownloadStart(req, res, 'Instagram'));

app.post('/api/tiktok/video-info', (req, res) => handleGenericPlatformInfo(req, res, 'TikTok'));
app.post('/api/tiktok/download-start', (req, res) => handleGenericPlatformDownloadStart(req, res, 'TikTok'));

app.post('/api/twitter/video-info', (req, res) => handleGenericPlatformInfo(req, res, 'Twitter'));
app.post('/api/twitter/download-start', (req, res) => handleGenericPlatformDownloadStart(req, res, 'Twitter'));

app.post('/api/direct/download-start', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const downloadId = uuidv4();

    res.json({ downloadId, status: 'started' });

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

    processDownload(downloadId, url, 'best', false, 192, false);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to start direct download' });
  }
});

// Download pipeline
async function processDownload(downloadId, url, format, convertToMp3, mp3Bitrate = 192, mergeAudio = false) {
  try {
    sendProgress(downloadId, { status: 'downloading', progress: 0, stage: 'Preparing download...' });

    const infoOptions = applyYtDlpHardening(
      {
        dumpSingleJson: true,
        playlistItems: '1',
      },
      url
    );

    const info = await ytDlpExec(url, infoOptions);
    const safeTitle = (info.title || 'video')
      .replace(/[^\w\s-]/gi, '')
      .replace(/\s+/g, '_')
      .substring(0, 100);

    const selectorExpr = isSelectorExpression(format);
    const selectedFormat = !selectorExpr ? (info.formats || []).find((f) => f.format_id === format) : null;

    const isAudioOnly = !selectorExpr && selectedFormat && selectedFormat.vcodec === 'none';
    const isVideoOnly = !selectorExpr && selectedFormat && selectedFormat.acodec === 'none';

    let outputFilename;
    let outputPath;

    if (convertToMp3 && isAudioOnly) {
      outputFilename = `${safeTitle}.mp3`;
      outputPath = path.join(DOWNLOADS_DIR, `${downloadId}_${outputFilename}`);
      await downloadWithYtDlp(downloadId, url, format, outputPath, 'mp3', mp3Bitrate);
    } else if (mergeAudio && (isVideoOnly || selectorExpr)) {
      outputFilename = `${safeTitle}.mp4`;
      outputPath = path.join(DOWNLOADS_DIR, `${downloadId}_${outputFilename}`);

      if (selectorExpr && /bestaudio/i.test(format)) {
        await downloadWithYtDlp(downloadId, url, format, outputPath, 'mp4');
      } else {
        await downloadParallelMerge(downloadId, url, format, outputPath, info);
      }
    } else {
      const ext = selectedFormat?.ext || 'mp4';
      outputFilename = `${safeTitle}.${ext}`;
      outputPath = path.join(DOWNLOADS_DIR, `${downloadId}_${outputFilename}`);
      await downloadWithYtDlp(downloadId, url, format, outputPath);
    }

    sendProgress(downloadId, { status: 'completed', filename: outputFilename, downloadId });
  } catch (error) {
    console.error('Download processing error:', error);
    sendProgress(downloadId, { status: 'error', message: error.message || 'Download failed' });
  }
}

async function downloadParallelMerge(downloadId, url, videoFormat, outputPath, info) {
  return new Promise(async (resolve, reject) => {
    try {
      const formats = info.formats || [];
      const audioFormats = formats
        .filter((f) => f.vcodec === 'none' && f.acodec !== 'none')
        .sort((a, b) => (b.abr || 0) - (a.abr || 0));

      const bestAudio = audioFormats[0];
      if (!bestAudio) {
        return downloadWithYtDlp(downloadId, url, `${videoFormat}+bestaudio`, outputPath, 'mp4')
          .then(resolve)
          .catch(reject);
      }

      const videoPath = path.join(DOWNLOADS_DIR, `${downloadId}_video_temp.mp4`);
      const audioPath = path.join(DOWNLOADS_DIR, `${downloadId}_audio_temp.m4a`);

      const baseOptions = applyYtDlpHardening({}, url);

      if (hasAria2c && !isYouTube(url)) {
        baseOptions.externalDownloader = aria2cPath;
        baseOptions.externalDownloaderArgs = '-x 16 -s 16 -k 1M --file-allocation=none';
      }

      sendProgress(downloadId, { status: 'downloading', progress: 5, stage: 'Parallel download starting...' });

      let videoProgress = 0;
      let audioProgress = 0;
      let videoComplete = false;
      let audioComplete = false;

      const updateCombined = () => {
        const combined = Math.round(videoProgress * 0.7 + audioProgress * 0.2);
        sendProgress(downloadId, {
          status: 'downloading',
          progress: Math.min(combined, 90),
          stage: `Parallel: Video ${Math.round(videoProgress)}% | Audio ${Math.round(audioProgress)}%`,
        });
      };

      const videoTicker = setInterval(() => {
        if (!videoComplete) {
          videoProgress = Math.min(videoProgress + Math.random() * 10, 95);
          updateCombined();
        }
      }, 600);

      const audioTicker = setInterval(() => {
        if (!audioComplete) {
          audioProgress = Math.min(audioProgress + Math.random() * 15, 95);
          updateCombined();
        }
      }, 500);

      const videoPromise = ytDlpExec.exec(url, {
        ...baseOptions,
        format: videoFormat,
        output: videoPath,
        ffmpegLocation: ffmpegStatic,
      }).then(() => {
        videoComplete = true;
        videoProgress = 100;
      });

      const audioPromise = ytDlpExec.exec(url, {
        ...baseOptions,
        format: bestAudio.format_id,
        output: audioPath,
        ffmpegLocation: ffmpegStatic,
      }).then(() => {
        audioComplete = true;
        audioProgress = 100;
      });

      await Promise.all([videoPromise, audioPromise]);

      clearInterval(videoTicker);
      clearInterval(audioTicker);

      sendProgress(downloadId, { status: 'processing', progress: 92, stage: 'Merging video + audio...' });

      await new Promise((mergeResolve, mergeReject) => {
        ffmpeg()
          .input(videoPath)
          .input(audioPath)
          .outputOptions(['-c:v copy', '-c:a aac', '-b:a 192k', '-movflags +faststart', '-y'])
          .output(outputPath)
          .on('progress', (progress) => {
            const p = 92 + ((progress.percent || 0) * 0.08);
            sendProgress(downloadId, { status: 'processing', progress: Math.round(p), stage: 'Merging...' });
          })
          .on('end', () => {
            try {
              if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
              if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
            } catch (e) {}
            mergeResolve();
          })
          .on('error', (err) => {
            try {
              if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
              if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
            } catch (e) {}
            mergeReject(err);
          })
          .run();
      });

      resolve();
    } catch (err) {
      reject(err);
    }
  });
}

function downloadWithYtDlp(downloadId, url, format, outputPath, audioFormat = null, audioBitrate = null) {
  return new Promise((resolve, reject) => {
    const baseOptions = {
      format,
      output: outputPath,
      ffmpegLocation: ffmpegStatic,
      noWarnings: true,
      noCheckCertificates: true,
      noPlaylist: true,
      progress: true,
      newline: true,
    };

    const options = applyYtDlpHardening(baseOptions, url);

    if (hasAria2c && !audioFormat && !isYouTube(url)) {
      options.externalDownloader = aria2cPath;
      options.externalDownloaderArgs = '-x 16 -s 16 -k 1M --file-allocation=none';
    }

    if (audioFormat === 'mp3') {
      options.extractAudio = true;
      options.audioFormat = 'mp3';
      if (audioBitrate) options.audioQuality = `${audioBitrate}K`;
    }

    if (String(format).includes('+')) {
      options.mergeOutputFormat = 'mp4';
    }

    let ytDlpPath = require('yt-dlp-exec').path;
    if (!ytDlpPath) {
      try {
        ytDlpPath = require('yt-dlp-exec/src/constants').YOUTUBE_DL_PATH;
      } catch (e) {
        const binExt = process.platform === 'win32' ? '.exe' : '';
        ytDlpPath = path.join(__dirname, 'node_modules', 'yt-dlp-exec', 'bin', `yt-dlp${binExt}`);
      }
    }

    const args = [url];
    Object.entries(options).forEach(([key, val]) => {
      const flag = `--${key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}`;
      if (val === true) {
        args.push(flag);
      } else if (val !== false && val !== null && val !== undefined) {
        if (Array.isArray(val)) {
          val.forEach((v) => {
            args.push(flag);
            args.push(v);
          });
        } else {
          args.push(flag);
          args.push(String(val));
        }
      }
    });

    const proc = spawn(ytDlpPath || 'yt-dlp', args, { windowsHide: true });

    let lastProgress = 0;
    const stage = hasAria2c && !isYouTube(url) ? 'Multi-threaded download...' : 'Downloading...';
    let stderrBuffer = '';

    proc.stdout.on('data', (data) => {
      const output = data.toString();
      const progress = parseYtDlpProgress(output);

      if (progress !== null && progress > lastProgress) {
        lastProgress = progress;
        sendProgress(downloadId, {
          status: 'downloading',
          progress: Math.round(progress),
          stage: `${stage} ${Math.round(progress)}%`,
        });
      }

      if (output.includes('Merging') || output.includes('merging')) {
        sendProgress(downloadId, { status: 'processing', progress: 95, stage: 'Merging streams...' });
      }
    });

    proc.stderr.on('data', (data) => {
      const output = data.toString();
      stderrBuffer += output;

      const progress = parseYtDlpProgress(output);
      if (progress !== null && progress > lastProgress) {
        lastProgress = progress;
        sendProgress(downloadId, {
          status: 'downloading',
          progress: Math.round(progress),
          stage,
        });
      }

      if (output.includes('ERROR:')) {
        console.error(`yt-dlp error: ${output}`);
      }
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('Download timed out after 10 minutes'));
    }, 10 * 60 * 1000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        sendProgress(downloadId, { status: 'processing', progress: 100, stage: 'Finalizing...' });
        resolve();
      } else {
        const cleanError =
          stderrBuffer
            .split('\n')
            .filter((line) => line.includes('ERROR:') || line.includes('Warning:'))
            .join('\n')
            .trim() || stderrBuffer.trim().split('\n').pop();

        reject(new Error(cleanError || `yt-dlp exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// Start server
app.listen(PORT, HOST, () => {
  console.log(`Server running on ${HOST}:${PORT}`);
  console.log(`API endpoints available at /api`);
  console.log(`FFmpeg path: ${ffmpegStatic}`);
  console.log(`Allowed origins: ${allowedOrigins.join(', ')}`);
});

module.exports = app;
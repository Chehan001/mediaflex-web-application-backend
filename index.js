require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const { v4: uuidv4 } = require('uuid');
const { spawn, execSync } = require('child_process');   

// Use yt-dlp --> for reliable downloads
const ytDlp = require('yt-dlp-exec');

// Set --> FFmpeg path
ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || 'localhost';

// Store active downloads for progress tracking
const activeDownloads = new Map();
const downloadReadyCallbacks = new Map();

// Check for aria2c availability for multi-threaded downloads
let hasAria2c = false;
let aria2cPath = 'aria2c';

// Check common aria2c installation paths on Windows
const userLocalAppData = process.env.LOCALAPPDATA || '';
const aria2cPaths = [
    'aria2c',
    path.join(userLocalAppData, 'Microsoft', 'WinGet', 'Links', 'aria2c.exe'),
    path.join(process.env.PROGRAMFILES || '', 'aria2', 'aria2c.exe'),
    'C:\\ProgramData\\chocolatey\\bin\\aria2c.exe',
];

// Also search in WinGet Packages folder 
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
            } catch (e) { }
            return null;
        };
        const found = findAria2c(wingetPackages);
        if (found) aria2cPaths.unshift(found);
    }
} catch (e) { }

for (const p of aria2cPaths) {
    try {
        execSync(`"${p}" --version`, { stdio: 'ignore' });
        hasAria2c = true;
        aria2cPath = p;
        console.log(` aria2c found at: ${p.length > 50 ? '...' + p.slice(-47) : p}`);
        console.log('   Multi-threaded downloads enabled (16 connections)');
        break;
    } catch {
        // Try next path
    }
}

if (!hasAria2c) {
    console.log(' aria2c not found - using standard downloads (install aria2c for faster downloads)');
    console.log(' Run: winget install aria2.aria2');
    console.log(' Then restart your terminal and the server');
}

// Configure CORS for production
const corsOptions = {
    origin: [
        'http://localhost:3000'
    ],
    methods: ['GET', 'POST', 'DELETE'],
    credentials: true
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());

// SETUP: Downloads Directory (Cloud Run uses /tmp)
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || (process.env.NODE_ENV === 'production' ? '/tmp/downloads' : path.join(__dirname, 'downloads'));

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Check if cookies file exists
const cookiesPath = path.join(__dirname, 'cookies.txt');
let hasCookies = fs.existsSync(cookiesPath);
let cookieStatus = { valid: false, message: '', expiringSoon: false };

// Cookie Health Check Function
const checkCookieHealth = () => {
    if (!fs.existsSync(cookiesPath)) {
        cookieStatus = { valid: false, message: 'No cookies.txt found', expiringSoon: false };
        return cookieStatus;
    }

    try {
        const cookieContent = fs.readFileSync(cookiesPath, 'utf8');
        const lines = cookieContent.split('\n').filter(line => !line.startsWith('#') && line.trim());

        if (lines.length === 0) {
            cookieStatus = { valid: false, message: 'cookies.txt is empty', expiringSoon: false };
            return cookieStatus;
        }

        // Check for important YouTube cookies
        const hasLoginCookie = cookieContent.includes('LOGIN_INFO') || cookieContent.includes('SID');
        const hasSessionCookie = cookieContent.includes('SSID') || cookieContent.includes('HSID');

        // Important authentication cookies to check for expiry
        const importantCookieNames = [
            'LOGIN_INFO', 'SID', 'SSID', 'HSID', 'APISID', 'SAPISID',
            '__Secure-1PSID', '__Secure-3PSID', '__Secure-1PAPISID', '__Secure-3PAPISID',
            'sessionid', 'csrftoken', 'ds_user_id' 
        ];

        // Check cookie expiry dates 
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
                const isImportant = importantCookieNames.some(name => cookieName.includes(name));

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
                expiringSoon: false
            };
        } else if (!hasLoginCookie && !hasSessionCookie) {
            cookieStatus = {
                valid: false,
                message: 'Missing YouTube login cookies. Make sure you are logged in when exporting.',
                expiringSoon: false
            };
        } else if (expiringSoon) {
            const daysLeft = Math.ceil((earliestExpiry - now) / 86400);
            cookieStatus = {
                valid: true,
                message: `Cookies will expire in ${daysLeft} day(s). Consider refreshing soon.`,
                expiringSoon: true
            };
        } else {
            cookieStatus = {
                valid: true,
                message: 'Cookies are valid',
                expiringSoon: false
            };
        }

        return cookieStatus;
    } catch (error) {
        cookieStatus = { valid: false, message: `Error reading cookies: ${error.message}`, expiringSoon: false };
        return cookieStatus;
    }
};

//  Disk Space Check Function
const checkDiskSpace = async (requiredBytes = 0) => {
    try {
        // Get disk space for the downloads directory
        const absolutePath = path.resolve(DOWNLOADS_DIR);
        const driveLetter = absolutePath.charAt(0).toUpperCase();

        if (process.platform === 'win32') {
            // Windows: Use PowerShell
            const result = execSync(
                `powershell -command "(Get-PSDrive ${driveLetter}).Free"`,
                { encoding: 'utf8', timeout: 5000 }
            ).trim();

            const freeBytes = parseInt(result, 10);
            const freeGB = (freeBytes / (1024 * 1024 * 1024)).toFixed(2);

            // Warn if less than 1GB free or less than required
            const minRequired = Math.max(1024 * 1024 * 1024, requiredBytes + 500 * 1024 * 1024);

            return {
                freeBytes,
                freeGB: parseFloat(freeGB),
                sufficient: freeBytes >= minRequired,
                message: freeBytes < minRequired
                    ? `Low disk space: ${freeGB}GB free. Need at least ${(minRequired / (1024 * 1024 * 1024)).toFixed(2)}GB.`
                    : `${freeGB}GB available`
            };
        } else {
           
            const result = execSync(`df -B1 "${DOWNLOADS_DIR}" | tail -1 | awk '{print $4}'`, { encoding: 'utf8' }).trim();
            const freeBytes = parseInt(result, 10);
            const freeGB = (freeBytes / (1024 * 1024 * 1024)).toFixed(2);

            const minRequired = Math.max(1024 * 1024 * 1024, requiredBytes + 500 * 1024 * 1024);

            return {
                freeBytes,
                freeGB: parseFloat(freeGB),
                sufficient: freeBytes >= minRequired,
                message: freeBytes < minRequired
                    ? `Low disk space: ${freeGB}GB free`
                    : `${freeGB}GB available`
            };
        }
    } catch (error) {
        console.error('Disk space check error:', error.message);
        return { freeBytes: 0, freeGB: 0, sufficient: true, message: 'Unable to check disk space' };
    }
};

// Initial cookie check at startup
cookieStatus = checkCookieHealth();
hasCookies = cookieStatus.valid;

if (cookieStatus.valid) {
    if (cookieStatus.expiringSoon) {
        console.log(`  ${cookieStatus.message}`);
    } else {
        console.log(' Found cookies.txt - cookies are valid');
    }
} else {
    console.log(` Cookie issue: ${cookieStatus.message}`);
}

// Middleware to clean up old files in downloads directory
app.use((req, res, next) => {
    // Clean up files older than 1 hour
    const cleanup = () => {
        fs.readdir(DOWNLOADS_DIR, (err, files) => {
            if (err) return;

            const now = Date.now();
            files.forEach(file => {
                const filePath = path.join(DOWNLOADS_DIR, file);
                fs.stat(filePath, (err, stats) => {
                    if (err) return;
                    if (now - stats.mtimeMs > 3600000) { // 1 hour
                        fs.unlink(filePath, () => { });
                    }
                });
            });
        });
    };

    // Run cleanup occasionally 
    if (Math.random() < 0.01) {
        cleanup();
    }

    next();
});

// Check disk space at startup
checkDiskSpace().then(diskInfo => {
    if (!diskInfo.sufficient) {
        console.warn(` WARNING: ${diskInfo.message}`);
    } else {
        console.log(` Disk space: ${diskInfo.freeGB}GB available`);
    }
});

// Helper: Clean YouTube URL to extract only video ID
const cleanYouTubeUrl = (url) => {
    try {
        const patterns = [
            /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
            /^([a-zA-Z0-9_-]{11})$/
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match && match[1]) {
                const videoId = match[1];
                console.log(` Extracted video ID: ${videoId} from URL`);
                return `https://www.youtube.com/watch?v=${videoId}`;
            }
        }

        const urlObj = new URL(url);

        if (urlObj.hostname === 'youtu.be') {
            const videoId = urlObj.pathname.slice(1);
            if (videoId && videoId.length >= 11) {
                const cleanId = videoId.substring(0, 11);
                console.log(` Cleaned youtu.be URL: ${cleanId}`);
                return `https://www.youtube.com/watch?v=${cleanId}`;
            }
        }

        if (urlObj.hostname.includes('youtube.com')) {
            const videoId = urlObj.searchParams.get('v');
            if (videoId) {
                console.log(` Cleaned youtube.com URL: ${videoId}`);
                return `https://www.youtube.com/watch?v=${videoId}`;
            }
        }

        return url;
    } catch (e) {
        console.error('URL cleaning error:', e.message);
        return url;
    }
};

// Health check
app.get('/api/health', async (req, res) => {
    const diskInfo = await checkDiskSpace();
    const freshCookieStatus = checkCookieHealth();

    res.json({
        status: 'Server is running!',
        ffmpeg: !!ffmpegStatic,
        hasCookies: freshCookieStatus.valid,
        cookieStatus: freshCookieStatus,
        diskSpace: diskInfo,
        aria2c: hasAria2c
    });
});

// STEP 1-->  Fast Metadata Fetch
app.post('/api/video-metadata', async (req, res) => {
    try {
        let { url } = req.body;
        if (!url) return res.status(400).json({ error: 'URL is required' });

        url = cleanYouTubeUrl(url);
        console.log('Fetching metadata for:', url);

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

        console.log(' Got metadata for:', info.title);

        res.json({
            title: info.title,
            thumbnail: info.thumbnail,
            duration: info.duration,
            author: info.uploader || info.channel,
            viewCount: info.view_count,
            isLive: info.is_live
        });
    } catch (error) {
        console.error('Metadata error:', error.message);

        const msg = error.message || '';

        if (msg.includes('Sign in') || msg.includes('cookies') || msg.includes('confirm your age')) {
            return res.status(403).json({ error: 'Age-restricted or private video. Server cookies may be expired.' });
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

// STEP 2 -->  Get Formats
app.post('/api/video-formats', async (req, res) => {
    try {
        let { url } = req.body;
        if (!url) return res.status(400).json({ error: 'URL is required' });

        url = cleanYouTubeUrl(url);
        console.log('Fetching formats for:', url);

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
        const seenQualities = new Set();

        if (info.formats) {
            const videoFormats = info.formats
                .filter(f => f.vcodec !== 'none' && f.height && f.protocol !== 'm3u8_native' && f.protocol !== 'm3u8')
                .sort((a, b) => (b.height || 0) - (a.height || 0));

            formats.push({
                formatId: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
                quality: 'Best Quality',
                container: 'mp4',
                hasVideo: true,
                hasAudio: true,
                filesize: null,
                type: 'video',
                fps: null,
                vcodec: 'auto',
                acodec: 'auto',
                isQualitySelector: true
            });
            seenQualities.add('Best Quality');

            for (const f of videoFormats) {
                const quality = `${f.height}p`;
                if (!seenQualities.has(quality) && seenQualities.size < 6) {
                    seenQualities.add(quality);
                    const formatSelector = `bestvideo[height<=${f.height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${f.height}]+bestaudio/best[height<=${f.height}]`;
                    formats.push({
                        formatId: formatSelector,
                        quality: quality,
                        container: 'mp4',
                        hasVideo: true,
                        hasAudio: f.acodec !== 'none',
                        filesize: f.filesize || f.filesize_approx,
                        type: 'video',
                        fps: f.fps,
                        vcodec: f.vcodec,
                        acodec: f.acodec,
                        isQualitySelector: true
                    });
                }
            }

            const audioFormats = info.formats
                .filter(f => {
                    const hasAudio = f.acodec && f.acodec !== 'none';
                    const hasNoVideo = !f.vcodec || f.vcodec === 'none' || !f.height;
                    return hasAudio && hasNoVideo;
                })
                .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));

            console.log(`Found ${audioFormats.length} audio-only formats`);

            const seenAudio = new Set();
            for (const f of audioFormats) {
                const bitrate = f.abr || f.tbr || 0;
                const quality = bitrate ? `${Math.round(bitrate)}kbps` : 'audio';
                if (!seenAudio.has(quality) && seenAudio.size < 5) {
                    seenAudio.add(quality);
                    formats.push({
                        formatId: f.format_id,
                        quality: quality,
                        container: f.ext,
                        hasVideo: false,
                        hasAudio: true,
                        filesize: f.filesize || f.filesize_approx,
                        type: 'audio',
                        abr: f.abr || f.tbr,
                        acodec: f.acodec
                    });
                }
            }
        }

        console.log(` Found ${formats.length} formats`);

        res.json({
            formats,
            bestAudioFormat: formats.find(f => !f.hasVideo && f.hasAudio)?.formatId
        });
    } catch (error) {
        console.error('Formats error:', error.message);
        res.status(500).json({ error: 'Failed to fetch formats' });
    }
});

// Legacy endpoint for compatibility
app.post('/api/video-info', async (req, res) => {
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
        const seenQualities = new Set();

        if (info.formats) {
            const videoFormats = info.formats
                .filter(f => f.vcodec !== 'none' && f.height && f.protocol !== 'm3u8_native' && f.protocol !== 'm3u8')
                .sort((a, b) => (b.height || 0) - (a.height || 0));

            formats.push({
                formatId: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
                itag: 'best',
                quality: 'Best Quality',
                container: 'mp4',
                hasVideo: true,
                hasAudio: true,
                filesize: null,
                type: 'video',
                isQualitySelector: true
            });
            seenQualities.add('Best Quality');

            for (const f of videoFormats) {
                const quality = `${f.height}p`;
                if (!seenQualities.has(quality) && seenQualities.size < 6) {
                    seenQualities.add(quality);
                    const formatSelector = `bestvideo[height<=${f.height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${f.height}]+bestaudio/best[height<=${f.height}]`;
                    formats.push({
                        formatId: formatSelector,
                        itag: formatSelector,
                        quality: quality,
                        container: 'mp4',
                        hasVideo: true,
                        hasAudio: f.acodec !== 'none',
                        filesize: f.filesize || f.filesize_approx,
                        type: 'video',
                        isQualitySelector: true
                    });
                }
            }

            const audioFormats = info.formats
                .filter(f => {
                    const hasAudio = f.acodec && f.acodec !== 'none';
                    const hasNoVideo = !f.vcodec || f.vcodec === 'none' || !f.height;
                    return hasAudio && hasNoVideo;
                })
                .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));

            const seenAudio = new Set();
            for (const f of audioFormats) {
                const bitrate = f.abr || f.tbr || 0;
                const quality = bitrate ? `${Math.round(bitrate)}kbps` : 'audio';
                if (!seenAudio.has(quality) && seenAudio.size < 5) {
                    seenAudio.add(quality);
                    formats.push({
                        formatId: f.format_id,
                        itag: f.format_id,
                        quality: quality,
                        audioQuality: quality,
                        container: f.ext,
                        hasVideo: false,
                        hasAudio: true,
                        filesize: f.filesize || f.filesize_approx,
                        type: 'audio',
                        audioBitrate: f.abr || f.tbr
                    });
                }
            }
        }

        res.json({
            title: info.title,
            thumbnail: info.thumbnail,
            duration: info.duration,
            author: info.uploader || info.channel,
            viewCount: info.view_count,
            formats,
            bestAudioItag: formats.find(f => !f.hasVideo)?.formatId
        });
    } catch (error) {
        console.error('Video info error:', error.message);
        res.status(500).json({ error: 'Failed to fetch video info' });
    }
});

// SSE endpoint for download progress
app.get('/api/download-progress/:downloadId', (req, res) => {
    const { downloadId } = req.params;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

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

const sendProgress = (downloadId, data) => {
    const res = activeDownloads.get(downloadId);
    if (res) {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
};

// Start download with yt-dlp
app.post('/api/download-start', async (req, res) => {
    try {
        let { url, itag, formatId, convertToMp3, mp3Bitrate, mergeAudio, estimatedSize } = req.body;
        const downloadId = uuidv4();
        const format = formatId || itag;

        if (!url || !format) {
            return res.status(400).json({ error: 'URL and format are required' });
        }

        url = cleanYouTubeUrl(url);

        const diskInfo = await checkDiskSpace(estimatedSize || 500 * 1024 * 1024);
        if (!diskInfo.sufficient) {
            return res.status(507).json({
                error: 'Insufficient disk space',
                message: diskInfo.message,
                freeGB: diskInfo.freeGB
            });
        }

        const freshCookieStatus = checkCookieHealth();
        if (!freshCookieStatus.valid) {
            console.warn(' Cookie warning:', freshCookieStatus.message);
        }

        res.json({ downloadId, status: 'started', diskSpace: diskInfo });

        await new Promise((resolve) => {
            if (activeDownloads.has(downloadId)) {
                resolve();
                return;
            }
            const timeout = setTimeout(() => {
                downloadReadyCallbacks.delete(downloadId);
                resolve();
            }, 5000);

            downloadReadyCallbacks.set(downloadId, () => {
                clearTimeout(timeout);
                resolve();
            });
        });

        await new Promise(r => setTimeout(r, 100));

        processDownload(downloadId, url, format, convertToMp3, mp3Bitrate, mergeAudio);

    } catch (error) {
        console.error('Download start error:', error);
        res.status(500).json({ error: 'Failed to start download' });
    }
});

async function processDownload(downloadId, url, format, convertToMp3, mp3Bitrate = 192, mergeAudio = false) {
    try {
        sendProgress(downloadId, { status: 'downloading', progress: 0, stage: 'Preparing download...' });

        const infoOptions = {
            dumpSingleJson: true,
            noWarnings: true,
            noPlaylist: true,
            playlistItems: '1'
        };
        if (hasCookies) infoOptions.cookies = cookiesPath;

        const info = await ytDlp(url, infoOptions);
        const title = info.title.replace(/[^\w\s-]/gi, '').replace(/\s+/g, '_').substring(0, 100);

        let outputFilename;
        let outputPath;

        const selectedFormat = info.formats.find(f => f.format_id === format);
        const isAudioOnly = selectedFormat && selectedFormat.vcodec === 'none';
        const isVideoOnly = selectedFormat && selectedFormat.acodec === 'none';

        if (convertToMp3 && isAudioOnly) {
            outputFilename = `${title}.mp3`;
            outputPath = path.join(DOWNLOADS_DIR, `${downloadId}_${outputFilename}`);
            await downloadWithYtDlp(downloadId, url, format, outputPath, 'mp3', mp3Bitrate);
        } else if (mergeAudio && isVideoOnly) {
            outputFilename = `${title}.mp4`;
            outputPath = path.join(DOWNLOADS_DIR, `${downloadId}_${outputFilename}`);
            await downloadParallelMerge(downloadId, url, format, outputPath, info);
        } else {
            const ext = selectedFormat?.ext || 'mp4';
            outputFilename = `${title}.${ext}`;
            outputPath = path.join(DOWNLOADS_DIR, `${downloadId}_${outputFilename}`);
            await downloadWithYtDlp(downloadId, url, format, outputPath);
        }

        sendProgress(downloadId, {
            status: 'completed',
            filename: outputFilename,
            downloadId: downloadId
        });

    } catch (error) {
        console.error('Download processing error:', error);
        sendProgress(downloadId, { status: 'error', message: error.message || 'Download failed' });
    }
}

// downloadParallelMerge function

async function downloadParallelMerge(downloadId, url, videoFormat, outputPath, info) {
    return new Promise(async (resolve, reject) => {
        const ytDlpExec = require('yt-dlp-exec');

        const audioFormats = info.formats
            .filter(f => f.vcodec === 'none' && f.acodec !== 'none')
            .sort((a, b) => (b.abr || 0) - (a.abr || 0));

        const bestAudio = audioFormats[0];
        if (!bestAudio) {
            return downloadWithYtDlp(downloadId, url, `${videoFormat}+bestaudio`, outputPath, 'mp4')
                .then(resolve).catch(reject);
        }

        const videoPath = path.join(DOWNLOADS_DIR, `${downloadId}_video_temp.mp4`);
        const audioPath = path.join(DOWNLOADS_DIR, `${downloadId}_audio_temp.m4a`);

        console.log(` Starting PARALLEL download: Video(${videoFormat}) + Audio(${bestAudio.format_id})`);
        sendProgress(downloadId, { status: 'downloading', progress: 5, stage: ' Parallel download starting...' });

        const baseOptions = {
            noWarnings: true,
            noCheckCertificates: true,
            noPlaylist: true,
        };

        if (hasCookies) baseOptions.cookies = cookiesPath;

        const isYouTubeUrl = url.includes('youtube.com') || url.includes('youtu.be');
        if (hasAria2c && !isYouTubeUrl) {
            baseOptions.externalDownloader = aria2cPath;
            baseOptions.externalDownloaderArgs = '-x 16 -s 16 -k 1M --file-allocation=none';
            console.log(' Using aria2c with 16 connections for faster download');
        } else if (isYouTubeUrl) {
            console.log(' YouTube detected - using native yt-dlp downloader for parallel merge');
        }

        let videoProgress = 0;
        let audioProgress = 0;
        let videoComplete = false;
        let audioComplete = false;

        const updateCombinedProgress = () => {
            const combined = Math.round((videoProgress * 0.7) + (audioProgress * 0.2));
            sendProgress(downloadId, {
                status: 'downloading',
                progress: Math.min(combined, 90),
                stage: ` Parallel: Video ${Math.round(videoProgress)}% | Audio ${Math.round(audioProgress)}%`
            });
        };

        const videoProgressInterval = setInterval(() => {
            if (!videoComplete) {
                videoProgress = Math.min(videoProgress + Math.random() * 10, 95);
                updateCombinedProgress();
            }
        }, 600);

        const audioProgressInterval = setInterval(() => {
            if (!audioComplete) {
                audioProgress = Math.min(audioProgress + Math.random() * 15, 95);
                updateCombinedProgress();
            }
        }, 500);

        try {
            const videoPromise = ytDlpExec.exec(url, {
                ...baseOptions,
                format: videoFormat,
                output: videoPath,
            }).then(() => {
                videoComplete = true;
                videoProgress = 100;
                console.log(' Video download complete');
            });

            const audioPromise = ytDlpExec.exec(url, {
                ...baseOptions,
                format: bestAudio.format_id,
                output: audioPath,
            }).then(() => {
                audioComplete = true;
                audioProgress = 100;
                console.log(' Audio download complete');
            });

            await Promise.all([videoPromise, audioPromise]);

            clearInterval(videoProgressInterval);
            clearInterval(audioProgressInterval);

            sendProgress(downloadId, { status: 'processing', progress: 92, stage: ' Merging video + audio...' });

            await new Promise((mergeResolve, mergeReject) => {
                ffmpeg()
                    .input(videoPath)
                    .input(audioPath)
                    .outputOptions([
                        '-c:v copy',
                        '-c:a aac',
                        '-b:a 192k',
                        '-movflags +faststart',
                        '-y'
                    ])
                    .output(outputPath)
                    .on('progress', (progress) => {
                        const mergeProgress = 92 + (progress.percent || 0) * 0.08;
                        sendProgress(downloadId, {
                            status: 'processing',
                            progress: Math.round(mergeProgress),
                            stage: 'Merging...'
                        });
                    })
                    .on('end', () => {
                        console.log(' FFmpeg merge complete');
                        try {
                            if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
                            if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
                        } catch (e) { console.error('Cleanup error:', e); }
                        mergeResolve();
                    })
                    .on('error', (err) => {
                        console.error('FFmpeg merge error:', err);
                        try {
                            if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
                            if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
                        } catch (e) { }
                        mergeReject(err);
                    })
                    .run();
            });

            resolve();

        } catch (error) {
            clearInterval(videoProgressInterval);
            clearInterval(audioProgressInterval);

            try {
                if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
                if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
            } catch (e) { }

            reject(error);
        }
    });
}

function downloadWithYtDlp(downloadId, url, format, outputPath, audioFormat = null, audioBitrate = null) {
    return new Promise((resolve, reject) => {
        const ytDlpExec = require('yt-dlp-exec');

        const options = {
            format: format,
            output: outputPath,
            noWarnings: true,
            noCheckCertificates: true,
            noPlaylist: true,
            ffmpegLocation: ffmpegStatic,
        };

        if (hasCookies) {
            options.cookies = cookiesPath;
        }

        const isYouTubeUrl = url.includes('youtube.com') || url.includes('youtu.be');
        if (hasAria2c && !audioFormat && !isYouTubeUrl) {
            options.externalDownloader = aria2cPath;
            options.externalDownloaderArgs = '-x 16 -s 16 -k 1M --file-allocation=none';
            console.log(' Using aria2c with 16 connections');
        } else if (isYouTubeUrl) {
            console.log(' YouTube detected - using native yt-dlp downloader (more stable)');
        }

        if (audioFormat === 'mp3') {
            options.extractAudio = true;
            options.audioFormat = 'mp3';
            if (audioBitrate) {
                options.audioQuality = `${audioBitrate}K`;
            }
        }

        if (format.includes('+')) {
            options.mergeOutputFormat = 'mp4';
        }

        console.log('Running yt-dlp download with options:', JSON.stringify(options, null, 2));

        let fakeProgress = 5;
        const stage = hasAria2c ? '⚡ Multi-threaded download...' : 'Downloading...';
        sendProgress(downloadId, { status: 'downloading', progress: 5, stage });

        const progressInterval = setInterval(() => {
            fakeProgress += Math.random() * 5;
            if (fakeProgress >= 90) {
                fakeProgress = 90;
            }
            sendProgress(downloadId, {
                status: 'downloading',
                progress: Math.round(fakeProgress),
                stage: `${stage} ${Math.round(fakeProgress)}%`
            });
        }, 1000);

        const downloadTimeout = setTimeout(() => {
            clearInterval(progressInterval);
            console.error('Download timeout after 5 minutes');
            reject(new Error('Download timeout - please try again'));
        }, 5 * 60 * 1000);

        ytDlpExec.exec(url, options)
            .then(() => {
                clearTimeout(downloadTimeout);
                clearInterval(progressInterval);
                console.log(' Download completed successfully');
                sendProgress(downloadId, { status: 'processing', progress: 100, stage: 'Finalizing...' });
                resolve();
            })
            .catch((err) => {
                clearTimeout(downloadTimeout);
                clearInterval(progressInterval);
                console.error('yt-dlp error:', err.message || err);
                reject(err);
            });
    });
}

// Helper: Detect platform from URL
const detectPlatform = (url) => {
    if (!url) return 'unknown';

    const youtubePatterns = [/youtube\.com/i, /youtu\.be/i, /youtube-nocookie\.com/i];
    const facebookPatterns = [/facebook\.com/i, /fb\.watch/i, /fb\.com/i];
    const instagramPatterns = [/instagram\.com/i, /instagr\.am/i];
    const twitterPatterns = [/twitter\.com/i, /x\.com/i, /t\.co/i];

    if (youtubePatterns.some(p => p.test(url))) return 'youtube';
    if (facebookPatterns.some(p => p.test(url))) return 'facebook';
    if (instagramPatterns.some(p => p.test(url))) return 'instagram';
    if (twitterPatterns.some(p => p.test(url))) return 'twitter';

    return 'unknown';
};

app.post('/api/detect-platform', (req, res) => {
    const { url } = req.body;
    const platform = detectPlatform(url);
    res.json({ platform, url });
});

// Get completed download file
app.get('/api/download-file/:downloadId', (req, res) => {
    const { downloadId } = req.params;
    const { filename } = req.query;

    const files = fs.readdirSync(DOWNLOADS_DIR);
    const downloadFile = files.find(f => f.startsWith(downloadId));

    if (!downloadFile) {
        return res.status(404).json({ error: 'File not found' });
    }

    const filePath = path.join(DOWNLOADS_DIR, downloadFile);
    const outputFilename = filename || downloadFile.replace(`${downloadId}_`, '');

    res.setHeader('Content-Disposition', `attachment; filename="${outputFilename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

    fileStream.on('end', () => {
        setTimeout(() => {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }, 5000);
    });
});

// Start server
if (require.main === module) {
    app.listen(PORT, HOST, () => {
        console.log(` Server running on ${HOST}:${PORT}`);
        console.log(` API endpoints available at http://${HOST}:${PORT}/api`);
        console.log(` FFmpeg path: ${ffmpegStatic}`);
    });
}

module.exports = app;
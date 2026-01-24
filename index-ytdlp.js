const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');

// Use yt-dlp for reliable downloads
const ytDlp = require('yt-dlp-exec');

// Set FFmpeg path
ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const PORT = process.env.PORT || 5000;

// Store active downloads for progress tracking
const activeDownloads = new Map();
const downloadReadyCallbacks = new Map();

// Middleware
app.use(cors());
app.use(express.json());

// Create downloads directory if it doesn't exist
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

// Check if cookies file exists
const cookiesPath = path.join(__dirname, 'cookies.txt');
const hasCookies = fs.existsSync(cookiesPath);
if (hasCookies) {
    console.log(' Found cookies.txt - will use for authentication');
} else {
    console.log(' No cookies.txt found - some videos may be restricted');
}

// Cleanup old files (files older than 1 hour)
const cleanupOldFiles = () => {
    try {
        const files = fs.readdirSync(downloadsDir);
        const now = Date.now();
        files.forEach(file => {
            const filePath = path.join(downloadsDir, file);
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > 3600000) {
                fs.unlinkSync(filePath);
            }
        });
    } catch (error) {
        console.error('Cleanup error:', error);
    }
};
setInterval(cleanupOldFiles, 1800000);

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'Server is running!', ffmpeg: !!ffmpegStatic, hasCookies });
});

// STEP 1: Fast Metadata Fetch
app.post('/api/video-metadata', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'URL is required' });

        console.log('Fetching metadata for:', url);
        
        const options = {
            dumpSingleJson: true,
            noCheckCertificates: true,
            noWarnings: true,
            skipDownload: true,
            flatPlaylist: true,
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
        res.status(500).json({ error: 'Failed to fetch video metadata' });
    }
});

// STEP 2: Get Formats
app.post('/api/video-formats', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'URL is required' });

        console.log('Fetching formats for:', url);

        const options = {
            dumpSingleJson: true,
            noCheckCertificates: true,
            noWarnings: true,
            skipDownload: true,
        };
        
        if (hasCookies) options.cookies = cookiesPath;

        const info = await ytDlp(url, options);

        // Filter and format the formats
        const formats = [];
        const seenQualities = new Set();

        // Process formats - video
        if (info.formats) {
            // Get video formats
            const videoFormats = info.formats
                .filter(f => f.vcodec !== 'none' && f.height)
                .sort((a, b) => (b.height || 0) - (a.height || 0));

            for (const f of videoFormats) {
                const quality = `${f.height}p`;
                if (!seenQualities.has(quality) && seenQualities.size < 5) {
                    seenQualities.add(quality);
                    formats.push({
                        formatId: f.format_id,
                        quality: quality,
                        container: f.ext,
                        hasVideo: true,
                        hasAudio: f.acodec !== 'none',
                        filesize: f.filesize || f.filesize_approx,
                        type: 'video',
                        fps: f.fps,
                        vcodec: f.vcodec,
                        acodec: f.acodec
                    });
                }
            }

            // Get audio formats
            const audioFormats = info.formats
                .filter(f => f.vcodec === 'none' && f.acodec !== 'none')
                .sort((a, b) => (b.abr || 0) - (a.abr || 0));

            const seenAudio = new Set();
            for (const f of audioFormats) {
                const quality = f.abr ? `${Math.round(f.abr)}kbps` : 'audio';
                if (!seenAudio.has(quality) && seenAudio.size < 3) {
                    seenAudio.add(quality);
                    formats.push({
                        formatId: f.format_id,
                        quality: quality,
                        container: f.ext,
                        hasVideo: false,
                        hasAudio: true,
                        filesize: f.filesize || f.filesize_approx,
                        type: 'audio',
                        abr: f.abr,
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
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'URL is required' });

        const options = {
            dumpSingleJson: true,
            noCheckCertificates: true,
            noWarnings: true,
            skipDownload: true,
        };
        
        if (hasCookies) options.cookies = cookiesPath;

        const info = await ytDlp(url, options);

        // Filter formats
        const formats = [];
        const seenQualities = new Set();

        if (info.formats) {
            const videoFormats = info.formats
                .filter(f => f.vcodec !== 'none' && f.height)
                .sort((a, b) => (b.height || 0) - (a.height || 0));

            for (const f of videoFormats) {
                const quality = `${f.height}p`;
                if (!seenQualities.has(quality) && seenQualities.size < 5) {
                    seenQualities.add(quality);
                    formats.push({
                        formatId: f.format_id,
                        itag: f.format_id, // compatibility
                        quality: quality,
                        container: f.ext,
                        hasVideo: true,
                        hasAudio: f.acodec !== 'none',
                        filesize: f.filesize || f.filesize_approx,
                        type: 'video',
                    });
                }
            }

            const audioFormats = info.formats
                .filter(f => f.vcodec === 'none' && f.acodec !== 'none')
                .sort((a, b) => (b.abr || 0) - (a.abr || 0));

            const seenAudio = new Set();
            for (const f of audioFormats) {
                const quality = f.abr ? `${Math.round(f.abr)}kbps` : 'audio';
                if (!seenAudio.has(quality) && seenAudio.size < 3) {
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
                        audioBitrate: f.abr
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
        const { url, itag, formatId, convertToMp3, mp3Bitrate, mergeAudio } = req.body;
        const downloadId = uuidv4();
        const format = formatId || itag;

        if (!url || !format) {
            return res.status(400).json({ error: 'URL and format are required' });
        }

        res.json({ downloadId, status: 'started' });

        // Wait for SSE connection
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

        // Process download
        processDownload(downloadId, url, format, convertToMp3, mp3Bitrate, mergeAudio);

    } catch (error) {
        console.error('Download start error:', error);
        res.status(500).json({ error: 'Failed to start download' });
    }
});

async function processDownload(downloadId, url, format, convertToMp3, mp3Bitrate = 192, mergeAudio = false) {
    try {
        sendProgress(downloadId, { status: 'downloading', progress: 0, stage: 'Preparing download...' });

        // Get video info first
        const infoOptions = { dumpSingleJson: true, noWarnings: true };
        if (hasCookies) infoOptions.cookies = cookiesPath;
        
        const info = await ytDlp(url, infoOptions);
        const title = info.title.replace(/[^\w\s-]/gi, '').replace(/\s+/g, '_').substring(0, 100);
        
        // Determine output file
        let outputFilename;
        let outputPath;
        
        // Check if format is video or audio
        const selectedFormat = info.formats.find(f => f.format_id === format);
        const isAudioOnly = selectedFormat && selectedFormat.vcodec === 'none';
        const isVideoOnly = selectedFormat && selectedFormat.acodec === 'none';

        if (convertToMp3 && isAudioOnly) {
            outputFilename = `${title}.mp3`;
            outputPath = path.join(downloadsDir, `${downloadId}_${outputFilename}`);
            await downloadWithYtDlp(downloadId, url, format, outputPath, 'mp3', mp3Bitrate);
        } else if (mergeAudio && isVideoOnly) {
            outputFilename = `${title}.mp4`;
            outputPath = path.join(downloadsDir, `${downloadId}_${outputFilename}`);
            await downloadWithYtDlp(downloadId, url, `${format}+bestaudio`, outputPath, 'mp4');
        } else {
            const ext = selectedFormat?.ext || 'mp4';
            outputFilename = `${title}.${ext}`;
            outputPath = path.join(downloadsDir, `${downloadId}_${outputFilename}`);
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

function downloadWithYtDlp(downloadId, url, format, outputPath, audioFormat = null, audioBitrate = null) {
    return new Promise((resolve, reject) => {
        const args = [
            '-f', format,
            '-o', outputPath,
            '--no-warnings',
            '--no-check-certificates',
            '--progress',
            '--newline',
            url
        ];

        if (hasCookies) {
            args.unshift('--cookies', cookiesPath);
        }

        if (audioFormat === 'mp3') {
            args.unshift('-x', '--audio-format', 'mp3');
            if (audioBitrate) {
                args.unshift('--audio-quality', `${audioBitrate}K`);
            }
        }

        if (format.includes('+')) {
            args.unshift('--merge-output-format', 'mp4');
        }

        args.unshift('--ffmpeg-location', ffmpegStatic);

        console.log('Running yt-dlp download...');

        // Use yt-dlp-exec's built-in binary
        const ytDlpPath = require('yt-dlp-exec').path;
        const proc = spawn(ytDlpPath, args, {
            windowsHide: true
        });

        let lastProgress = 0;

        proc.stdout.on('data', (data) => {
            const output = data.toString();
            
            // Parse progress
            const progressMatch = output.match(/(\d+\.?\d*)%/);
            if (progressMatch) {
                const progress = Math.round(parseFloat(progressMatch[1]));
                if (progress !== lastProgress) {
                    lastProgress = progress;
                    sendProgress(downloadId, { 
                        status: 'downloading', 
                        progress, 
                        stage: `Downloading... ${progress}%` 
                    });
                }
            }

            // Check for merging stage
            if (output.includes('Merging') || output.includes('merging')) {
                sendProgress(downloadId, { 
                    status: 'processing', 
                    progress: 95, 
                    stage: 'Merging video & audio...' 
                });
            }
        });

        proc.stderr.on('data', (data) => {
            const output = data.toString();
            // yt-dlp sends progress to stderr too
            const progressMatch = output.match(/(\d+\.?\d*)%/);
            if (progressMatch) {
                const progress = Math.round(parseFloat(progressMatch[1]));
                if (progress !== lastProgress) {
                    lastProgress = progress;
                    sendProgress(downloadId, { 
                        status: 'downloading', 
                        progress, 
                        stage: `Downloading... ${progress}%` 
                    });
                }
            }
        });

        proc.on('close', (code) => {
            if (code === 0) {
                sendProgress(downloadId, { status: 'processing', progress: 100, stage: 'Finalizing...' });
                resolve();
            } else {
                reject(new Error(`Download failed with code ${code}`));
            }
        });

        proc.on('error', (err) => {
            reject(err);
        });
    });
}

// Get completed download file
app.get('/api/download-file/:downloadId', (req, res) => {
    const { downloadId } = req.params;
    const { filename } = req.query;

    const files = fs.readdirSync(downloadsDir);
    const downloadFile = files.find(f => f.startsWith(downloadId));

    if (!downloadFile) {
        return res.status(404).json({ error: 'File not found' });
    }

    const filePath = path.join(downloadsDir, downloadFile);
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
app.listen(PORT, () => {
    console.log(` Server running on port ${PORT}`);
    console.log(` API endpoints available at http://localhost:${PORT}/api`);
    console.log(` FFmpeg path: ${ffmpegStatic}`);
});

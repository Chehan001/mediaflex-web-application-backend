const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const { v4: uuidv4 } = require('uuid');

// Set FFmpeg path
ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const PORT = process.env.PORT || 5000;

// COOKIE-BASED AUTH: Load cookies from file if exists
let ytdlAgent;
const cookiesPath = path.join(__dirname, 'cookies.json');

if (fs.existsSync(cookiesPath)) {
    try {
        const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
        ytdlAgent = ytdl.createAgent(cookies);
        console.log(' Loaded YouTube cookies from cookies.json');
    } catch (err) {
        console.error(' Failed to load cookies:', err.message);
        ytdlAgent = ytdl.createAgent();
    }
} else {
    console.log(' No cookies.json found - downloads may fail with 403 error');
    console.log(' To fix: Export YouTube cookies and save as server/cookies.json');
    ytdlAgent = ytdl.createAgent();
}

// Common ytdl options with agent
const getYtdlOptions = (format) => ({
    format,
    agent: ytdlAgent,
    highWaterMark: 1024 * 1024 * 16,
    dlChunkSize: 1024 * 1024 * 10,
});

// Store active downloads for progress tracking
const activeDownloads = new Map();
const downloadReadyCallbacks = new Map(); // Wait for SSE connection

// Middleware
app.use(cors());
app.use(express.json());

// Create downloads directory if it doesn't exist
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

// Cleanup old files (files older than 1 hour)
const cleanupOldFiles = () => {
    try {
        const files = fs.readdirSync(downloadsDir);
        const now = Date.now();
        files.forEach(file => {
            const filePath = path.join(downloadsDir, file);
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > 3600000) { // 1 hour
                fs.unlinkSync(filePath);
            }
        });
    } catch (error) {
        console.error('Cleanup error:', error);
    }
};

// Run cleanup every 30 minutes
setInterval(cleanupOldFiles, 1800000);

// Routes

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'Server is running!', ffmpeg: !!ffmpegStatic });
});

// OPTIMIZATION: Aggressive format filtering utility
const filterFormats = (formats) => {
    // Remove duplicates and keep only the best for each quality
    const videoFormats = new Map();
    const audioFormats = new Map();

    formats.forEach(format => {
        if (!format.contentLength) return; // Skip formats without size
        if (!format.qualityLabel && !format.audioQuality) return; // Skip without quality

        if (format.hasVideo) {
            const quality = format.qualityLabel;
            const existing = videoFormats.get(quality);
            
            // Keep the format with highest bitrate or filesize
            if (!existing || (format.contentLength > existing.filesize)) {
                videoFormats.set(quality, {
                    itag: format.itag,
                    quality: format.qualityLabel,
                    container: format.container,
                    hasVideo: format.hasVideo,
                    hasAudio: format.hasAudio,
                    filesize: format.contentLength,
                    type: 'video',
                    audioQuality: format.audioQuality,
                    audioBitrate: format.audioBitrate,
                    fps: format.fps,
                    videoCodec: format.videoCodec,
                    audioCodec: format.audioCodec
                });
            }
        } else if (format.hasAudio) {
            const quality = format.audioQuality || 'UNKNOWN';
            const existing = audioFormats.get(quality);
            
            // Keep the format with highest bitrate
            if (!existing || (format.audioBitrate > existing.audioBitrate)) {
                audioFormats.set(quality, {
                    itag: format.itag,
                    quality: format.audioQuality,
                    container: format.container,
                    hasVideo: false,
                    hasAudio: true,
                    filesize: format.contentLength,
                    type: 'audio',
                    audioQuality: format.audioQuality,
                    audioBitrate: format.audioBitrate,
                    fps: format.fps,
                    videoCodec: format.videoCodec,
                    audioCodec: format.audioCodec
                });
            }
        }
    });

    // Sort video formats by quality (descending)
    const qualityOrder = { '4320p': 6, '2160p': 5, '1440p': 4, '1080p': 3, '720p': 2, '480p': 1, '360p': 0 };
    const sortedVideos = Array.from(videoFormats.values())
        .sort((a, b) => (qualityOrder[b.quality] || 0) - (qualityOrder[a.quality] || 0))
        .slice(0, 5); // Keep top 5 video formats

    // Sort audio formats by bitrate (descending)
    const sortedAudio = Array.from(audioFormats.values())
        .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))
        .slice(0, 3); // Keep top 3 audio formats

    return [...sortedVideos, ...sortedAudio];
};

// STEP 1: Fast Metadata Fetch (2-4 seconds)
app.post('/api/video-metadata', async (req, res) => {
    try {
        const { url } = req.body;
        console.log('Received metadata request for URL:', url);

        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        // Validate YouTube URL
        if (!ytdl.validateURL(url)) {
            console.log('Invalid YouTube URL:', url);
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }

        console.log('Fetching metadata for:', url);
        // Fetch basic info with minimal processing
        const info = await ytdl.getBasicInfo(url, { agent: ytdlAgent });
        const videoDetails = info.videoDetails;
        console.log('Successfully fetched metadata for:', videoDetails.title);

        const response = {
            title: videoDetails.title,
            thumbnail: videoDetails.thumbnails[videoDetails.thumbnails.length - 1].url,
            duration: videoDetails.lengthSeconds,
            author: videoDetails.author.name,
            viewCount: videoDetails.viewCount,
            isLive: videoDetails.isLiveContent
        };

        res.json(response);
    } catch (error) {
        console.error('Error fetching metadata:', error.message);
        res.status(500).json({ error: 'Failed to fetch video metadata: ' + error.message });
    }
});

// STEP 2: Lazy Format Fetch with Aggressive Filtering
app.post('/api/video-formats', async (req, res) => {
    try {
        const { url } = req.body;
        console.log('Received formats request for URL:', url);

        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        // Validate YouTube URL
        if (!ytdl.validateURL(url)) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }

        console.log('Fetching formats for:', url);
        const info = await ytdl.getInfo(url, { agent: ytdlAgent });
        
        //  Apply aggressive filtering
        const filteredFormats = filterFormats(info.formats);
        console.log(`Filtered ${info.formats.length} formats down to ${filteredFormats.length}`);

        // Find best audio format for merging
        const bestAudio = info.formats
            .filter(f => !f.hasVideo && f.hasAudio)
            .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];

        const response = {
            formats: filteredFormats,
            bestAudioItag: bestAudio?.itag
        };

        res.json(response);
    } catch (error) {
        console.error('Error fetching formats:', error.message);
        res.status(500).json({ error: 'Failed to fetch video formats: ' + error.message });
    }
});

//  Legacy endpoint (kept for backward compatibility)
app.post('/api/video-info', async (req, res) => {
    try {
        const { url } = req.body;
        console.log('Received request for URL:', url);

        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        // Validate YouTube URL
        if (!ytdl.validateURL(url)) {
            console.log('Invalid YouTube URL:', url);
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }

        console.log('Fetching video info for:', url);
        const info = await ytdl.getInfo(url, { agent: ytdlAgent });
        const videoDetails = info.videoDetails;
        console.log('Successfully fetched video info for:', videoDetails.title);

        // Apply aggressive filtering
        const filteredFormats = filterFormats(info.formats);

        // Find best audio format for merging
        const bestAudio = info.formats
            .filter(f => !f.hasVideo && f.hasAudio)
            .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];

        const response = {
            title: videoDetails.title,
            thumbnail: videoDetails.thumbnails[videoDetails.thumbnails.length - 1].url,
            duration: videoDetails.lengthSeconds,
            author: videoDetails.author.name,
            viewCount: videoDetails.viewCount,
            formats: filteredFormats,
            bestAudioItag: bestAudio?.itag
        };

        res.json(response);
    } catch (error) {
        console.error('Error fetching video info:', error.message);
        res.status(500).json({ error: 'Failed to fetch video information: ' + error.message });
    }
});

// SSE endpoint for download progress
app.get('/api/download-progress/:downloadId', (req, res) => {
    const { downloadId } = req.params;
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Send initial connection message
    res.write(`data: ${JSON.stringify({ status: 'connected', downloadId })}\n\n`);

    // Store the response object for sending progress updates
    activeDownloads.set(downloadId, res);
    
    //Signal that SSE is ready - trigger waiting download
    const callback = downloadReadyCallbacks.get(downloadId);
    if (callback) {
        callback();
        downloadReadyCallbacks.delete(downloadId);
    }

    // Handle client disconnect
    req.on('close', () => {
        activeDownloads.delete(downloadId);
        downloadReadyCallbacks.delete(downloadId);
    });
});

// Send progress update to client
const sendProgress = (downloadId, data) => {
    const res = activeDownloads.get(downloadId);
    if (res) {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
};

// Start download with progress tracking
app.post('/api/download-start', async (req, res) => {
    try {
        const { url, itag, convertToMp3, mp3Bitrate, mergeAudio } = req.body;
        const downloadId = uuidv4();

        if (!url || !itag) {
            return res.status(400).json({ error: 'URL and format are required' });
        }

        if (!ytdl.validateURL(url)) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }

        // Return download ID immediately
        res.json({ downloadId, status: 'started' });

        // Wait for SSE connection before starting download (max 5 seconds)
        const waitForSSE = new Promise((resolve) => {
            // If already connected, resolve immediately
            if (activeDownloads.has(downloadId)) {
                resolve();
                return;
            }
            
            // Set timeout - don't wait forever
            const timeout = setTimeout(() => {
                downloadReadyCallbacks.delete(downloadId);
                resolve(); // Start anyway after timeout
            }, 5000);
            
            // Store callback for when SSE connects
            downloadReadyCallbacks.set(downloadId, () => {
                clearTimeout(timeout);
                resolve();
            });
        });

        await waitForSSE;
        
        // Small delay to ensure connection is stable
        await new Promise(r => setTimeout(r, 100));

        // Process download in background
        processDownload(downloadId, url, itag, convertToMp3, mp3Bitrate, mergeAudio);

    } catch (error) {
        console.error('Error starting download:', error);
        res.status(500).json({ error: 'Failed to start download' });
    }
});

// Process download with FFmpeg merging and MP3 conversion
async function processDownload(downloadId, url, itag, convertToMp3, mp3Bitrate = 192, mergeAudio = false) {
    try {
        //Send immediate feedback
        sendProgress(downloadId, { status: 'downloading', progress: 0, stage: 'Preparing download...' });
        
        const info = await ytdl.getInfo(url, { agent: ytdlAgent });
        const title = info.videoDetails.title.replace(/[^\w\s]/gi, '').replace(/\s+/g, '_');
        const selectedFormat = info.formats.find(format => format.itag == itag);

        if (!selectedFormat) {
            sendProgress(downloadId, { status: 'error', message: 'Invalid format' });
            return;
        }

        const isVideoOnly = selectedFormat.hasVideo && !selectedFormat.hasAudio;
        const isAudioFormat = !selectedFormat.hasVideo && selectedFormat.hasAudio;
        const needsMerge = mergeAudio && isVideoOnly;
        const needsMp3Convert = convertToMp3 && isAudioFormat;

        let outputPath;
        let outputFilename;

        if (needsMerge) {
            // Download and merge video + audio
            outputFilename = `${title}_merged.mp4`;
            outputPath = path.join(downloadsDir, `${downloadId}_${outputFilename}`);
            await downloadAndMerge(downloadId, url, itag, info, outputPath, title);
        } else if (needsMp3Convert) {
            // Download and convert to MP3
            outputFilename = `${title}.mp3`;
            outputPath = path.join(downloadsDir, `${downloadId}_${outputFilename}`);
            await downloadAndConvertToMp3(downloadId, url, itag, outputPath, title, mp3Bitrate);
        } else {
            // Simple download with progress
            const extension = selectedFormat.container;
            outputFilename = `${title}.${extension}`;
            outputPath = path.join(downloadsDir, `${downloadId}_${outputFilename}`);
            await downloadSimple(downloadId, url, selectedFormat, outputPath);
        }

        sendProgress(downloadId, { 
            status: 'completed', 
            filename: outputFilename,
            downloadId: downloadId
        });

    } catch (error) {
        console.error('Download processing error:', error);
        sendProgress(downloadId, { status: 'error', message: error.message });
    }
}

// Simple download with progress tracking
async function downloadSimple(downloadId, url, format, outputPath) {
    return new Promise((resolve, reject) => {
        sendProgress(downloadId, { status: 'downloading', progress: 0, stage: 'Downloading...' });

        // Use ytdl agent with proper options
        const stream = ytdl(url, getYtdlOptions(format));
        
        const writeStream = fs.createWriteStream(outputPath);

        let downloadedBytes = 0;
        const totalBytes = parseInt(format.contentLength) || 0;
        let lastProgressUpdate = Date.now();

        stream.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            const now = Date.now();
            
            // Throttle progress updates (every 200ms) to prevent flooding
            if (totalBytes > 0 && (now - lastProgressUpdate > 200)) {
                const progress = Math.round((downloadedBytes / totalBytes) * 100);
                sendProgress(downloadId, { status: 'downloading', progress, stage: 'Downloading...' });
                lastProgressUpdate = now;
            }
        });

        // Add timeout handling
        const timeout = setTimeout(() => {
            stream.destroy(new Error('Download timeout - please try again'));
        }, 5 * 60 * 1000); // 5 minute timeout

        stream.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
        writeStream.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
        writeStream.on('finish', () => {
            clearTimeout(timeout);
            resolve();
        });

        stream.pipe(writeStream);
    });
}

// Download video and audio, then merge with FFmpeg
async function downloadAndMerge(downloadId, url, videoItag, info, outputPath, title) {
    const videoPath = path.join(downloadsDir, `${downloadId}_video_temp.mp4`);
    const audioPath = path.join(downloadsDir, `${downloadId}_audio_temp.mp4`);

    try {
        // Find best audio format
        const bestAudio = info.formats
            .filter(f => !f.hasVideo && f.hasAudio)
            .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];

        const videoFormat = info.formats.find(f => f.itag == videoItag);

        // Download video
        sendProgress(downloadId, { status: 'downloading', progress: 0, stage: 'Downloading video...' });
        await downloadWithProgress(downloadId, url, videoFormat, videoPath, 'Downloading video...', 0, 45);

        // Download audio
        sendProgress(downloadId, { status: 'downloading', progress: 45, stage: 'Downloading audio...' });
        await downloadWithProgress(downloadId, url, bestAudio, audioPath, 'Downloading audio...', 45, 90);

        // Merge with FFmpeg
        sendProgress(downloadId, { status: 'processing', progress: 90, stage: 'Merging video & audio...' });
        await mergeVideoAudio(videoPath, audioPath, outputPath);

        sendProgress(downloadId, { status: 'processing', progress: 100, stage: 'Finalizing...' });

        // Cleanup temp files
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);

    } catch (error) {
        // Cleanup on error
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        throw error;
    }
}

// Download and convert audio to MP3
async function downloadAndConvertToMp3(downloadId, url, itag, outputPath, title, bitrate) {
    const tempPath = path.join(downloadsDir, `${downloadId}_audio_temp.webm`);

    try {
        const info = await ytdl.getInfo(url, { agent: ytdlAgent });
        const audioFormat = info.formats.find(f => f.itag == itag);

        // Download audio
        sendProgress(downloadId, { status: 'downloading', progress: 0, stage: 'Downloading audio...' });
        await downloadWithProgress(downloadId, url, audioFormat, tempPath, 'Downloading audio...', 0, 60);

        // Convert to MP3
        sendProgress(downloadId, { status: 'processing', progress: 60, stage: `Converting to MP3 (${bitrate}kbps)...` });
        await convertToMp3(tempPath, outputPath, bitrate, downloadId);

        sendProgress(downloadId, { status: 'processing', progress: 100, stage: 'Finalizing...' });

        // Cleanup temp file
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);

    } catch (error) {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        throw error;
    }
}

// Download with progress tracking (for specific range)
async function downloadWithProgress(downloadId, url, format, outputPath, stage, startProgress, endProgress) {
    return new Promise((resolve, reject) => {
        // Use ytdl agent with proper options
        const stream = ytdl(url, getYtdlOptions(format));
        const writeStream = fs.createWriteStream(outputPath);

        let downloadedBytes = 0;
        const totalBytes = parseInt(format.contentLength) || 0;
        let lastProgressUpdate = Date.now();

        stream.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            const now = Date.now();
            
            // Throttle progress updates
            if (totalBytes > 0 && (now - lastProgressUpdate > 200)) {
                const downloadProgress = downloadedBytes / totalBytes;
                const progress = Math.round(startProgress + (downloadProgress * (endProgress - startProgress)));
                sendProgress(downloadId, { status: 'downloading', progress, stage });
                lastProgressUpdate = now;
            }
        });

        // Add timeout handling
        const timeout = setTimeout(() => {
            stream.destroy(new Error('Download timeout - please try again'));
        }, 5 * 60 * 1000); // 5 minute timeout

        stream.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
        writeStream.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
        writeStream.on('finish', () => {
            clearTimeout(timeout);
            resolve();
        });

        stream.pipe(writeStream);
    });
}

// Merge video and audio using FFmpeg
function mergeVideoAudio(videoPath, audioPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(videoPath)
            .input(audioPath)
            .outputOptions([
                '-c:v copy',
                '-c:a aac',
                '-b:a 192k',
                '-shortest'
            ])
            .output(outputPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
    });
}

// Convert audio to MP3 using FFmpeg
function convertToMp3(inputPath, outputPath, bitrate, downloadId) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .toFormat('mp3')
            .audioBitrate(bitrate)
            .on('progress', (progress) => {
                if (progress.percent) {
                    const overallProgress = Math.round(60 + (progress.percent * 0.4));
                    sendProgress(downloadId, { 
                        status: 'processing', 
                        progress: overallProgress, 
                        stage: `Converting to MP3 (${bitrate}kbps)...` 
                    });
                }
            })
            .on('end', resolve)
            .on('error', reject)
            .save(outputPath);
    });
}

// Get completed download file
app.get('/api/download-file/:downloadId', (req, res) => {
    const { downloadId } = req.params;
    const { filename } = req.query;

    // Find the file
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

    // Delete file after download
    fileStream.on('end', () => {
        setTimeout(() => {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }, 5000);
    });
});

// Legacy download endpoint (simple, no progress)
app.post('/api/download', async (req, res) => {
    try {
        const { url, itag } = req.body;

        if (!url || !itag) {
            return res.status(400).json({ error: 'URL and format are required' });
        }

        if (!ytdl.validateURL(url)) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }

        const info = await ytdl.getInfo(url, { agent: ytdlAgent });
        const title = info.videoDetails.title.replace(/[^\w\s]/gi, '').replace(/\s+/g, '_');
        const selectedFormat = info.formats.find(format => format.itag == itag);
        
        if (!selectedFormat) {
            return res.status(400).json({ error: 'Invalid format selected' });
        }

        const extension = selectedFormat.container;
        const filename = `${title}.${extension}`;

        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', selectedFormat.mimeType || 'application/octet-stream');

        const stream = ytdl(url, { format: selectedFormat });
        stream.on('error', (error) => {
            console.error('Stream error:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Download failed' });
            }
        });

        stream.pipe(res);

    } catch (error) {
        console.error('Error downloading video:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Download failed' });
        }
    }
});

// Start server
app.listen(PORT, () => {
    console.log(` Server running on port ${PORT}`);
    console.log(` API endpoints available at http://localhost:${PORT}/api`);
    console.log(` FFmpeg path: ${ffmpegStatic}`);
});

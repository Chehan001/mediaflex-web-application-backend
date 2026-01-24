const ytDlp = require('yt-dlp-exec');

async function testVideo() {
    const url = 'https://www.youtube.com/watch?v=Hu4Yvz8tr3E'; // Example video
    console.log('Testing yt-dlp with URL:', url);

    try {
        const output = await ytDlp(url, {
            dumpSingleJson: true,
            noCheckCertificates: true,
            noWarnings: true,
            preferFreeFormats: true,
            noPlaylist: true
        });
        console.log(' Success! Title:', output.title);
    } catch (error) {
        console.error(' Error details:', error);
        if (error.stderr) console.error('STDERR:', error.stderr);
        if (error.stdout) console.log('STDOUT:', error.stdout);
    }
}

testVideo();

const ytDlp = require('yt-dlp-exec');

async function testVideo() {
    // "Me at the zoo" - very unlikely to be blocked/restricted
    const url = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
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
        console.log(' Duration:', output.duration);
    } catch (error) {
        console.error(' FATAL ERROR');
        console.error('Message:', error.message);
        // console.error('Full Error:', JSON.stringify(error, null, 2));
    }
}

testVideo();

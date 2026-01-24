const fs = require('fs');
const path = require('path');

const jsonPath = path.join(__dirname, 'cookies.json');
const txtPath = path.join(__dirname, 'cookies.txt');

if (!fs.existsSync(jsonPath)) {
    console.log(' cookies.json not found!');
    process.exit(1);
}

let rawContent = fs.readFileSync(jsonPath, 'utf8');

// Handle multiple JSON arrays pasted together (common when exporting from multiple sites)
// Find all JSON arrays in the file and merge them
let allCookies = [];

try {
    // First try: parse as single valid JSON
    allCookies = JSON.parse(rawContent);
} catch (e) {
    console.log('  Detected multiple cookie exports, merging...');
    
    // Find all JSON arrays using regex
    const jsonArrayRegex = /\[[\s\S]*?\](?=\s*\[|\s*$)/g;
    const matches = rawContent.match(jsonArrayRegex);
    
    if (matches) {
        for (const match of matches) {
            try {
                const parsed = JSON.parse(match);
                if (Array.isArray(parsed)) {
                    allCookies = allCookies.concat(parsed);
                }
            } catch (parseErr) {
                // Try to fix common issues
                console.log('  Attempting to parse chunk...');
            }
        }
    }
    
    // Alternative: split by ][ pattern
    if (allCookies.length === 0) {
        const fixedContent = '[' + rawContent
            .replace(/^\s*\[/, '')  // Remove leading [
            .replace(/\]\s*$/, '')  // Remove trailing ]
            .replace(/\]\s*\[/g, ',') // Replace ][ with ,
            + ']';
        
        try {
            allCookies = JSON.parse(fixedContent);
        } catch (e2) {
            console.log(' Could not parse cookies.json');
            console.log(' Make sure cookies.json contains valid JSON.');
            console.log(' If you have cookies from multiple sites, paste them one after another.');
            process.exit(1);
        }
    }
}

if (!Array.isArray(allCookies) || allCookies.length === 0) {
    console.log(' No cookies found in cookies.json');
    process.exit(1);
}

// Deduplicate cookies by domain+name (keep the latest)
const cookieMap = new Map();
for (const cookie of allCookies) {
    if (cookie && cookie.name && cookie.domain) {
        const key = `${cookie.domain}|${cookie.name}`;
        cookieMap.set(key, cookie);
    }
}
const cookies = Array.from(cookieMap.values());

// Netscape cookie format header
let output = '# Netscape HTTP Cookie File\n';
output += '# https://curl.haxx.se/docs/http-cookies.html\n';
output += '# This file was generated automatically\n\n';

// Group by domain for logging
const domains = new Set();

for (const cookie of cookies) {
    const domain = cookie.domain.startsWith('.') ? cookie.domain : '.' + cookie.domain;
    const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const path_ = cookie.path || '/';
    const secure = cookie.secure ? 'TRUE' : 'FALSE';
    const expires = Math.floor(cookie.expirationDate || 0);
    const name = cookie.name;
    const value = cookie.value;

    output += `${domain}\t${includeSubdomains}\t${path_}\t${secure}\t${expires}\t${name}\t${value}\n`;
    
    // Track domains
    const baseDomain = domain.replace(/^\./, '');
    if (baseDomain.includes('youtube') || baseDomain.includes('google')) domains.add('YouTube');
    if (baseDomain.includes('facebook') || baseDomain.includes('fb.com')) domains.add('Facebook');
    if (baseDomain.includes('instagram')) domains.add('Instagram');
}

fs.writeFileSync(txtPath, output);
console.log(' Converted cookies.json to cookies.txt');
console.log(` Saved to: ${txtPath}`);
console.log(` Total cookies: ${cookies.length}`);
if (domains.size > 0) {
    console.log(` Platforms: ${Array.from(domains).join(', ')}`);
}

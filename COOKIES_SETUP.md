# 🍪 Fix 403 Error - Cookie Setup Guide

YouTube blocks downloads without proper authentication. Follow these steps to fix it:

## Quick Setup (5 minutes)

### Step 1: Install Browser Extension

Install one of these extensions in Chrome/Edge:

- **EditThisCookie** - [Chrome Web Store](https://chrome.google.com/webstore/detail/editthiscookie/fngmhnnpilhplaeedifhccceomclgfbg)
- **Cookie-Editor** - [Chrome Web Store](https://chrome.google.com/webstore/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm)

### Step 2: Export YouTube Cookies

1. Go to **https://www.youtube.com** in your browser
2. **Log in** to your YouTube/Google account (important!)
3. Click the cookie extension icon
4. Click **"Export"** or **"Export as JSON"**
5. Copy all the text

### Step 3: Save Cookies File

1. Create a new file: `server/cookies.json`
2. Paste the exported cookies
3. Save the file

### Step 4: Restart Server

```bash
cd server
npm start
```

You should see: `✅ Loaded YouTube cookies from cookies.json`

---

## Alternative: Manual Cookie Format

If the extension format doesn't work, use this format:

```json
[
  {
    "name": "VISITOR_INFO1_LIVE",
    "value": "YOUR_VALUE_HERE",
    "domain": ".youtube.com",
    "path": "/",
    "secure": true,
    "httpOnly": true
  },
  {
    "name": "LOGIN_INFO", 
    "value": "YOUR_VALUE_HERE",
    "domain": ".youtube.com",
    "path": "/",
    "secure": true,
    "httpOnly": true
  }
]
```

### Important Cookies to Include:
- `VISITOR_INFO1_LIVE`
- `LOGIN_INFO` 
- `SID`
- `HSID`
- `SSID`
- `APISID`
- `SAPISID`
- `__Secure-1PSID`
- `__Secure-3PSID`

---

## Troubleshooting

### Still getting 403?
1. Make sure you're **logged in** to YouTube
2. Try watching a video first, then re-export cookies
3. Cookies expire - re-export every few weeks

### Server not finding cookies?
- File must be named exactly: `cookies.json`
- File must be in the `server/` folder
- Check for JSON syntax errors

### Need help?
The cookies file should start with `[` and end with `]`

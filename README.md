# TeraPlayer - Universal TeraBox & TeraViralHub Video Player & Downloader

A high-performance, dark-themed web video player and downloader that resolves and streams media manifests directly from public **TeraBox** and **TeraViralHub** links.

## 🚀 Features

- **TeraViralHub Integration:** Directly resolves `teraviralhub.com/video-XXXXX` links into native video streams without needing iTeraPlay or account registration.
- **Universal TeraBox Support:** Supports `terabox.com`, `1024terabox.com`, `teraboxapp.com`, `1024tera.com`, etc.
- **HLS Streaming Engine:** Converts and proxies `.m3u8` playlists and video chunks seamlessly to bypass CORS restrictions.
- **Responsive Dark UI:** Built with Tailwind CSS and Hls.js, optimized for mobile and desktop screens.
- **Multi-File & Folder Support:** Automatically discovers and lists all media files when a folder link is submitted.
- **Ad Slots Ready:** Pre-built slots for 728x90 banners, native ads, and direct links (compatible with Adsterra, Monetag, etc.).

## 🛠️ Tech Stack

- **Backend:** Node.js, Express, Native Fetch
- **Frontend:** HTML5, Tailwind CSS, Hls.js, FontAwesome
- **Deployment Ready:** Cloudflare Pages (Frontend) + Render / Koyeb / VPS (Backend)

## 💻 Local Setup & Running

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Start the server:**
   ```bash
   npm start
   ```

3. **Open in browser:**
   ```
   http://localhost:3000
   ```

## 💰 Monetization / Ads Integration

Open `public/index.html` and look for the ad placeholders:
- `<!-- ADSTERRA / MONETAG 728x90 BANNER CODE GOES HERE -->`
- `<!-- ADSTERRA / MONETAG NATIVE BANNER (300x250) -->`

Paste your ad network scripts directly into these blocks.

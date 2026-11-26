# Premium for Windows

A personal, open-source, ad-free YouTube client for Windows: the desktop version of the Premium iPhone and Android apps. It uses the **Pearl Glass** style (light frosted glass with rainbow focus edges), and Classic, Daylight and Midnight Glass are also available as themes.

## What's in it
- **Home**: greeting, Continue watching, category chips, and a mixed feed from your subscriptions and what you watch. Rest the mouse on a thumbnail to preview it.
- **Search**: suggestions as you type, recent searches, and filters (date, length, Live, Shorts). You can paste any YouTube link to open it.
- **Watch page**: quality up to 4K/8K, chapters, SponsorBlock auto-skip, comments, captions, speed, queue, autoplay with an Up next countdown, theater mode, full screen, mini player, picture in picture, sleep timer, audio-only mode, ambient glow and Stats for nerds.
- **Shorts**: a full-height vertical feed (For you and Subscriptions).
- **Subscriptions**: new uploads from the channels you follow, stored on your PC. You can import them from Google Takeout (`subscriptions.csv`).
- **You**: watch time, History, Watch later, Liked videos and playlists.
- **Channel pages**: Videos, Shorts, Live and About.
- **Cast to Roku**: finds your Roku on the network, plays the video in the TV's YouTube app, and gives you a full remote.
- **Google sign-in**: works like the iPhone app. Sign in once in your browser and Premium imports your subscriptions, playlists and liked videos, then picks up new subscriptions once a day. Access is read-only, and the sign-in is encrypted with Windows data protection.
- **Settings**: 4 themes, evening mode, feed rules (muted words, blocked channels, length limit), SponsorBlock categories, and backup and restore.
- **Windows extras**: media keys, YouTube's keyboard shortcuts (K/J/L, F, T, I, M, C, arrows, 0–9), mouse back/forward buttons, and a title bar that matches the theme.

## Install
Open the **Releases** page, download the newest `Premium-Setup-x.y.z.exe` and run it. The installer lets you choose the install folder (for example `D:\Apps\Premium`). The app isn't code-signed, so Windows SmartScreen may warn you. Click **More info → Run anyway**.

## How it's built
Every push to `main` runs **GitHub Actions** on a cloud Windows machine. It builds the installer with electron-builder and publishes it as a GitHub Release.

- **Electron** for the app (`src/main` is the main process, `src/renderer` is the UI)
- **youtubei.js** for stream URLs. It builds a DASH manifest from YouTube's separate video and audio streams, so every quality up to 8K is available and no stitched-in ads are included.
- **shaka-player** for playback
- YouTube's web API for search, feeds, channels and comments. The parsing is ported from the iPhone app.
- Video segments go through a small `ytv://` proxy in the main process, which sends the headers YouTube expects.

## Run it from source
```
npm install
npm start
```
In development, press F12 for DevTools. `PREMIUM_MOCK=1 npm start` runs the app with fake data and no network.

Your data is stored in `%APPDATA%\Premium\premium-data.json`. The backup format is the same one the iPhone app uses.

Personal use only. Not affiliated with YouTube or Google.

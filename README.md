# 🥔 Tater Talk

A TikFinity-style streaming companion for **TikTok, Twitch, and YouTube**, built by **Jedi Master T8ter**.

Tater Talk listens to your live streams and adds text-to-speech, sound alerts, viewer intros, and on-stream widgets, all in one retro sci-fi themed Windows app.

## Features

- **Connects to TikTok LIVE, Twitch, and YouTube Live** at the same time
- **Text-to-speech**
  - Windows voices plus [Fish Audio](https://fish.audio) voices (including your own cloned voice)
  - Random voice per message, or a random voice each viewer keeps
  - Command mode (like `!tts` or just `!`), so only messages that start with your command get read
  - **Viewer voices**: give specific mods, Super Fans, subs, or members their own TTS voice
  - Choose who can use TTS: everyone, mods, Super Fans / subs / members, or followers
- **Sound alerts**
  - TikTok gifts (any gift, or a sound per gift), follows
  - Twitch follows (with a one-time Twitch login), subs, gifted subs, bits, raids
  - YouTube Super Chats
  - 46 built-in sounds, plus import your own sound folders
- **Viewer intros**: play a sound when a specific viewer joins (TikTok) or first chats (Twitch / YouTube)
- **On-stream widgets** for OBS, Streamlabs, and TikTok LIVE Studio
  - Chat overlay
  - Alert popups with the tater mascot
- **Themes**: Galactic, Dark Side, Rebel, Hologram, Classic, with starfield, CRT scanlines, and pixel font options

## Install

Download the latest **Tater Talk Setup .exe** from the Releases page and run it.
Windows may show "Windows protected your PC" because the app isn't code-signed. Click **More info**, then **Run anyway**.

## Run from source

Requires [Node.js](https://nodejs.org) (LTS).

```
npm install
npm start
```

## Build the installer

```
npm run dist
```

The installer appears in the `dist` folder.

## Notes

- TikTok and YouTube connections use unofficial community libraries ([TikTok-Live-Connector](https://github.com/zerodytrash/TikTok-Live-Connector), [youtube-chat](https://www.npmjs.com/package/youtube-chat)) and may need updates when those sites change.
- Twitch chat is read anonymously with [tmi.js](https://github.com/tmijs/tmi.js). Twitch follow alerts need a Twitch login and a Twitch app Client ID (from dev.twitch.tv, with the redirect URL `http://localhost:4848/twitch-auth`). You must be the streamer or a mod of the channel.
- Tater Talk must be open for the widgets to work.

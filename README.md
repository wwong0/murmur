<h1 align="center">Murmur</h1>

<p align="center">
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript">
  <img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB" alt="React">
  <img src="https://img.shields.io/badge/WebRTC-333333?style=for-the-badge&logo=webrtc&logoColor=white" alt="WebRTC">
</p>

<p align="center"><strong>Watch a video file together, in sync, shared browser to browser instead of uploaded to a server.</strong></p>

<p align="center"><a href="https://murmurwatch.duckdns.org">Try it in your browser</a></p>

<p align="center">
  <img src="images/hero.svg" alt="The Murmur front page: the headline Watch together, the Host a room button, the invite field with Join, and a drawing of a room" width="880" />
</p>

## What it does

Murmur is a watchalong app that keeps everyone in tight sync and shares the video peer to peer:
every screen stays within one frame (16.7 ms) of the others, and with 5 viewers the host uploads
about one copy of the video instead of five.

The video file stays on the host's computer and is never uploaded to a server. The host's browser
streams it to the viewers, and the viewers pass pieces on to each other. One person picks a file and
sends an invite link, and everyone who opens it watches together.

## Results

**With 5 viewers, the host uploads about one copy of the video instead of five.**

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/sharing-dark.svg">
  <img src="images/sharing-light.svg" alt="Copies of the video the host uploaded with 5 viewers: 5.00 without sharing, 1.00 to 1.03 with it." width="720">
</picture>
</p>

**Bigger rooms barely cost the host more: 10 viewers take 1.10–1.11 copies, not 10.**

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/room-size-dark.svg">
  <img src="images/room-size-light.svg" alt="Copies of the video the host uploaded at 2, 3, 5 and 10 viewers: 1.01, 1.00 to 1.01, 0.98 to 1.03 and 1.10 to 1.11, against 2, 3, 5 and 10 with no sharing." width="720">
</picture>
</p>

**Screens stay within one frame of each other.**

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/sync-dark.svg">
  <img src="images/sync-light.svg" alt="The gap between viewers' screens: within one 16.7 ms frame with no trouble, with 5% of data lost and with 25 ms delay; 33 and 43 ms with one viewer 60 ms farther away." width="720">
</picture>
</p>

**The host's upload runs about 30% full, where the sharing library's defaults keep it about 99% full.**

**An hour-long room played through with no freezes.**

## How it works

```
host's file ──► host's browser tab ──► viewer ◄──► viewer ◄──► viewer
                (cuts it into pieces)       (pass pieces on to each other)

room server: keeps clocks and play/pause in step; never sees the video
```

- **Shared clock.** Each browser works out how far its clock is from the room server's.
- **Speed control.** Each viewer nudges its playback speed by at most 1% to stay on the room's position.
- **Paced sharing.** Browsers fetch ahead only as fast as the host's upload allows, so the room stays ahead.
- **One first fetcher per piece.** When everyone needs the same piece at once, one viewer fetches it and the rest take it from them.
- **The host's tab is the source.** The host's browser converts the file into pieces itself, with no re-encode and no server.

Built on `hls.js`, `p2p-media-loader`, WebRTC, `mp4box.js` and React.

## Run it locally

Needs Node 24 and Chrome or another Chromium browser.

```bash
cd app
npm install
npm run dev:file   # serves http://127.0.0.1:8100 with a local tracker
```

Open `http://127.0.0.1:8100`, choose **Host a room**, pick a video file, and open the invite link
in a second window to join as a viewer.

## Run the tests

```bash
cd app
npm install
npm run check   # structural rules and every assertion suite, no browser
```

`npm run check` needs no browser. The measurement rig (Docker, one container per browser) is in
`app/harness/`, and `npm run content` generates the test video it plays (needs ffmpeg, about 2.3 GB).

## Project layout

```
app/                  the product
  server/             room server: rooms, presence, signalling, limits
  public/             the browser app: React screens, and the sync engine in public/lib/
  scripts/            build, dev server, npm run check and its suites, browser drivers, measurement readers
  harness/            the Docker measurement rig
  deploy/             files for the hosted instance (nginx, systemd)
  patches/            the patch carried on p2p-media-loader
  listening/          a small listening test for playback-speed changes (bring your own audio)
  results/            the test summaries the write-up cites, and small inputs the tests read
images/               the pictures on this page
```

## Licence

MIT, © 2026 William Wong. See [`LICENSE`](LICENSE).

## Read more

The full write-up, with every number and the setup it was measured in, the results that missed
their goal, and what the tests do not show, is in [`WRITEUP.md`](WRITEUP.md).

# Murmur

**Watch a video file together, in sync, with the file shared browser to browser instead of
uploaded to a server.**

- **Try it:** <https://murmurwatch.duckdns.org>
- **Results, method and limits:** [`WRITEUP.md`](WRITEUP.md)

## What it does

One person (the host) picks a video file on their own computer and sends an invite link.
Everyone who opens the link watches the same moment of the same file. The host's browser cuts
the file into small streamable pieces, and the viewers pass those pieces on to each other, so the
host does not have to upload a full copy to every viewer.

No server holds, reads or stores the video. The servers only carry the room's state, the
messages that let browsers find each other, and the playlist. The one exception is a relay for
connections that cannot go direct between two browsers; it forwards encrypted bytes it cannot
read.

Synchronized peer-to-peer watching is not a new idea: SyncStream (IEEE, 2010) and
`webtorrent-desktop-multiplayer` came first. What this project adds is a working, measured
implementation, and a direct look at the tension between keeping a room in step and letting its
viewers share. [`WRITEUP.md`](WRITEUP.md) → *Prior art* says what is original and what is
borrowed.

## Performance

Measured in the lab, on one PC: each browser in its own container, uploads limited, downloads
not. The **main setup** is a host uploading at 10 Mbit/s, five viewers each uploading at
10 Mbit/s, no loss or delay, a 2.64 Mbit/s video in 2-second pieces, and a 6-minute run of which
the last 3 minutes are measured. The tests ran on two nights, night 1 (2026-10-26) and night 2
(2026-10-27). Nothing here was measured over the real internet.

- **The host sends about one copy, not one per viewer.** With 5 viewers the host sent 0.98–1.03
  copies of the video, where no sharing means 5. Viewers together got 0.79–0.80 of the video from
  other viewers. Main setup, night 1, 3 tests.
- **Bigger rooms barely cost the host more.** With 10 viewers the host sent 1.10–1.11 copies,
  and the viewers got 0.89 of the video from each other. Main setup, night 1, 3 tests.
- **The host's connection stays free.** Pacing the downloads below the host's uplink kept that
  uplink about 30% full, where the sharing library's defaults kept it about 99% full, while the
  host still sent 0.98–1.03 copies. 10 Mbit/s host, five viewers: the pacing on night 1 (3 tests),
  the defaults on night 2 (2 tests), with only the test harness changed between the two builds.
- **Screens stay within one frame of each other.** The median gap between viewers was under one
  16.7 ms frame in every test, and the 99th-percentile gap was within one frame (16.7–16.8 ms).
  Main setup, night 1, 3 tests, on reconstructed lab time.
- **An hour-long room held up.** Over 57 measured minutes of a 60-minute run, viewers got 0.797 of the video from
  each other, and nobody froze. 1 test.

[`WRITEUP.md`](WRITEUP.md) gives every figure with the setup it was measured in, the ones that
missed their goal, and what the tests do not show.

## How it works

- **Shared clock.** Each browser estimates how far its clock is from the room server's, from
  filtered round trips over the websocket.
- **Speed control.** Each viewer reads which frame is actually on screen and nudges its playback
  speed by at most 1% to stay on the room's position. A gap too large for that is closed by one
  jump.
- **Paced sharing.** The browsers fetch ahead only as fast as the host's upload allows, so the
  room stays ahead and the host's connection stays free for urgent pieces.
- **One first fetcher per piece.** When every viewer needs the same piece at once, one viewer is
  assigned to fetch it from the host and the others take it from that viewer.
- **The host's tab is the source.** The host's browser converts the file into streamable pieces
  with `mp4box.js` (a remux, never a re-encode) and serves them itself.

Built on `hls.js` (playback), `p2p-media-loader` (peer transport), WebRTC, `mp4box.js` and React.

## Run it locally

Needs Node 24 and Chrome or another Chromium browser.

```bash
cd app
npm install
npm run dev:file   # serves http://127.0.0.1:8100 with a local tracker
```

Open `http://127.0.0.1:8100`, choose **Host a room**, pick a video file, and open the invite
link in a second window to join as a viewer.

## Run the tests

```bash
cd app
npm install
npm run check   # structural rules and every assertion suite, no browser
```

`npm run check` runs in a minute or two and needs no browser.

The measurement harness (Docker, one container per browser, `tc` shaping) is described in
[`WRITEUP.md`](WRITEUP.md) → *Reproduce*.

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
  results/            the summaries and charts WRITEUP.md cites, and three small inputs the tests read
WRITEUP.md            what was measured, how, and its limits
```

## Reporting a problem

Open the room's **Stats** panel and press **Download stats**. It saves `murmur-stats.json`: the
panel's readings (clock, sync, bytes, the controller and the start wait) as numbers, with no
names, no room link, no chat and nothing about the file. Attach that file to your issue with a
line on what you saw.

**Privacy.** The hosted instance keeps anonymous running totals only (rooms, visits, the largest
room, hours watched), and nothing that names a room or a person.

## Licence

MIT, © 2026 William Wong. See [`LICENSE`](LICENSE).

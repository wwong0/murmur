# Murmur: a synced peer-to-peer watchalong

A group watches one video file together, in step, and the file travels browser to browser from
the person who has it. The host picks a file on their own computer and sends an invite link; their
browser converts the file into streamable pieces, and the viewers pass pieces on to each other, so
the host does not upload a full copy to every viewer. No server holds, reads or stores the video.
The one exception is a relay for connections that cannot go direct, which forwards encrypted bytes
it cannot read.

- **Try it:** <https://murmurwatch.duckdns.org>
- **What was measured, and what was not:** [`WRITEUP.md`](WRITEUP.md)

## Run it locally

Needs Node 24 and Chrome or another Chromium browser.

```bash
cd app
npm install
npm run check      # the structural rules and every assertion suite, in seconds, no browser
npm run dev:file   # serves http://127.0.0.1:8100 with a local tracker; host a file of your own
```

Open `http://127.0.0.1:8100`, choose "Host a room", pick a video file, and open the invite link
in a second window to join as a viewer.
The measurement harness and how the results were produced are in `WRITEUP.md` → *Reproduce*.

## Reporting a problem

Open the room's **Stats** panel and press **Download stats**. It saves `murmur-stats.json`: the
panel's readings (clock, sync, bytes, the controller and the start wait) as numbers, with no names,
no room link, no chat and nothing about the file. Attach that file to your issue with a line on
what you saw.

**Privacy.** The hosted instance keeps anonymous running totals only (rooms, visits, the largest room, hours
watched), and nothing that names a room or a person.

## Licence

MIT, © 2026 William Wong. See [`LICENSE`](LICENSE).

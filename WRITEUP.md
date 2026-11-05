# Murmur: results

A group watches one video file together, in step, and viewers pass the file on to each other
instead of each downloading it from the person who has it. With 5 viewers, the host uploaded about
one copy of the video instead of five, and the screens stayed within one frame of each other.
This document says what was built, how it was measured, every figure with its setup, and what the
tests do not show. The last section says which file holds each figure.

| Goal | Result, main setup | |
|---|---|---|
| Screens in step | 99th-percentile gap within one 16.7 ms frame, 3 of 3 tests | Met |
| The host uploads little | 0.98–1.03 copies with 5 viewers, 1.10–1.11 with 10 | Met |
| Viewers share | 0.79–0.80 of the video from other viewers with 5 (0.89 with 10) | Met |
| Join and leave | A leaving viewer froze no one, 3 of 3. A late joiner was in step 3.1–3.3 s after joining, against 2 s | Leave met, join missed |

**Words used throughout.**
- The **host** is the person sharing the file.
- **Host copies** is how many full copies of the video the host uploaded for the room, over the
  measured window. With N viewers and no sharing it is N: one copy per viewer.
- **Peer fraction** is the room's figure: the share of all the video bytes the viewers received
  that came from other viewers rather than from the host.
- The **main setup**: host upload 10 Mbit/s, every viewer's upload 10 Mbit/s, downloads not
  limited, no loss or delay, 2-second video pieces of one 2.64 Mbit/s video, 5 viewers, a
  6-minute run of which the last 3 minutes are measured. All on one test PC.

## 1. What it is

One person picks a video file on their own computer and sends an invite link. Everyone who opens
it watches the same moment of the same file, and the viewers pass pieces of the video on to each
other, so the host does not have to upload a full copy to every viewer.

**No server holds, reads or stores the video.** The servers carry descriptions of it: the room's
state, the signalling that lets browsers connect, and the playlist. The host's browser tab is the
source of the video, and it converts the file into streamable pieces in the browser itself. The
one exception: a connection that cannot go direct between two browsers falls back to a relay,
which forwards encrypted bytes it has no key for. It stores nothing and cannot tell that they are
video. Every other connection is direct, browser to browser.

## 2. Prior art, and what is original

This is not a new idea. Synchronized peer-to-peer streaming was published in 2010 (SyncStream,
IEEE). `webtorrent-desktop-multiplayer` and FileParty already do room-based watching over
WebTorrent. Teleparty, Watch2Gether and Discord's Watch Together sync playback but leave delivery
to a streaming service; Syncplay syncs local players but needs every viewer to have the file.
Peer-to-peer delivery itself is WebRTC and `p2p-media-loader`'s work, not this project's.

None of them reports how closely the room stays in step, what it costs the host's upload, or how
keeping a room in step affects sharing. That is what this project measures. Its contribution is a
working, measured implementation and an explicit treatment of that tension.

**Written for this project:** the clock-offset estimation and its filter; the playback-speed
controller that keeps each screen in step; the measurement, from the frame each screen actually
shows, of how far apart the screens are; the replicated play/pause/seek state; the look-ahead
control that paces the host and keeps the room ahead; the assignment of a first fetcher for each
piece at the buffer edge; late-join and leave recovery; the room and application logic; and the
measurement harness.

**Integrated, not written here:** `hls.js` (playback), `p2p-media-loader` (peer transport and
piece exchange), the browser's WebRTC (connections and NAT traversal), `mp4box.js` (the
in-browser conversion), and React.

## 3. The headline

**Sharing keeps the host near one copy.** With 5 viewers the host sent 0.98–1.03 copies, where no
sharing means 5: at most 1.033 copies, which is 20.7% of the 5 that no sharing needs. Viewers
together got 0.79–0.80 of the video from other viewers. Main setup, 3 tests, all meeting the goal.

**A bigger room barely costs the host more.** With 2, 3 and 10 viewers the host sent 1.01,
1.00–1.01 and 1.10–1.11 copies; at most 1.107 copies at 10 viewers, which is 11.1% of the 10 that
no sharing needs. With 10 viewers, they together got 0.89 of the video from other viewers. Main
setup: 2 tests each at 2 and 3 viewers (measured, no goal set) and 3 tests at 10, all within the
10-viewer goal of at most 2 copies.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/room-size-dark.svg">
  <img src="images/room-size-light.svg" alt="Copies of the video the host uploaded at 2, 3, 5 and 10 viewers, about one copy each time, against one copy per viewer without sharing." width="720">
</picture>

*Main setup. 2 tests at 2 and 3 viewers, 3 at 5 and 10. Each column reaches the highest test and
is labelled with the range. The outlined columns are worked out, not measured.*

**The same connection, with and without sharing.** With a 20 Mbit/s host and 5 viewers, the host
sent 1.00 and 1.03 copies with sharing (2 tests, both within the goal of at most 1.5 copies).
Without sharing it sent 5.00 copies (1 test, measured a day later on the same app code; every
viewer played at full speed with no freezes). Two more tests without sharing, run on the same build
as the sharing tests but added after the planned series, read 5.001 and 5.000. A 10 Mbit/s host
cannot play 5 viewers without sharing at all: they played at 0.66–1.00 of real time with 11–43
freezes each (extra tests, outside the planned series). Five viewers need 5 × 2.64 = 13.2 Mbit/s,
which is 132% of that uplink (arithmetic, not a measurement). So there is no 10 Mbit/s comparison,
and none is quoted.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/sharing-dark.svg">
  <img src="images/sharing-light.svg" alt="Copies of the video the host uploaded with a 20 Mbit/s host and 5 viewers: 5.00 without sharing, 1.00 to 1.03 with it." width="720">
</picture>

*20 Mbit/s host, 5 viewers. Without sharing: 1 test. With sharing: 2 tests, a day earlier on the
same app code. The dashed line is one copy.*

**The pacing is what leaves the host's connection free.** This project replaced the sharing
library's default fetch-ahead with a look-ahead control paced below the host's uplink. With the
defaults there is no host-copies figure: when the uplink is full, the count shows the uplink's
limit, not how much the viewers shared.

| 10 Mbit/s host, 5 viewers | Uplink in use | Host copies | Peer fraction | Sync goals | Tests |
|---|---|---|---|---|---|
| This project's pacing | 0.288–0.303 (about 30%) | 0.98–1.03 | 0.79–0.80 | met | 3 |
| The library's defaults | 0.995 and 0.993 (about 99%) | no figure | 0.777 and 0.793 | median and 99th percentile met | 2 |

The defaults ran a day later on the same app code; between those builds only the test harness
changed. The defaults still shared and stayed in step, so the gain is a free connection, not more
sharing.

**Edge assignment helps the room recover after a drop.** The host's connection fell from 10 to
1 Mbit/s for 1.7–2.0 minutes and then came back. In the window after it came back, the viewers froze
2, 0 and 0 times with edge assignment, against 109, 20 and 35 with it switched off (the earlier
rule for pieces near their deadline), on the same build:

| Pair | Freezes with edge assignment | Freezes without |
|---|---|---|
| 1 | 2 | 109 |
| 2 | 0 | 20 |
| 3 | 0 | 35 |

*Freezes summed over 5 viewers. 3 alternating pairs, all valid; 8-minute runs with the last 4
minutes measured.* During the drop itself every viewer, in both versions, went 93–132 s with no new
picture.

**What is not shown.** Two things. First, that edge assignment cuts host copies: a comparison with
it switched off found no difference in 3 usable pairs of 4, and a 10-viewer comparison produced no
usable pair. Second, that the scheduler (the code that sets the fetch-ahead windows, the pace and the
assignment) gains anything in steady play: an earlier comparison against a control design, with a
10 Mbit/s host, 4-second pieces and five and ten viewers, found no gain on any measure.

**The tension the project is about is real at the buffer edge, and absent when the room is
ahead.** A synced room asks for each piece at the same instant, so no viewer holds it first to
share. In an earlier test round, a room at its buffer edge shared almost nothing after a seek: peer
fraction 0.014 and 0.000 (10 Mbit/s host, five viewers, the library's default windows, 4-second
pieces, 2 accepted runs; a first series did not reproduce it within its run limit, and a second
series, whose pass rule was written down before it ran, did). In another, a room that stayed ahead
shared 0.79: peer fraction 0.792, host copies 1.047, beside a same-build control at 0.799 (20 Mbit/s
host, viewers at 10 Mbit/s, 4-second pieces, medians of 3 runs).

## 4. How it works

**Clock.** Each browser estimates its clock offset against the room server with NTP-style round
trips over the websocket. Samples are noisy, because a queued uplink delays one direction and not
the other, so they are filtered (the smallest round trips, and a moving estimate) before use. The
filter takes its samples from a probe function, so it is tested against manufactured asymmetry,
loss and steps with no network.

**Speed controller.** The room's position at any shared instant is computed from the replicated
play state. Each viewer reads which frame is actually on screen (`requestVideoFrameCallback`, not
`currentTime`) and nudges its playback speed by at most 1% to close the gap. A gap too large to
close by speed is closed by one jump to the room's position.

**Look-ahead control.** The library's own fetch-ahead races for pieces far in the future and fills
the host's uplink. The control sets the library's fetch-ahead windows and the host's send rate from
the shared clock and each viewer's buffer, aiming below the uplink's capacity, so the room stays
ahead and the connection stays free for the clock and the urgent pieces.

**Assignment at the buffer edge.** When the room is at its edge every viewer wants the same piece
at the same instant. Each piece in the next stretch then gets an assigned first fetcher; the others
take it from that viewer, so the host sends it about once. Further ahead, the library's own spread
is left alone.

**The host's tab is the source.** The host's browser serves every piece; it is the source of last
resort by construction, so viewers take from each other first.

**In-browser conversion.** The host's file is cut into streamable pieces in the browser with
`mp4box.js`: a remux, never a re-encode, and no server touches the file.

## 5. How it was measured

Every figure in sections 3, 6 and 7 comes from the measurement harness on one PC: a container for
the host's origin and one per viewer, each running headless Chrome, with each container's outgoing
traffic shaped (`tc`) to the stated upload rate. Downloads are not shaped. A run lasts 6 minutes
and the last 3 are measured, unless a section says otherwise. Each condition ran 1 to 4 times.
Where a comparison pairs tests from different days, the text says so.

Sync is measured from the presentation time of the frame each viewer actually displayed, on a fixed
synthetic 16.7 ms frame cadence, so a gap below one frame cannot be told from zero. Times are
**reconstructed lab time**. The test pages' clocks agree with each other to 0.6 ms, so the gaps
between viewers are sound. But every page's clock drifted 12–14 ms from real time over 6 minutes,
where 2 ms was allowed (a separate check of the test clocks), so a page's timestamp cannot be read
as real clock time.

## 6. The four goals

The project set itself four goals before testing: sync, host upload, sharing, and join and leave.
Host upload and sharing are the headline (section 3, and the table at the top). Here are the other
two.

### 6.1 Sync

**Screens stay within one frame of each other.** The readings step by 0.1 ms, and a reading within 1 ms
of the frame counts as one frame, so 16.8 ms counts as one 16.7 ms frame.

| Condition | 99th-percentile gap | Host uplink in use | Tests |
|---|---|---|---|
| Main setup, no network trouble | 16.7–16.8 ms | 29–30% | 3 |
| 5% of data lost | 0.2–16.8 ms | 31–33% | 3 |
| Every link 25 ms delayed | 16.6–16.8 ms | 30–31% | 3 |
| One viewer 60 ms farther away | 43 and 33 ms, missed | — | 2 |

On the main setup the median gap between viewers was under one frame in every test; with every link
delayed, the median was within one frame too, and host copies read 1.020–1.045. The first three rows
met their sync goals in all 3 tests each. All in reconstructed lab time.

**One viewer 60 ms farther away** than the rest widened the 99th-percentile gap to 43 and 33 ms. Its
clock offset, which it cannot see directly, was estimated at −31.2 and −29.9 ms against the 30 ms
the extra distance predicts.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/sync-dark.svg">
  <img src="images/sync-light.svg" alt="The 99th-percentile gap between viewers' screens: within one 16.7 ms frame with no trouble, 5% loss and 25 ms delay; 33 and 43 ms with one viewer 60 ms farther away." width="720">
</picture>

*Main setup, 5 viewers, 3 tests each; the far viewer 2 tests, a day later on the same app code.
Each bar reaches the highest test; red marks the condition over one frame. Reconstructed lab time.*

### 6.2 Join and leave

The goal: a late joiner is in step in under 2 seconds, and a viewer leaving freezes nobody.

**A late joiner** was in step 4–10 ms after its first picture appeared, in 3 of 3 tests. Counted
from the moment it joined the room, it took 3.1–3.3 s (3 081–3 254 ms): the 2-second goal was missed
in all 3. A fifth viewer joining a room of four, 3 tests. An earlier test round, also at 2-second
pieces, showed the joiner's first frame at 3 076 ms, which met that round's own goal for the first
picture, and the resync met too; but the host sent the joiner 11 pieces where 4 were allowed.

**A viewer who passes video on can drop out** without anyone else freezing: its network was cut in
3 of 3 tests, and no remaining viewer froze. An earlier test round found that the first fetcher can
leave without freezing anyone (3 of 3 tests; five viewers, 10 Mbit/s host).

## 7. Under stress and over time

**Weaker connections.** 2 tests each.

| Condition | Host copies | Peer fraction | Result |
|---|---|---|---|
| A 5 Mbit/s host | 1.043 and 1.047 | 0.793 and 0.795 | met, no freezes |
| One viewer's upload at 1 Mbit/s | 1.716 in one test, no figure in the other | 0.671 and 0.665 | sharing met; copies missed against the 1.5 goal |
| Every viewer's upload at 3 Mbit/s | no figure | 0.278 and 0.478 | missed; the 99th-percentile sync goal missed too, with 7 freezes in one test |

**Catching up.** A viewer 0.5 s behind closed the gap by playing up to 1% faster, into 40 ms in 51.4
and 48.8 s. A viewer 2 s behind closed it with one jump in 3.1 and 3.2 s. Neither caused a freeze or
moved the others. One viewer paused, 4 tests.

**An hour-long room.** Over 57 measured minutes of a 60-minute run, main setup, 5 viewers, the
viewers together got 0.797 of the video from other viewers. Nobody froze, playback ran at 1.0000 of
real time, and each viewer's storage stayed within its 1 GiB limit (1 073 741 824 bytes) while
fetching 1 209 083 368 bytes in total. 1 test, which met its goal. A 6-minute main-setup run on the
same build read 0.9997 host copies and peer fraction 0.7996.

## 8. The hosted instance

One run's observations on the hosted instance: 3 members on 2 networks (home broadband and a phone
on mobile data), one of them forced through the relay. Not a measured result, and no goal applies.
- The host's file prepared and played in the browser; both guests played. The relayed guest showed
  `0 direct · 1 relayed`, the phone `1 direct`.
- The server never served the video: `/media/master.m3u8` answered `404` during the room.
- Each page loaded 3.5 MB on a first visit. The room server's memory peaked at about 100 MB
  (102 016 KiB), and it used 0.5% of one CPU in a 10-second sample while the room played.
- Each member's start wait read 353–418 ms on its Stats panel. That is a different span from the
  lab's waits in section 9 and is not compared with them.

## 9. Limits

What the tests do not show, in plain words.

1. **The wait.** With 5 viewers, a start took 4.1–5.2 s and a seek 4.7–6.0 s (4 tests). The wait
   runs from the start or seek (a start from the last viewer's join) to the moment the room plays.
   In all eight (4 tests × a start and a seek), the room played only once every viewer was ready.
   An earlier test round measured the same span at 2-second pieces:

   | | Latest tests | Earlier round |
   |---|---|---|
   | Start | 4.1–5.2 s | 5.6 and 5.8 s |
   | Seek | 4.7–6.0 s | 5.1 and 6.2 s |

   The earlier 5.1 s seek depends on a fix to how the readings were computed, made after the
   results were in. Neither reading is an improvement on the other. At least 2.3 s of every start
   is fixed: the room waits 2 s after the last person joins, then adds a 300 ms lead. A file whose
   keyframes are far apart (up to 10 s) waits about 10 s.
2. **Ten viewers wait longer, and most holds ran out.** Of four held moments with 10 viewers, three
   waited the full 10 s safety limit and then played anyway, which counts as a failed hold: both
   starts and one seek. The one that did not took 9.4 s. 2 tests.
3. **One test PC**, headless Chrome, with uploads limited but not downloads. Nothing here was
   measured over the real internet.
4. **Sync is on reconstructed lab time**, not filmed on a screen. A gap under one frame cannot be
   told from zero, and sound was not timed, only video frames.
5. **The relay works, but its sharing and sync are not measured.**
6. **One video at one quality; 2 to 10 viewers, 10 being the rig's limit; 1–4 tests per setup**, so
   the figures are ranges, not averages or confidence intervals. Delay was measured only at 5
   viewers, with one uniform delay and one uneven path.
7. **Not tested:** other loss rates, jitter, mixed delays, weak downloads, rooms over 10 viewers,
   real home connections, and a whole film (one hour was the longest).
8. **Catching up is slow for small gaps.** The 1% speed limit means a 0.5 s gap takes about a minute
   (section 7). The smallest correction the controller acts on is not qualified in the harness.
9. **The 1 GiB storage limit has a cost that is not measured.** A viewer drops pieces behind its
   playhead once its store reaches the limit, about 50 minutes of the test video. A seek back past
   that, or a late joiner parked there, then draws those pieces from fewer viewers or from the host.
10. **A muted viewer in a background tab stops playing.** Chrome pauses a muted video while its tab
    is hidden. On return the viewer is put back at the room's position and lands 1.0–4.6 s off. An
    unmuted viewer plays on.
11. **The host must keep the room's tab in front.** While the host's tab is hidden it sends nothing,
    and its viewers stall once their buffer runs out.

## 10. Reproduce, and where the numbers are

The product is in `app/`. `cd app; npm install; npm run check` runs the structural rules and every
assertion suite in seconds, with no browser. `npm run dev:file` serves the app on
`http://127.0.0.1:8100` with a local tracker, where you can host a file of your own.

The harness is `app/harness/` (Docker, one container per browser, `tc` shaping) and its runner
`app/scripts/harness-run.mjs --condition <name>`, with the conditions in
`app/harness/conditions.json`. `cd app; npm run content` generates the test video the harness
serves, a synthetic 2-hour clip (ffmpeg on the path, about 2.3 GB). `app/scripts/measure-batch.mjs`
turns a batch of runs into pass/fail readings, and `app/scripts/measure-graphs.mjs` draws the
figures.

Every figure above comes from one of these files. Each lists every test run with its readings and
whether it met its goal. The individual run folders, with each screen's logs, are too large to keep
here. Inside the files, each run is named by the lab's own series label and the time it started.

| Figures | File |
|---|---|
| 2, 3, 5 and 10 viewers; the 20 Mbit/s host with sharing; loss; delay; joining and leaving; the wait | [`app/results/core-tests/verdicts.json`](app/results/core-tests/verdicts.json) |
| Without sharing; the library's defaults; the connection drop; the far viewer; weaker connections; catching up; ten-viewer waits | [`app/results/comparison-and-stress-tests/verdicts.json`](app/results/comparison-and-stress-tests/verdicts.json) |
| The hour-long room; uplink use in the pacing comparison | [`app/results/supporting-data/figures.json`](app/results/supporting-data/figures.json) |
| The check of the test clocks behind "reconstructed lab time" | [`app/results/clock-check/readings.json`](app/results/clock-check/readings.json) |
| The numbers the three charts draw | [`app/results/charts/figures.json`](app/results/charts/figures.json) |
| The buffer-edge seek (an earlier round) | [`app/results/test-inputs/buffer-edge-seek.json`](app/results/test-inputs/buffer-edge-seek.json) |

The other earlier-round readings quoted above (the room that stayed ahead, the steady-play
comparison, the earlier join, leave and wait tests) are summarised from records not kept in this
repository.

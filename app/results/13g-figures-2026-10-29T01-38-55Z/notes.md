# Results: notes on the figures

Rough draft: the numbers are final, but the look of the figures is not.

A group watches a video in step, shared from one person's computer; viewers pass pieces of it on to each other.

## Does sharing cut how much the sharer uploads?

**In one sentence.** With 5 viewers on the same connection, the person sharing the video uploaded 500% of what one viewer watched when everyone downloaded from them, and 102% when viewers passed the video on to each other.

**What the chart shows.** The middle amount uploaded by the sharer, as a percentage of the video one viewer watched.

**How it was tested.** 5 viewers and the person sharing the video, each in their own browser on one test computer. The sharer could upload at most 20 megabits per second, and each viewer 10 Mbit/s. Downloads were not limited. No data was lost or delayed. The video played at 2.64 megabits per second. Each test lasted 6 minutes; the first 3 let things settle and the last 3 were measured. Video pieces were 2 seconds long. without sharing: 3 tests; the round trip from each viewer to the room server was 0.0–1.0 ms. with sharing: 2 tests; the round trip from each viewer to the room server was 0.0–1.0 ms.

**Every test.**

| Test | Value | Freezes | Status |
| --- | --- | --- | --- |
| without sharing 1 | 500% | 0 | the byte count could not be checked against the viewers' records |
| without sharing 2 | 500% | 0 | the byte count could not be checked against the viewers' records |
| without sharing 3 | 500% | 0 | completed |
| with sharing 1 | 100% | 0 | completed |
| with sharing 2 | 103% | 0 | completed |

The tests without sharing came from two test nights; the builds for each test were 973c6df2, 973c6df2, cfe649a6 (different builds). The flagged runs were flagged only because a test without sharing has no viewer-to-viewer records to check, which a later night's rule allowed; the sharer's upload was counted normally. The no-sharing tests on a slower connection are in the connection figure's notes.

## Does the sharer upload more as more people watch?

**In one sentence.** As the room grew from 2 to 10 viewers, the sharer's upload stayed between 100% and 111% of what one viewer watched; without sharing it would grow to 1000%.

**What the chart shows.** The outlined amount is worked out; the blue amount is the middle measured upload.

**How it was tested.** 2 viewers: 2 viewers and the person sharing the video, each in their own browser on one test computer. 3 viewers: 3 viewers and the person sharing the video, each in their own browser on one test computer. 5 viewers: 5 viewers and the person sharing the video, each in their own browser on one test computer. 10 viewers: 10 viewers and the person sharing the video, each in their own browser on one test computer. The sharer could upload at most 10 megabits per second, and each viewer 10 Mbit/s. Downloads were not limited. No data was lost or delayed. The video played at 2.64 megabits per second. Each test lasted 6 minutes; the first 3 let things settle and the last 3 were measured. Video pieces were 2 seconds long. 2 viewers: 2 tests; the round trip from each viewer to the room server was 0.0–0.0 ms. 3 viewers: 2 tests; the round trip from each viewer to the room server was 0.0–1.0 ms. 5 viewers: 3 tests; the round trip from each viewer to the room server was 0.0–1.0 ms. 10 viewers: 3 tests; the round trip from each viewer to the room server was 0.0–1.0 ms.

**Every test.**

| Test | Value | Freezes | Status |
| --- | --- | --- | --- |
| 5 viewers 1 | 100% | 0 | completed |
| 5 viewers 2 | 103% | 0 | completed |
| 5 viewers 3 | 98% | 0 | completed |
| 10 viewers 1 | 110% | 0 | completed |
| 10 viewers 2 | 111% | 0 | completed |
| 10 viewers 3 | 111% | 0 | completed |
| 2 viewers 1 | 101% | 0 | completed |
| 2 viewers 2 | 101% | 0 | completed |
| 3 viewers 1 | 101% | 0 | completed |
| 3 viewers 2 | 100% | 0 | completed |

**What it means.** Viewers passed pieces to each other, reducing what the sharer sent. These are small tests on one computer.

## How closely in step do the screens stay?

**In one sentence.** 99% of the time, viewers' screens were within 17 ms of each other, about one screen refresh, with no network trouble, with 5% of data lost and with everyone 25 ms delayed; with one viewer 60 ms farther away than the rest, within 43 ms.

**What the chart shows.** How far apart two viewers' pictures were, at the moment 99 of every 100 frames were closer.

**How it was tested.** 5 viewers and the person sharing the video, each in their own browser on one test computer. The sharer could upload at most 10 megabits per second, and each viewer 10 Mbit/s. Downloads were not limited. no network trouble: No data was lost or delayed. 5% of data lost. everyone 25 ms delayed. one viewer 60 ms farther away. The video played at 2.64 megabits per second. Each test lasted 6 minutes; the first 3 let things settle and the last 3 were measured. Video pieces were 2 seconds long. no network trouble: 3 tests; the round trip from each viewer to the room server was 0.0–1.0 ms. 5% of data lost: 3 tests; the round trip from each viewer to the room server was 0.0–1.0 ms. everyone 25 ms delayed: 3 tests; the round trip from each viewer to the room server was 25.0–26.0 ms. one viewer 60 ms farther away: 2 tests; the round trip from each viewer to the room server was 0.0–61.0 ms.

**Every test.**

| Test | Typical gap | 99% gap | Uncertainty | Connection use | Frames recorded | Freezes | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| no network trouble 1 | < 17 ms | < 17 ms | < 17 ms–17 ms | 30% | 100% | 0 | completed |
| no network trouble 2 | < 17 ms | 17 ms | < 17 ms–17 ms | 30% | 100% | 0 | completed |
| no network trouble 3 | < 17 ms | 17 ms | < 17 ms–25 ms | 29% | 100% | 0 | completed |
| 5% of data lost 1 | < 17 ms | 17 ms | < 17 ms–25 ms | 31% | 100% | 0 | completed |
| 5% of data lost 2 | < 17 ms | 17 ms | < 17 ms–17 ms | 33% | 100% | 0 | completed |
| 5% of data lost 3 | < 17 ms | < 17 ms | < 17 ms–17 ms | 32% | 100% | 0 | completed |
| everyone 25 ms delayed 1 | < 17 ms | 17 ms | < 17 ms–17 ms | 31% | 100% | 0 | completed |
| everyone 25 ms delayed 2 | < 17 ms | < 17 ms | < 17 ms–17 ms | 30% | 100% | 0 | completed |
| everyone 25 ms delayed 3 | < 17 ms | 17 ms | < 17 ms–17 ms | 31% | 100% | 0 | completed |
| one viewer 60 ms farther away 1 | < 17 ms | 43 ms | 26 ms–59 ms | 30% | 100% | 0 | completed |
| one viewer 60 ms farther away 2 | < 17 ms | 33 ms | < 17 ms–42 ms | 31% | 100% | 0 | completed |

no network trouble: 5.1 seconds above 40 ms and 5.1 seconds above 100 ms per hour of playing. 5% of data lost: 0.0 seconds above 40 ms and 0.0 seconds above 100 ms per hour of playing. everyone 25 ms delayed: 0.0 seconds above 40 ms and 0.0 seconds above 100 ms per hour of playing. one viewer 60 ms farther away: 0.0 seconds above 40 ms and 0.0 seconds above 100 ms per hour of playing. The times are reconstructed from the test computer's clock, not filmed on a screen, and a gap smaller than one screen refresh cannot be told apart from zero.

## How full does the sharer's connection get?

**In one sentence.** With 5 viewers on a 10 Mbit/s connection, sending everyone their own copy would need 132% of it, more than it has; off-the-shelf sharing settings kept it 99% full, and this app used 30%, with the same smooth, in-step playback.

**What the chart shows.** The sharing library's own default settings, with this app's pacing switched off, are called off-the-shelf sharing settings.

**How it was tested.** 5 viewers and the person sharing the video, each in their own browser on one test computer. The sharer could upload at most 10 megabits per second, and each viewer 10 Mbit/s. Downloads were not limited. No data was lost or delayed. The video played at 2.64 megabits per second. Each test lasted 6 minutes; the first 3 let things settle and the last 3 were measured. Video pieces were 2 seconds long. off-the-shelf sharing settings: 2 tests; the round trip from each viewer to the room server was 34.0–71.0 ms. this app: 3 tests; the round trip from each viewer to the room server was 0.0–1.0 ms.

**Every test.**

| Test | Value | Freezes | Status |
| --- | --- | --- | --- |
| this app 1 | 30% | 0 | completed |
| this app 2 | 30% | 0 | completed |
| this app 3 | 29% | 0 | completed |
| off-the-shelf sharing settings 1 | 100% | 0 | completed |
| off-the-shelf sharing settings 2 | 99% | 0 | completed |

this app: 99% gap < 17 ms, build 973c6df2. this app: 99% gap 17 ms, build 973c6df2. this app: 99% gap 17 ms, build 973c6df2. off-the-shelf sharing settings: 99% gap 17 ms, build cfe649a6. off-the-shelf sharing settings: 99% gap 17 ms, build cfe649a6. The two sides ran on different days' builds. With off-the-shelf settings, anything else the sharer sent waited about 117 ms longer. The no-sharing tests at this speed were not drawn: the test stopped before it finished; the byte count could not be checked against the viewers' records; unrecorded freezes; the test stopped before it finished; the byte count could not be checked against the viewers' records; unrecorded freezes; the test's own checks refused it; a viewer stopped playing, so there is no fair 'one viewing' to divide by; 96 freezes. The times are reconstructed from the test computer's clock, not filmed on a screen.

## After the sharer's connection drops, do viewers keep freezing? This app against its own earlier version

**In one sentence.** After the sharer's connection dropped from 10 to 1 Mbit/s for about 2 minutes and came back, viewers froze 2, 0, 0 times with this app's current version and 109, 20, 35 times with its earlier version in side-by-side tests.

**What the chart shows.** When viewers are about to run out, the current version has one viewer fetch each upcoming piece from the sharer and the others take it from that viewer. The earlier version let every viewer fetch it from the sharer itself. Both ran the same build of this app; only this rule differed.

**How it was tested.** 5 viewers and the person sharing the video, each in their own browser on one test computer. The sharer could upload at most 10 megabits per second, and each viewer 10 Mbit/s. Downloads were not limited. No data was lost or delayed. The video played at 2.64 megabits per second. Each test lasted 8 minutes; the first 2 let things settle and the last 4 were measured. Video pieces were 2 seconds long. current version: 3 tests; the round trip from each viewer to the room server was 0.0–1.0 ms. earlier version: 3 tests; the round trip from each viewer to the room server was 0.0–1.0 ms. The tests ran side by side the same night, in alternating order.

**Every test.**

| Test | Freezes per viewer | Status |
| --- | --- | --- |
| Test 1, current version | 0, 0, 0, 0, 2 | completed |
| Test 1, earlier version | 5, 24, 21, 28, 31 | completed |
| Test 2, current version | 0, 0, 0, 0, 0 | completed |
| Test 2, earlier version | 3, 6, 4, 4, 3 | completed |
| Test 3, current version | 0, 0, 0, 0, 0 | completed |
| Test 3, earlier version | 6, 12, 8, 7, 2 | completed |

Test 1: the connection dropped from 10 to 1 Mbit/s for 2.0 minutes. Test 2: the connection dropped from 10 to 1 Mbit/s for 1.7 minutes. Test 3: the connection dropped from 10 to 1 Mbit/s for 2.0 minutes. Freezes during the drop itself are not counted.

## How long does a viewer wait?

**In one sentence.** With 5 viewers, the video was playing for everyone about 4.8 s after pressing play and 5.0 s after jumping to a new point; someone joining late was playing in step after 3.1 s.

**What the chart shows.** The middle wait until playback is in step.

**How it was tested.** 5 viewers and the person sharing the video, each in their own browser on one test computer. The sharer could upload at most 10 megabits per second, and each viewer 10 Mbit/s. Downloads were not limited. No data was lost or delayed. The video played at 2.64 megabits per second. starting and jumping: Each test lasted 6 minutes; the first 3 let things settle and the last 3 were measured. joining late: Each test lasted 5 minutes; the first 3 let things settle and the last 2 were measured. Video pieces were 2 seconds long. starting and jumping: 4 tests; the round trip from each viewer to the room server was 0.0–1.0 ms. joining late: 3 tests; the round trip from each viewer to the room server was 0.0–1.0 ms.

**Every test.**

| Test | Waits | Freezes | Status |
| --- | --- | --- | --- |
| Starting and jumping 1 | Start 5.2 s; jump 5.1 s | 0 | completed |
| Starting and jumping 2 | Start 4.8 s; jump 5.0 s | 0 | completed |
| Starting and jumping 3 | Start 4.1 s; jump 6.0 s | 0 | completed |
| Starting and jumping 4 | Start 4.7 s; jump 4.7 s | 0 | completed |
| Joining 1 | Open to first picture 3.1 s; first picture to in step 0.0 s; open to in step 3.1 s | 0 | completed |
| Joining 2 | Open to first picture 3.2 s; first picture to in step 0.0 s; open to in step 3.3 s | 0 | completed |
| Joining 3 | Open to first picture 3.1 s; first picture to in step 0.0 s; open to in step 3.1 s | 0 | completed |
| 10 viewers 1 | Start 5.0 s; jump 10.3 s | 0 | completed |
| 10 viewers 2 | Start 5.3 s; jump 9.4 s | 0 | completed |

## Does sharing still work on weaker connections?

**In one sentence.** When the sharer uploads at 5 Mbit/s, viewers still got 79% of the video from each other, and when one viewer uploads at 1 Mbit/s, 67%; nobody froze in these tests.

**What the chart shows.** The middle share of video passed between viewers.

**How it was tested.** 5 viewers and the person sharing the video, each in their own browser on one test computer. sharer uploads at 5 Mbit/s: The sharer could upload at most 5 megabits per second, and each viewer 10 Mbit/s. one viewer uploads at 1 Mbit/s: The sharer could upload at most 10 megabits per second; viewer upload limits were a viewer 10 Mbit/s, a viewer 10 Mbit/s, a viewer 10 Mbit/s, a viewer 10 Mbit/s, a viewer 1 Mbit/s. main setup: The sharer could upload at most 10 megabits per second, and each viewer 10 Mbit/s. Downloads were not limited. No data was lost or delayed. The video played at 2.64 megabits per second. Each test lasted 6 minutes; the first 3 let things settle and the last 3 were measured. Video pieces were 2 seconds long. sharer uploads at 5 Mbit/s: 2 tests; the round trip from each viewer to the room server was 0.0–1.0 ms. one viewer uploads at 1 Mbit/s: 2 tests; the round trip from each viewer to the room server was 0.0–1.0 ms. main setup: 3 tests; the round trip from each viewer to the room server was 0.0–1.0 ms.

**Every test.**

| Test | Share | Sharer upload | Freezes | Status |
| --- | --- | --- | --- | --- |
| sharer uploads at 5 Mbit/s 1 | 79% | 104% | 0 | completed |
| sharer uploads at 5 Mbit/s 2 | 80% | 105% | 0 | completed |
| one viewer uploads at 1 Mbit/s 1 | 67% | a viewer was not downloading at the pace it played | 0 | completed |
| one viewer uploads at 1 Mbit/s 2 | 66% | 172% | 0 | completed |
| every viewer uploads at 3 Mbit/s 1 | 28% | a viewer stopped playing, so there is no fair 'one viewing' to divide by | 7 | completed |
| every viewer uploads at 3 Mbit/s 2 | 48% | the pacing check could not be completed | 0 | completed |

sharer uploads at 5 Mbit/s: the two shares differ by 0.2 percentage points. one viewer uploads at 1 Mbit/s: the two shares differ by 0.6 percentage points. The dashed line is the main setup from another test night, on build 973c6df2, against cfe649a6 for the bars, so it is not a matched comparison.

## Where does the video come from over an hour?

**In one sentence.** Over an hour of 5 people watching, 80% of the video the viewers received came from each other, and nobody froze (0 freezes).

**What the chart shows.** The downloads completed in each minute, grouped by where they came from.

**How it was tested.** 5 viewers and the person sharing the video, each in their own browser on one test computer. The sharer could upload at most 10 megabits per second, and each viewer 10 Mbit/s. Downloads were not limited. No data was lost or delayed. The video played at 2.64 megabits per second. Each test lasted 60 minutes; the first 3 let things settle and the last 57 were measured. Video pieces were 2 seconds long. hour-long test: 1 tests; the round trip from each viewer to the room server was 0.0–1.0 ms.

**Every test.**

| Test | Share from viewers | Freezes | Status |
| --- | --- | --- | --- |
| Hour-long test | 80% | 0 | completed |
| Earlier attempt | no value | unrecorded | the test was stopped by hand; the test did not finish recording; the timing records could not be read; the byte count could not be checked against the viewers' records |

The earlier attempt did not count. The sharer's upload was not scored because the pacing check could not be completed.

## Also tested

Freezing when everyone starts or jumps at once. Starting: the newer way froze for a middle 0.0 seconds in total, added across viewers, the earlier way 48.5 seconds; fewer in 3 of 3 pairs. Jumping: the newer way froze for a middle 0.0 seconds in total, added across viewers, the earlier way 33.6 seconds; fewer in 3 of 3 pairs. The test also looked for the sharer sending fewer copies at those moments, and that was not shown. The version with ten viewers had 0 valid pairs.

A viewer passing video on leaves suddenly: 0 of 4 froze; 0 of 4 froze; 0 of 4 froze.

Catching up: after a 0.5 second pause, the viewer caught up in 51.4 seconds by playing slightly faster; after a 2.0 second pause, the viewer caught up in 3.1 seconds by jumping; after a 2.0 second pause, the viewer caught up in 3.2 seconds by jumping; after a 0.5 second pause, the viewer caught up in 48.8 seconds by playing slightly faster. A viewer that falls behind speeds up by at most 1%, so a small gap takes close to a minute to close; a large one closes at once by jumping.

## Limits

- Every test ran on one computer, with the network between the browsers imitated on it. Nothing was measured over the real internet.
- One video was used throughout, at one quality.
- Only uploads were limited. Downloads ran at the computer's full speed.
- The largest room tested had 10 viewers, the most the test computer could run.
- Each setup was tested 1 to 4 times. The figures show the middle value and the notes list every test. These are small samples, not statistical averages.
- Timing was measured on the pictures only. Sound was not timed.

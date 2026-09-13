# Listening comparison — pitch-disabled fallback

A small, manually started comparison to help decide whether the pitch-disabled
remedy (`c5231da`) is acceptable to listen to. It is research-only: no product
code, no controller, and no automated experiment.

## How to run it

Open the page in the same Chrome the comparison batches used, with headphones:

```powershell
& "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" "app\listening\listening.html"
```

1. Pick **Speech** or **Music**.
2. Optionally tick **Hide labels**. The four conditions then become A–D in a
   random order, and the page stops showing the live rate. Use the notes field
   for each letter, and press **Reveal** afterwards.
3. Press **Play** on any row. Each condition restarts the same passage from its
   start, and **Stop** ends it. The passage is 24 s for speech and 48 s for
   music.

## The four conditions

`preservesPitch = false` in every one, which is the fallback's setting. Only the
rate schedule differs.

| Condition | Rate schedule |
|---|---|
| Normal playback | 1 throughout |
| Recorded correction | The fallback controller's **actual** 76 rate writes, on their recorded times, then 1 |
| Constant 0.99 | **Labelled worst case.** Full authority on the slow side for the whole passage |
| Constant 1.01 | **Labelled worst case.** Full authority on the fast side for the whole passage |

**Where the recorded correction comes from.**

- It was exported by `extract-trajectory.mjs` from the passing pitch-disabled
  batch, `results/4e-browser-comparison-2026-09-11T05-35-04.025Z-26420-ea0f957f`.
- The selection rule is fixed, not chosen by ear: take **the client with the
  most correction** of the four, measured as the integral of |rate − 1|. That
  is the trial-1 viewer, at 166.4 ms. The others had 151.7, 117.8 and 108.5 ms.
- The client recorded `preservesPitch` as `false`.
- The writes, relative to its capture-window start:
  - 1.01 at 0.33 s, back to 1 at 0.83 s;
  - 1.01 again from 1.58 s to 11.58 s;
  - a decline to about 1.001 over the next ~30 s, with brief returns to 1;
  - the last write at 42.58 s.
- The run corrected only upward. No slow-down appears in any retained candidate
  run, which is why 0.99 is offered as a worst case, not as typical.

After each condition finishes, the status line shows how many writes were
applied and the latest any write landed after its recorded time. That lateness
is the page's own timer, polling every 5 ms.

## Material

The clips in `clips/` are 48 kHz AAC, which matches the fixture's audio rate,
and they are loudness-matched to the same level. The full music download is in
`source/`.

| Clip | Cut | Source | Licence |
|---|---|---|---|
| `speech.m4a` | The whole 24.7 s file | Supplied by the user as `Downloads\ludwig.wav` (48 kHz 16-bit PCM) | — |
| `music.m4a` | 0–50 s | Mozart, Piano Sonata No. 10 in C major, K. 330, I — performed by Bui-Nguyen Trieu-Tuong, [MusOpen Project](https://commons.wikimedia.org/wiki/File:Mozart,_Wolfgang_Amadeus_%E2%80%94_Piano_Sonata_No._10_in_C_major,_K._330_%E2%80%94_1st_movement_%E2%80%94_Bui-Nguyen_Trieu-Tuong_%E2%80%94_MusOpen_Project.mp3), Wikimedia Commons | CC BY-SA 3.0 |

## What this can and cannot show

**What it can show.** Whether *you* hear the rate changes the fallback actually
made, on real speech and piano, in this Chrome. With pitch preservation off, a
rate of 1.01 also raises pitch by about 1 %, which is 17 cents.

**What it cannot show:**

- **It is a replay, not the controller.**
  - The writes land on the recorded wall-clock times from the moment playback
    starts. They are not driven by live drift.
  - A different room, network or machine would produce a different trajectory.
  - This is one client from one batch, on one fixture.
- **Speech hears only the first half of the correction.**
  - The speech clip is 24.7 s long, so its passage stops at 24 s.
  - That covers the 1.01 hold, from 1.6 to 11.6 s, and the start of the
    decline. It does not reach the smaller corrections that follow.
  - Music plays all 76 writes.
- **It uses an `<audio>` element playing an AAC file.**
  - The product plays a `<video>` through hls.js.
  - Both go through Chrome's media-element rate handling. The element and the
    container differ, though, and that is an assumption, not something tested
    here.
- **Order and familiarity matter.** Once you know a passage, a change is
  easier to notice. Hidden labels, reshuffled between sessions, reduce this but
  don't remove it.

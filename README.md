# Sentence Bonanza ★

A reading and vocabulary game for 2nd and 3rd graders. It runs as a static site with no build step and no dependencies.

**Play:** https://talcom.github.io/sentence-bonanza/

## How it plays

1. Pick a level. The word cards are dealt and flip face-up.
2. Memorize where the words are (tap a word to hear it read aloud), then press **Go!**
3. The cards flip face-down and a fill-in-the-blank sentence appears. Flip the card that completes it.

| Result | Stars |
| --- | --- |
| Right on the 1st try | +10 (big celebration) |
| Right on the 2nd try | +5 |
| Right on the 3rd try | +1 |
| Each wrong card | −10 (the card stays face-up) |
| 3 wrong cards | The answer is revealed, then the next sentence |

Every game starts at **100 ★**. It ends at **0 ★** (out of stars) or **250 ★** (Superstar!).

## Levels

| Level | Cards | Focus |
| --- | --- | --- |
| ✨ Twinkle | 4 | Short, simple sentences |
| ☄️ Comet | 6 | Longer everyday sentences |
| 🚀 Rocket | 6 | Context clues |
| 🌌 Galaxy | 8 | Bigger vocabulary words |
| 🌟 Supernova | 8 | Tricky words and inference |

The wrong-answer words for each sentence are hand-picked so that only one card makes sense.

## Grown-ups' corner

The **Grown-ups** button is on the home screen (it's behind a quick multiplication question). From there you can:

- review every sentence, its answer, and its wrong-answer words
- see per-sentence stats: how many tries it took each time, recent results, and the average number of tries
- see game history and first-try accuracy for each level
- create custom levels (name, emoji, 4/6/8 cards) and add, edit, or delete sentences. A live preview reads each word in the sentence so you can check that only one fits.
- download or load custom levels as a JSON file, for backup or to share between devices
- reset scores and stats

Scores, stats, and custom levels are kept in the browser's `localStorage`, so they stay on the device and browser where they were made.

## Files

- `index.html`: all screens
- `css/styles.css`: styles
- `js/levels.js`: built-in sentences (`[sentence with ___, answer, [wrong words]]`)
- `js/app.js`: game logic, storage, and the parent view

To run it locally, serve the folder (for example `python3 -m http.server`) and open http://localhost:8000.

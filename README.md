# Krishiv Sports

Party sports for the browser: one games menu with **Tennis**, **Golf**, **Bowling** and **Krishiv Kart**, where each player's **phone is the controller**. The TV (or laptop) shows the game; you pick a game, its lobby shows a QR code, everyone scans it, and their phone becomes a racket or a golf club.

Tennis and Golf live at the top of this repo; Bowling (`games/bowling`) and Krishiv Kart (`games/krishiv-kart`) are complete games of their own: picking one starts it on its own ports and the TV switches to its own lobby and QR code, exactly as when you run it on its own. It is built the same way as those two: a small Node server, Socket.IO, a self-signed HTTPS page for the phones (motion sensors need HTTPS) and server-generated QR codes. Everything you see and hear is generated in code — no image, model or audio files.

## Run it

```bash
git clone https://github.com/johrmohr/TungSports.git
cd TungSports
npm install      # also installs games/bowling and games/krishiv-kart
npm start
```

The games menu opens at **http://localhost:3000** on the computer connected to the TV. Phones must be on the **same Wi-Fi**.

1. **Pick a game** on the TV — click it, use the arrow keys + Enter, or press 1–4.
2. Tennis and Golf open their **lobby**: everyone scans the QR code (players get P1–P4 in the order they join; P1 is the host).
3. The first time, the phone warns about the certificate (it is this computer's own local certificate):
   - **iPhone:** *Show Details* → *visit this website* → *Visit Website*
   - **Android:** *Advanced* → *Proceed*
   Phones that already accepted Bowling's certificate are usually not asked again (the menu reuses it).
4. Enter a name, pick a character and colour, tap **Join** (iPhone then asks for *Motion & Orientation* — tap **Allow**).
5. Choose the settings and press **Start** — on the TV, or on P1's phone.

Every game needs **at least one player** (a phone, or a keyboard player added in the lobby) — there are no CPU-only matches. Click or press a key on the TV page once so the browser allows sound; **M** mutes.

> Bowling and Krishiv Kart started on their own also use ports 3000 / 3443 — stop them first. You don't need to start them: the menu runs Bowling on 3100 / 3543 and Krishiv Kart on 3200 / 3643 by itself. Different ports: `PORT=3010 HTTPS_PORT=3453 npm start`.

## The flow

```
games menu ──▶ Tennis / Golf lobby (QR code, players, settings) ──▶ game ──▶ results ─┐
     │                 ▲                                                               │
     │                 └────────────────── Play again / Back to the lobby ◀────────────┘
     └──▶ Bowling / Krishiv Kart: their own lobby and QR code; ⌂ Krishiv Sports comes back
```

| | TV (keyboard / mouse) | Phone |
|---|---|---|
| Games menu | Click a game · arrows + Enter · 1–4 | Waits — “Pick a game on the TV” |
| Lobby | Settings, **+ Keyboard player**, **Start** · Esc = back to the games | The host changes the settings and taps **Start** |
| In a game | Esc / P pauses (Continue · Restart · Quit to the lobby) | **+** pauses |
| Bowling / Kart | *⌂ Krishiv Sports* button (bottom left) or the Home key | **⌂** in the top bar takes everyone back |

Phones that joined a lobby stay paired while the TV page is open: they follow the TV into the other lobby, and into Bowling / Krishiv Kart (Bowling also gets each player's name, colour, character and hand).

## Tennis

Doubles: two per side. On your own you control both players on your side (or take a CPU partner); two players team up against the CPU or go head to head; with three or four, everyone gets a court position. Players run to the ball by themselves — **you only swing**. Matches of 1, 3 or 5 games; CPU skill Rookie / Pro / Champion.

| | Phone (motion) | Phone (touch) | Keyboard |
|---|---|---|---|
| Hit | Swing on your racket side (forehand) or across your body (backhand) | Swipe across the pad | Space (Z / X force forehand / backhand). A second keyboard player uses Enter (, / .) |
| Aim | **Timing**: swing early → the ball goes cross-court; late → down the line | same | same |
| Lob / slice | Swing low → high for a lob, high → low for a slice (or a drop volley at the net) | Swipe up / down | Hold ↑ / ↓ while you hit |
| Topspin | Roll your wrist over through the ball | — | — |
| Serve | Flick up (or tap **TOSS**) to toss, then swing. Hit at the **top of the toss** for a *fastball* | Tap TOSS, then swipe | Your key to toss, again to hit |

- Swing speed sets the pace. The player at the net volleys and smashes balls in reach; the one at the back plays the ground strokes.
- Scoring: 15–30–40, deuce and advantage, doubles serve order, receivers alternate, a new server every game; the umpire calls the score.
- The ball is simulated with real numbers (ITF court and net, 57 g ball, drag, lift from spin, a spin-aware bounce), so topspin dips and kicks, slice skids and stays low, lobs float.
- Winners after a rally, fastball aces and out calls get a slow-motion replay. With humans on both sides, the screen splits.

## Golf — Krishiv Links

Nine original holes in three loops — **Meadow** (1–3, a light breeze), **Lakeside** (4–6, water in play), **Clifftop** (7–9, by the sea and windy) — or the **Full 9**, for 1–4 players taking turns (farthest from the hole plays next). Four clubs: **Driver, Iron, Wedge, Putter** — the game picks one for the distance, you can change it.

| # | Hole | Par | Yards | |
|---|---|---|---|---|
| 1 | First Tee | 4 | 365 | gentle dogleg right, bunker on the corner |
| 2 | Long Meadow | 5 | 520 | an S round two groves, cross bunker at the lay-up |
| 3 | Twin Oaks | 3 | 140 | downhill between two big oaks |
| 4 | Lakeside | 4 | 340 | bends right round a lake — or carry it |
| 5 | Peninsula | 3 | 140 | green with water on three sides |
| 6 | Three Ponds | 5 | 495 | a pond at the drive, the lay-up and the green |
| 7 | Cliff Edge | 4 | 385 | the sea all down the left |
| 8 | Sea Carry | 3 | 200 | headland to headland over the sea |
| 9 | Home | 4 | 410 | uphill in two steps, out of bounds right |

| | Phone (motion) | Phone (touch) | Keyboard |
|---|---|---|---|
| Aim | **◀ ▶** | **◀ ▶** | ← → |
| Club | **▲ ▼** | **▲ ▼** | ↑ ↓ |
| Swing | **Hold A** (the grip), swing back and through like a club | Pull the grip down for power, let go | Hold Space, release |
| Practice swing | Swing **without** holding A — the meter shows the power, nothing is hit | — | — |
| Hook / slice | Twist the phone at impact | Pull sideways | — |
| Slope grid (greens) / map | **1** | **1** | 1 |
| Look from the ball | **2** | **2** | 2 |

- The power meter has dots at 25 / 50 / 75 / 100 %. **Swinging past the top dot is an overswing** — more distance, but the ball hooks or slices hard. On the green the putter scale grows with the distance to the hole.
- Lies matter: from the rough you only get half power, from a bunker a quarter. Water and out of bounds cost a stroke; a hole ends at three times par.
- Wind carries the ball more the higher it flies. Trees catch or knock down shots; the flagstick, cup lips and slopes are all part of the physics.
- A flyover introduces every hole; scorecard after each hole, standings at the end.

## Bowling and Krishiv Kart

Pick them on the menu: the server starts that project (if it isn't running already) and the TV opens its own lobby and QR code. **⌂** on a phone (or the TV's *⌂ Krishiv Sports* button / Home key) takes the TV — and the phones that came from a lobby here — back to the games menu.

To make that work, one small inline `<script>` was added to four pages of those projects — `games/bowling/public/index.html`, `games/bowling/public/remote.html`, `games/krishiv-kart/public/index.html`, `games/krishiv-kart/public/pad.html`. It does nothing unless the page was opened from this menu (`?hub=` in the address), so both games still run exactly as before on their own. They are looked for in `games/` (or, for the old layout, next to this folder); elsewhere: `BOWLING_DIR=… KART_DIR=… npm start`. Each can also be run on its own: `cd games/bowling && npm start` (see its README).

## Adding a game to the menu

The menu is built from `GAMES` in `public/js/shared/protocol.js` (name, blurb, players, `native`) and the card art in `public/js/tv/art.js`. A game that runs in this app needs a `public/js/tv/<id>/game.js` and a lobby entry in `lobby.js`; another project next to this folder is started the way Bowling and Kart are (`CHILD_GAMES` in `server.js`).

## Tests

```bash
npm test             # tennis rules + physics (76), golf course + physics (148), swing detectors (35), server (68)
npm run test:all     # the above + Bowling's and Krishiv Kart's own test suites
npm run test:e2e     # headless Chrome: menu → lobby → a phone plays Tennis and Golf; the Bowling and Kart hand-off and HOME
npm run tour         # screenshots of all nine golf holes into ./screenshots
```

Browser tests use Google Chrome at its standard macOS path (`CHROME_PATH` overrides it). The swing detectors are tested with synthetic sensor traces; real-device swing feel still deserves a hands-on test with your phones.

## Layout

```
server.js               HTTP (TV) + HTTPS (phones) + Socket.IO rooms, QR codes, input validation;
                        starts Bowling / Krishiv Kart and sends everyone there and back
public/index.html       TV page              public/play.html    phone controller
public/hub-link.js      the "⌂ Krishiv Sports" link the Bowling / Kart pages load from this server
public/js/shared/       protocol.js · tennis-rules.js · tennis-physics.js · golf-course.js · golf-physics.js · golf-rules.js
public/js/tv/           app.js (flow) · menu.js (games) · lobby.js · net.js · audio.js · brainrot.js (characters) · ui.js · art.js
public/js/tv/tennis/    game.js · court.js · hud.js
public/js/tv/golf/      game.js · course.js · hud.js
public/js/phone/        app.js (phone UI + network) · tennis-swing.js · golf-swing.js
tools/                  tests, e2e, screenshot tour
```

## Troubleshooting

| Problem | Fix |
|---|---|
| "Port 3000 is already in use" | Bowling or Krishiv Kart is running on its own — stop it, or use `PORT=3010 HTTPS_PORT=3453 npm start`. |
| Phone can't open the page | Same Wi-Fi (not a guest network). Allow `node` when macOS asks about incoming connections. With several networks, `PAD_HOST=<ip> npm start`. |
| Bowling / Kart card says *Not found* | Its packages are missing — run `npm install` at the top of the repo (it installs every game) — the terminal says which when the server starts (and the card's tooltip). |
| Start stays greyed out | Nobody has joined yet: scan the lobby's QR code, or add a keyboard player. |
| Swinging does nothing on iPhone | Reload, tap **Join**, allow Motion & Orientation. If you tapped *Don't Allow*, close Safari completely and reopen the page. Touch controls work meanwhile (⚙ → Controls). |
| Shots curve the wrong way | Left-handers pick *Left* as their hand (Join screen, or **Edit** on the phone); otherwise phone ⚙ → *Invert spin / curve*. |
| Golf shots always too short / too long | Phone ⚙ → *Golf swing strength* (Light / Normal / Strong). |
| No sound on the TV | Click the TV page or press a key once. **M** mutes. |

## Repository layout

```
server.js, public/, tools/   the games menu + Tennis + Golf (this README)
games/bowling/               Krishiv Bowling (its own README, server and tests)
games/krishiv-kart/          Krishiv Kart (its own README, server, SPEC and tests)
```

Nothing generated is committed: every server makes its own self-signed HTTPS certificate in a git-ignored `.certs/` folder on first start, and `node_modules/` comes from `npm install`.

## Credits

Krishiv Kart's Aldrich Park course: map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the Open Database License (ODbL); elevation: USGS 3DEP (public domain).

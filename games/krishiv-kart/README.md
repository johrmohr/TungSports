# TTTKart — KRISHIV KART

TTTKart is an open source 3D kart racing game for the desktop browser. **One big screen,
up to four players, and every phone is a steering wheel**: scan the QR code, turn the
phone like a wheel and race your friends in split-screen against CPU rivals. The game
calls itself **KRISHIV KART**; TTTKart is the repository name.

Everything you see and hear is made in code (models, textures, sound effects, music).
The interface loads its fonts from Google Fonts. There is no build step.

## What's in the game

* **1–4 players on one screen.** Each player joins with their own phone and races in
  their own view: full screen alone, side by side with two, four quadrants with three
  or four (with three, the fourth corner shows the map and live standings). CPUs fill
  the grid to eight racers.
* **Grand Prix — two cups,** three laps per race. Points after every race
  (10-8-6-5-4-3-2-1), standings, and a trophy podium for the top three after the last race.

  | Cup | Races |
  |---|---|
  | **Gelato Cup** (4 races) | Breezy Bay Circuit → Monte Mozzarella → Aldrich Park → Laguna Beach |
  | **Krishiv Cup** (5 races) | Breezy Bay Circuit → Laguna Beach → Monte Mozzarella → Aldrich Park → Krishiv's Palace |

* **VS Race:** the host picks any of the five tracks (or Random) and switches items on or
  off; after each race choose the next track and the points keep adding up.
* **Five tracks:**

  | Track | What it's like |
  |---|---|
  | **Breezy Bay Circuit** | the seaside opener (1.37 km): grandstands on the beach, the esses up Breezy Hill, the Lighthouse Hairpin, the arched Bay Bridge, a harbour kicker past the fishing boats, giant crabs scuttling across Crab Cove (they raise their claws before turning back), the Spit Turn round a beacon island (a boost cuts its sandy tip), waves washing over the Tide Causeway (the tide rises on laps 2–3; the land side stays dry), the Gull Gap cliff jump over a surf-filled notch, and beach balls bouncing across the promenade below a Ferris wheel |
  | **Monte Mozzarella** | an Italian hill town (1.44 km, counter-clockwise): Via Vespa, a long town street where scooters ride out of the alleys alongside you, the gelato esses and Laundry Lane, a switchback climb of two hairpins up to the bell tower, fountain jets erupting in a sweeping wave across Piazza Alta on the summit, the Belvedere terrace and the aqueduct jump, giant cheese wheels rolling out of the dairy across the Cheese Run, the Espresso chicane through the coffee works and the pizza-oven turn with its lawn shortcut |
  | **Aldrich Park** | built from real map and elevation data of the round park in the middle of UC Irvine's campus (1.52 km, clockwise): the Ring Mall promenade past the campus buildings where they really stand, the Engineering Bridge (a side kicker hops you onto it), the Alumni Grove spoke, the Inner Ring past the Infinity Fountain, where a pair of ducks waddles across, a dirt path out of the West Gate, the gravel Meadow Spine with pop-up lawn sprinklers and the Arroyo Jump, the sculpture-garden corridor and the Arch Corner under the Humanities footbridge; cyclists ring their bells and cross the Ring at the two real service-road crossings |
  | **Laguna Beach** | inspired by Laguna Beach's Main Beach (1.47 km): the coast highway through the village, a canyon climb past an art-festival field to a hairpin, the clifftop park above the ocean, a cove jump, tide-pool blowholes that spout through the road, shore-break waves washing over the beach road (the tide rises on laps 2–3), a jump beside the lifeguard tower and volleyballs spiked onto the road from the courts |
  | **Krishiv's Palace** | the castle finale (1.54 km): a drawbridge over a lava moat, torch-lit halls with crushing stone blocks, a gallery of swinging flame arms, the forge wing in a lava lake (conveyor belts that reverse every few seconds, lava curtains pouring across the road, a giant anvil with a trip hammer, the Lavafall Tunnel), a spiral climb, the ramparts, a leap into the throne hall, four lava geysers on the Geyser Stairs, iron chandeliers swinging across the Banquet Hall and two portcullis gates slamming down on the Portcullis Run |

  Every lap is 1.3–1.6 km (about 3 minutes for 3 laps at 100cc), with chicanes, esses,
  sweepers, at least one hairpin, hills, jumps, dash pads and lines of lire (coins).
  Aldrich Park and Laguna Beach are homages to real places (no logos, mascots or seals);
  Aldrich Park's paths, buildings, trees and hills come from OpenStreetMap and USGS
  elevation data (see Acknowledgments).
* **Set pieces in the road** (three per track, eight rooms of them in the palace; inspired
  by classic kart-racer courses, with original layouts and art). They run on a fixed
  rhythm, always warn first (a shadow, a bell, a horn, bubbling, a wave building offshore,
  a shrinking target ring) and always leave a line open; the CPU rivals see them coming too. Heavy things flatten you (stone blocks,
  cheese wheels, portcullis gates), crabs, cyclists, flame arms, lava curtains and geysers
  spin you out, scooters, beach balls, ducks, chandeliers, fountain jets and volleyballs
  bump you aside, and water (the tide surge, shore-break waves, blowholes, sprinklers)
  slows you down. A Rainbow Star or a Beer Rocket carries you straight through.
* **Music:** every track has its own synthesized theme (sunny pop on Breezy Bay, a
  tarantella on Monte Mozzarella, breezy indie on Aldrich Park, surf rock on Laguna Beach,
  dark organ rock in Krishiv's Palace), alternating with the recorded Claude Song; the final
  lap speeds up and adds layers.
* **Engine class 50cc / 100cc / 150cc** for both modes. It sets how fast everybody goes
  and how sharp the CPU rivals are (easy / normal / hard).
* **Twelve Brainrot racers**, led by **Tung Tung Tung Sahur**.
  See [the researched roster and visual references](docs/brainrot-roster.md).

  | Class | ID | Character | Group | Visual details |
  |---|---|---|---|---|
  | light | `ballerina` | Ballerina Cappuccina | L1 | Cappuccino-cup ballerina, pink tutu, pointe shoes. |
  | light | `cappuccino` | Cappuccino Assassino | L1 | Ninja coffee cup with a black headband and twin swords. |
  | light | `trippi` | Trippi Troppi | L2 | The tabby-cat and orange-shrimp version of Trippi Troppi. |
  | light | `chimpanzini` | Chimpanzini Bananini | L2 | Green chimpanzee peeking out of a peeled banana. |
  | medium | `sahur` | Tung Tung Tung Sahur **LEAD** | M2 | The wooden log with a face, bare limbs, and his signature bat. |
  | medium | `tralalero` | Tralalero Tralala | M2 | Three-legged shark with blue sneakers and a dorsal fin. |
  | medium | `bananita` | Bananita Dolfinita | M1 | A dolphin emerging from a bright yellow banana. |
  | medium | `lirili` | Lirili Larila | M1 | Cactus-elephant hybrid with a long trunk and sandals. |
  | heavy | `patapim` | Brr Brr Patapim | H1 | Forest monkey with a tree-trunk body, leafy crown, and big nose. |
  | heavy | `saturnita` | La Vaca Saturno Saturnita | H1 | Cow head on a ringed Saturn body. |
  | heavy | `bombardiro` | Bombardiro Crocodilo | H2 | Crocodile head fused to a twin-propeller bomber plane. |
  | heavy | `gusini` | Bombombini Gusini | H2 | White goose with an aircraft body, wings, and orange beak. |

  Light racers accelerate and turn quickly; heavy racers have top speed and shove
  lighter karts aside.
* **Kart parts:** six kart bodies and six sets of wheels. Every part trades one strength
  for another (Speed, Accel, Handling, Weight), and the phone shows the final stat bars
  before you pick. Mud Grippers barely slow down on grass.
* **Steer Assist** (on by default, per player): it gently keeps your kart on the road and
  turns it back toward the track if you spin, but it caps drift mini-turbos at orange.
  Switch it off on your phone's READY card (or in its ⚙ settings) for the full purple
  mini-turbo.
* **Phone steering with a lock**, like a real steering wheel: small tilts make small,
  precise corrections, the response eases off as you turn further, and past the lock
  angle tilting more adds nothing — a big twist can't over-swing the kart any more. When
  a drift ends (you let go, it cancels, or it hits a wall) the phone is usually still
  tilted hard into the corner: the kart doesn't snap into that turn, the steering blends
  back to your tilt over about half a second (or at once when you straighten up). The
  same goes for the keyboard and gamepad.
* Drift mini-turbos, rocket starts, tricks off ramps (press DRIFT in the air), boost
  pads, lire (coins) and forty items (below).
* **Custom racers:** drop your own `.glb` models into `public/characters/` (see below).

### Items

Drive through the rainbow **? boxes**. What you get depends on your place, as in the
classic kart racers: the leader mostly gets defensive items, the back of the pack gets
the big catch-up items (and a racer who falls far behind gets even better odds). Some
items are never handed out early in a race or while one is already out, so they stay
special. There are forty: an original equivalent of every distinct race item of the
classic kart racers (battle-only items and plain duplicates left out).

**The original seventeen**

| Item | What it does |
|---|---|
| 🍌 **Banana Peel** | drop it behind you; whoever drives over it spins out |
| 🍌 **Banana Bunch** | three peels trailing behind you (they also block shots from behind); drop one per press |
| 🟢 **Bouncer** | fire it forward: it bounces off walls and knocks over the first kart it hits |
| 🟢 **Triple Bouncers** | three bouncers circle your kart and block hits; fire one per press |
| 🚀 **Homing Rocket** | chases the racer just ahead of you |
| 🚀 **Triple Rockets** | three homing rockets circle your kart; fire one per press |
| 💨 **Toot Boost** | a quick (loud) boost |
| 💨 **Triple Toot** | three Toot Boosts |
| ✨ **Golden Toot** | as many boosts as you can press for about 7 seconds |
| 🦨 **Stink Bomb** | leaves a stinky cloud behind you |
| 💣 **Meatball Bomb** | throw it ahead: it blows up when someone comes close or the fuse runs out, and everyone in the blast is knocked over or spun |
| ⭐ **Rainbow Star** | invincible and faster for a while; ram the others out of the way |
| ⚡ **Zap Cloud** | shocks everybody ahead of you: they spin and slow down |
| ☕ **Espresso Splash** | splashes coffee over the screens of everybody ahead of you for a few seconds (a boost washes it off) |
| 🪗 **Accordion Blast** | a shockwave around you: spins nearby karts and wipes out nearby items — even an incoming Capo Crusher |
| 🧆 **Capo Crusher** | a winged, spiky golden meatball that flies along the track to whoever is **1st** and slams down on them (anyone in its way gets bowled over). The leader's screen and phone sound a siren; only an Accordion Blast — or a perfectly timed boost — saves you |
| 🍺 **Beer Rocket** | for the back of the pack: your racer chugs a giant foamy mug and rides it like a rocket on autopilot, invincible, knocking karts aside, until it has passed about five racers — then you pop out with a boost |

**Thrown, dropped and on the road**

| Item | What it does |
|---|---|
| 🌶️ **Peperoncino Blaster** | 8 seconds to fire up to 8 hopping chili fireballs (hold BRAKE to throw them backward); they bounce off walls and spin out whoever they hit |
| 🍧 **Granita Freeze** | three ice scoops circle your kart and block hits; press to fling them in a fan — a hit freezes the kart in an ice block and it slides helplessly for a moment |
| 🍕 **Flying Pizza** | three throws: the pizza flies about 35 m out and comes back to you, spinning out every kart on both legs (the slot greys out until you catch it) |
| 🪵 **Rolling Pins** | 5 seconds to lob up to 5 rolling pins that land ahead, knock karts over and stick in the road for a few seconds |
| 🐷 **Piggy Bank** | rolls down the middle of the road knocking over everyone in its path, drops lire as it goes and bursts into a ring of 8 lire |
| 🧀 **Parmesan Wheel** | a giant cheese wheel that bounces off the walls a dozen times and bowls over everything it touches |
| 🥚 **Surprise Egg** | homes in on the racer just ahead and knocks them over, then cracks into three item capsules anyone can grab |
| 🎁 **Prank Box** | a fake item box left behind you; up close it turns magenta and grins — too late |
| 🍨 **Banana Split** | a giant peel: a long spin-out, then it splits into three normal peels |
| 🍋 **Sour Lemon** | leave it on the road: whoever hits it shrinks for a few seconds (small, slow and easy to run over) |
| 🍳 **Padella Slam** | giant pans appear over everyone ahead — BONG, BONG, BONG — then slam: grounded karts spin and drop their item. Hop at the last beat to dodge it |
| 🥯 **Taralli Hoops** | three golden hoops on the road ahead; anyone who drives through gets a boost |
| 🧹 **Befana's Broom** | a kindly old folk witch flies past the racers ahead, covering them in soot (drift cancelled, items locked, a little slower) and dropping lumps of coal in front of the leaders |

**On your kart**

| Item | What it does |
|---|---|
| 🥟 **Chomping Calzone** | a hungry calzone on your bumper for 8 seconds: it lunges at karts, items and lire ahead and gobbles them up, a little burst of speed with every chomp |
| 🎭 **Ladro Mask** | turn into a see-through ghost for 4 seconds (nothing can touch you, grass doesn't slow you) and steal the item and 2 lire of a racer ahead |
| 🥔 **Hot Potato** | sticks to you at once: you're faster and grass can't slow you, but bump a rival to pass it on before it bursts — when it pops you shrink |
| 🍖 **Maxi Mortadella** | grow huge for 7.5 seconds: faster, immune to items, and you flatten every kart you drive into |
| 🤸 **Tarantella Jump** | a big leap over hazards and shots on the road (press DRIFT in the air for a trick boost) |
| 🥖 **Grissino Swipe** | a giant breadstick tail for 10 seconds: press to swipe round in a circle, spinning out karts, swatting items and grabbing lire; it also blocks one shot from behind |
| 🍽️ **Antipasto Platter** | eight items circle your kart (peel, bouncer, rocket, toot, star, espresso, bomb, purse); each press uses the one at the front, and a rival who touches one sets it off on themselves |
| 💕 **Amore Hearts** | two hearts circle you for 20 seconds; each absorbs one hit, and an absorbed item becomes yours if your slot is empty |
| 💰 **Lira Purse** | +2 lire |
| 🫙 **Tip Jar** | tap 6 times in 6 seconds: each tap gives you a lira and a nudge of speed, and spills lire behind for whoever follows |

**Lire (coins).** Lines of gold lire hover over every track and come back 12 seconds
after they are picked up. Hold up to **10**: each one adds **+0.5 % top speed** (+5 % at
ten) and every pickup gives a small nudge. You lose **2** when you are hit, **1** to a
light shot (chili, ice, pizza) and **3** when you fall off; lost lire scatter on the road
for others (you can't grab your own back for a second). Your count is on the HUD and the
phone (gold at 10). With Items Off the boxes go, the lire stay. CPU rivals on Normal and
Hard steer for them.

**Balancing.** Every item has a weight in each of the eight places (one table, every row
adds up to 100, built from the kart-racer series' own place-based odds): 1st mostly gets
peels, prank boxes, lemons, bouncers and purses; 2nd–3rd get rockets and the short-range
attacks (chili, pizza, egg, pins, ice); the middle gets the Padella, Calzone, Ladro,
Mortadella, Taralli and the rare Parmesan Wheel and Befana; the back keeps the Star, Golden
Toot, Beer Rocket and Triple Toots, now with the Mortadella and the Antipasto Platter.
Falling far behind shifts you further down the table. On top of that the strong items have
hard rules: none of them before 15–30 s into the race, only one or two in play at a time
(one Parmesan Wheel, Padella, Befana, Ladro, Hot Potato or Platter), cooldowns after the
Padella (20 s), the Befana (30 s) and the Hot Potato (15 s), and place gates (no Padella or
Befana for the top two, the Hot Potato only for 2nd–6th). A platter's star does not count
toward the two-stars-at-once limit. The headless race sim checks that every item turns up
and that nobody wins too often.

## Requirements

* **Node.js 22.12.0 or newer** and npm
* A desktop browser with WebGL: Chrome, Edge, Firefox or Safari
* One phone per player on the **same Wi-Fi network** as the computer (or play alone
  with the keyboard)

## Run it

```bash
git clone https://github.com/johrmohr/TTTKart.git
cd TTTKart
npm ci
npm start          # = node server.js
```

The server prints something like:

```
  Desktop game   http://localhost:3000
  Phone wheel    https://192.168.1.20:3443/pad?room=XXXX  (scan the QR code in the game)
```

The game opens in your default browser automatically. If it doesn't, open
**http://localhost:3000** yourself and put it on the biggest screen you have. Click or
press any key once so the browser allows sound.

| Environment variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port (desktop game) |
| `HTTPS_PORT` | `3443` | HTTPS port (phone controller; motion sensors need HTTPS) |
| `NO_OPEN=1` | off | don't open the browser on start |
| `PAD_HOST` | auto | force the host/IP put in the phone URL + QR code (e.g. when several networks are up) |

Add `?quality=low` to the game URL (`http://localhost:3000/?quality=low`) on slow laptops.

## Play with phones (1–4 players)

1. Start the game. The **lobby** shows a big QR code, the phone address under it and
   four player panels.
2. Every player scans the QR code with their phone's camera app. It opens
   `https://<your-computer-ip>:3443/pad?room=ABCD`.
3. **Certificate warning:** the local server uses a self-signed HTTPS certificate
   because phone motion sensors require HTTPS. Check the address matches the computer
   running the game, then continue past the warning:
   * **iPhone (Safari):** *Show Details* → *visit this website* → *Visit Website*
   * **Android (Chrome):** *Advanced* → *Proceed to … (unsafe)*
4. Tap **Tap to start**. On iPhone, allow **Motion & Orientation** when asked.
5. Phones become **P1, P2, P3, P4** in the order they join, each with its own color.
   **P1 is the host** (the crown on the screen): the host picks the mode, the engine
   class and the track. If the host leaves, the next player takes over.

**How a session goes**

* **Lobby:** the host chooses *Grand Prix* or *VS Race* and *50 / 100 / 150cc* (and
  items on/off for VS), then taps **START**.
* **Choose your racer** on your own phone, at your own pace: racer → kart body →
  wheels → the READY card (Steer Assist and Auto-Gas switches, then **READY**). The big
  screen shows everyone's choice and who is ready.
* When everybody is ready the host gets the **track screen**: in a Grand Prix the cup
  cards (Gelato Cup or Krishiv Cup — tap one to choose), in VS the five track tiles (or
  Random). The big screen shows the choice. Tap **GO**.
* **Race!** Results and standings follow each race; the host taps **NEXT** (or LOBBY).
  After the last race of the cup the top three climb the podium.

**During a race**

* Anyone can pause from their phone (⏸) or with **Esc** on the computer; anyone can
  resume. Only the host can restart or quit to the lobby.
* If a phone locks, takes a call or loses Wi-Fi, a CPU keeps driving that player's kart
  (and it keeps scoring) until the phone is back — the race doesn't stop for everyone.
  Playing alone, the race pauses instead.
* When the first player finishes, the others have **30 seconds** to cross the line;
  anyone still racing then is placed by their position on the track.
* Players who join mid-race watch and join from the next race (from the back of the grid).
  A player whose phone disconnects keeps their slot; after 20 seconds in the menus it is
  freed for somebody else.

Press **Center** on the phone any time to re-calibrate "straight ahead" (it also
happens at every countdown). The phone's ⚙ settings have steering sensitivity,
**Auto-Gas**, **Steer Assist** and invert steering.

If you can't scan the code, open the URL shown under the QR code, or go to
`https://<computer-ip>:3443/pad` and type the 4-letter room code.

### Play alone with the keyboard

With no phone connected, press **Enter** on the lobby: you become P1 on the keyboard
(or a gamepad) and make the same choices on the big screen — arrows to browse (← → also
switch the cup on the Grand Prix screen), Enter to pick, Esc to go back. Keyboard mode
ends as soon as a phone joins (that phone becomes P1).

### macOS firewall prompt

The first time you run `node server.js`, macOS may ask *"Do you want the application
"node" to accept incoming network connections?"* Click **Allow**, or the phones can't
reach the computer. If you clicked *Deny* by mistake, go to **System Settings → Network →
Firewall → Options…** and set `node` to *Allow incoming connections*.

## Controls

| Action | Phone | Keyboard (solo) | Gamepad (solo) |
|---|---|---|---|
| Steer | turn the phone like a wheel | ← → or A D | left stick / d-pad |
| Gas | GAS (right thumb) or Auto-Gas | ↑ or W | A / RT |
| Brake / reverse | BRAKE (right thumb) | ↓ or S | B / LT |
| Hop & drift (hold) · trick in the air | DRIFT (left thumb) | Space or Shift | RB or X |
| Use item | ITEM (left thumb) | X, E or Z | LB or Y |
| Look back | | C | R3 / right stick down |
| Pause | ⏸ | Esc or P | Start |
| Menus | buttons on the phone | arrows + Enter, Esc = back | d-pad + A / B |
| Mute · help | | M · H | |

**Racing tips**

* **Rocket start:** press gas just before **GO!**. Too early and the engine stalls.
* **Drift mini-turbo:** hold drift and tilt into the corner; the drift picks its side
  when the hop lands. While drifting, the wheel only makes the arc tighter or wider:
  hold the phone about level for a normal corner, lean in for a hairpin, lean out to
  open the arc. Leaning in charges faster: the sparks turn **blue → orange → purple**
  (purple needs Steer Assist off). Let go for a boost. A drift lets go by itself if it
  hits a wall or turns too far round.
* **Trick:** press DRIFT while flying off a ramp for a little boost on landing.
* Drive through the rainbow **? boxes** for items (see the table above). Leading? Hold on
  to an Accordion Blast: it is the one answer to a Capo Crusher. Coffee on your screen?
  Any Toot or boost pad washes it off.
* **Lire** are worth chasing: ten of them make you about 5 % faster, and every hit costs
  you two. Watch the set pieces' warnings (and listen: bells, horns, bubbling) and take the
  open line.
* Your phone buzzes for hits, item pickups, laps and the finish, sounds a siren when a
  Capo Crusher is after you, and shows **AUTOPILOT** while you ride a Beer Rocket.

## Custom racers (.glb)

You can race your own 3D models. Put the `.glb` files in `public/characters/` and list
them in `public/characters/index.json`:

```json
[
  { "id": "robo_dino", "name": "Robo Dino", "file": "robo-dino.glb",
    "weightClass": "heavy", "color": "#3fa34d", "scale": 1, "yOffset": 0, "rotationY": 0 }
]
```

* `id`: lowercase letters, digits, `-` or `_` (unique); `name`: shown on the phones.
* `weightClass`: `light`, `medium` or `heavy` (sets the base stats); `color`: the kart
  paint and card color.
* Optional `scale`, `yOffset` (meters) and `rotationY` (radians) fine-tune the fit. Models
  are scaled to sit about 1 m tall in the seat, centered and facing forward (+Z).

Restart the page: custom racers appear in a **Custom** row on the phones (never as CPU
rivals). A file that is missing or broken is skipped with a warning in the browser console.
The repository ships an empty list — please only add models you are allowed to use.

## Troubleshooting

| Problem | Fix |
|---|---|
| Phone page won't load | The phone must be on the **same Wi-Fi** as the computer (no guest network or "client isolation"). Allow `node` in the macOS firewall (see above). Check the IP in the URL matches the computer. With several networks (VPN, Ethernet + Wi-Fi), restart with `PAD_HOST=<right-ip> npm start`. |
| "Your connection is not private" | The local phone server uses a self-signed certificate. Check that the address matches your computer, then follow step 3 above. |
| "This game is full" | Four phones are already in. A phone that left keeps its slot for a while; it is freed after 20 seconds in the menus. |
| Steering doesn't react on iPhone | Reload the pad page, tap **Tap to start**, and allow Motion & Orientation. If you tapped *Don't Allow*, iOS remembers it until Safari restarts: close Safari completely, or Settings → Safari → Advanced → Website Data → remove the site, then reload. Meanwhile the pad steers with a touch slider. |
| My kart keeps hitting walls | Keep **Steer Assist** on (READY card / ⚙). Lower the sensitivity or press **Center** while holding the phone level. |
| Steering is reversed / too twitchy | Use the phone's ⚙ settings: *Invert steering* and *Sensitivity*. |
| No sound | Click the page or press a key once (browsers block audio until you interact). Check the 🔊 button / **M** key. |
| Game is choppy | Close other heavy tabs, make sure hardware acceleration is on, or use `?quality=low`. Split-screen already switches to lighter scenery. |
| Phone shows "waiting for game" | The desktop tab was closed or reloaded. Open http://localhost:3000 again in the same browser. If the room has expired, scan the new QR code. |
| Port already in use | Another copy is running, or another program uses the port. Stop it, or start with `PORT=3100 HTTPS_PORT=3543 npm start`. |
| Certificate problems after changing networks | On a different network the certificate is replaced, and the phones must reload the pad page and accept the warning once more. To force a new one, delete the `.certs/` folder and restart. |

## Project layout

```
server.js            express + socket.io: HTTP (game) + HTTPS (phones), rooms, player slots, QR codes
public/index.html    desktop game page        public/pad.html   phone controller page
public/characters/   custom .glb racers + index.json
public/js/
  main.js            boot, session flow (lobby → select → cup / track → race → results → podium),
                     split-screen rendering, track hazards, item feedback, phone sync
  menus.js hud.js    big-screen menus + keyboard-mode pickers, per-view HUDs + shared minimap
  parts.js           kart bodies, wheels, stat math, engine classes, player slots, GP points
  tracks.js          track registry + the cups (Gelato Cup, Krishiv Cup)
  hazards.js hazards/  course set pieces, one module per track theme (bay, hilltown, campus, beach,
                     castle); node-safe and deterministic, shared by the game, the CPUs and the sim
  race.js items.js ai.js          race rules, items, CPU drivers (node-safe)
  items/             the v5 items, one plugin module each (registry.js, context.js helpers), + coins.js (lire)
  kart.js kartview.js characters.js camera.js effects.js   karts, models, chase cameras, particles
  track.js track-def*.js worlds.js world*.js textures.js    the circuits and their scenery
  audio.js input.js net.js pad.js                           synth audio + music, input, phone link, phone page
  config.js bus.js utils.js                                 shared tuning, event bus, helpers
tools/               headless tests (see below)
SPEC.md              module contracts
```

## Tests and dev tools

Run the core physics and race-rule checks with `npm test`. For more targeted checks:

```bash
node tools/sim.mjs --all              # headless 8-CPU race simulation matrix (every track and class, all 40 items,
                                      # set pieces, lire, win-rate fairness; --track <id>, --no-hazards to compare)
node tools/kart-test.mjs              # kart physics checks
node tools/race-logic-test.mjs        # race + item rules (incl. race-logic-items-a / -b: every v5 item and the lire)
node tools/test-net.mjs               # server / socket protocol (slots, host, padState)
node tools/pad-test.mjs               # phone controller page (headless Chrome)
node tools/integration-test.mjs       # lobby, 1–4 fake phones, host rules, picks, split-screen layouts, keyboard mode
node tools/integration-race-test.mjs  # both cups + podium, VS on every new track, palace hazards, item cues,
                                      # CPU stand-ins, finish clock, leaks + perf (--quick, --only ABFGCDE)
node tools/track-check.mjs            # track sanity: length, radii, widths, features, fair set-piece timing
                                      # (--track breezy | monte | aldrich | laguna | palace)
node tools/steer-probe.mjs            # casual tilt drivers: wall hits with Steer Assist on / off (every track)
node tools/drift-probe.mjs            # phone / keyboard drifters: over-rotation, spins, mini-turbos (--help)
node tools/render-portraits.mjs       # re-render the racer portraits in public/img/racers/
```

Run the server and browser test scripts one at a time; some use the same ports.
The browser tests need Google Chrome installed at the default macOS location (they use
`puppeteer-core`). In the browser console, `window.__game` has debug helpers such as
`__game.kbJoin()`, `__game.action(1, 'start')`, `__game.action(1, 'cup', { id: 'krishiv' })`,
`__game.skipIntro()`, `__game.autopilot(true)`, `__game.setTimeScale(4)`, `__game.hazards`
and `__game.stats()`.

## Contributing

Bug reports, gameplay feedback, and focused pull requests are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and submission guidance.
Suggestions and playtest feedback are welcome in
[GitHub issues](https://github.com/johrmohr/TTTKart/issues).

## License

TTTKart is released under the [ISC license](LICENSE). Dependencies retain their own licenses.

## Acknowledgments

Built with Three.js, Express, Socket.IO, qrcode, and selfsigned. Browser checks use
Puppeteer Core. The interface loads Fredoka, Lilita One, and Nunito from Google
Fonts; those fonts remain under their respective licenses.

Aldrich Park map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
available under the Open Database License (ODbL); elevation: USGS 3DEP (public domain).
The park and Laguna Beach are depicted as places only: no university or business logos,
mascots or seals.

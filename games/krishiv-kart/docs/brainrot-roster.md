# Brainrot roster

Researched October 18, 2026. Tung Tung Tung Sahur is the lead/default on desktop and phone. These are procedural, stylized 3D racing adaptations, not photorealistic replicas.

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

## Selection and references

The roster favors established, widely recognizable characters appearing across the sources below. There is no authoritative cross-platform popularity ranking; this is a curated popular cast, not a claimed numerical top twelve. Trippi Troppi uses the cat–shrimp version rather than the alternative fish–bear design. Bombardiro is also commonly spelled Bombardino.

- [Wikipedia: Italian brainrot](https://en.wikipedia.org/wiki/Italian_brainrot): origins, character anatomy, spelling and variant cross-checks, and reference images for the original cast.
- [Original character collage](https://upload.wikimedia.org/wikipedia/commons/d/df/Italian_brainrot_characters.png): visually checked Sahur, Tralalero, Patapim, and Bombardiro.
- [Brainrot Characters roster](https://brainrotcharacters.net/all-brainrot-characters/): cross-checks for the banana dolphin, Saturn cow, goose plane, cat-shrimp, and other established characters. The site's community additions and invented clan lore were not used.
- [OpusClip 2026 cultural-impact list](https://www.opus.pro/blog/ai-brainrot-characters-ranked-2026): secondary popularity signal only; anatomy was cross-checked because descriptions vary.

## Game integration

All 12 replace the previous built-in roster; their weight-group slots, kart-part ratings, and CPU driving profiles are retained. The shared models power races and desktop previews; the generated PNG portraits power phone and desktop cards. Unknown or stale character IDs fall back to Sahur. Custom GLB loading remains supported.

The bat and ninja swords are visual props. Catchphrases use character names. No external audio or remote images are required at runtime. Driver primitives share merged geometry and the existing material/cache/LOD pipeline.

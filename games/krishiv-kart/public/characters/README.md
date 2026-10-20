# Custom racers (.glb)

Drop your own 3D racers here and they show up in a **Custom** row on the phones
(humans only, never CPUs). The desktop loads them at boot.

1. Put the model next to this file, e.g. `public/characters/robo.glb`
   (glTF binary; one model per file; no textures outside the .glb).
2. List it in `index.json`:

```json
[
  { "id": "robo", "name": "Robo Rex", "file": "robo.glb", "weightClass": "heavy",
    "color": "#3fd6b2", "scale": 1, "yOffset": 0, "rotationY": 0 }
]
```

* `id` — lowercase letters, digits, `_` or `-` (max 32); must not clash with a built-in racer.
* `weightClass` — `light`, `medium` or `heavy` (sets the stats).
* `color` — the kart paint and card color.
* `scale`, `yOffset` (m), `rotationY` (radians) — optional fine-tuning. Models are
  scaled to about 1 m tall, centered on the seat and should face +Z (forward);
  use `rotationY: 3.14159` if yours sits backwards.

Broken or missing files are skipped with a console warning. Only use models
you made yourself or are allowed to use.

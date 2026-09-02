# Style register, measured — Revolution of Rags B01-S3

2026-09-02. `google/gemini-2.5-flash-image` via OpenRouter, 16:9, seed 7, one
take each. Sheet: `revolution-B01-S3.jpg` (a, b, c left to right).

## What the judge's agent wrote

```
The chamber doors burst inward while flour dust and pamphlets billow through
the aisle. Subject: the Bourgeois Nose-Wipers Union entering in matching
tricolor waistcoats and enormous kerchiefs. Dynamic wide composition, comic
hand-painted 2D anime, cinematic anime film still
```

negative: `readable text, watermark, extra limbs, photorealistic, 3D render,
modern clothing, gore` — which, before this change, `http_images.py` dropped on
the floor. Chat-completion image models have no negative field, and the adapter
had nowhere to put it, so none of those seven words ever reached Gemini.

## What the register sends now

```
Cinematic anime film still, 1990s TV anime cel look: clean ink outlines, flat
cel shading, restrained palette, soft film grain, no painterly brushwork. The
chamber doors burst inward while flour dust and pamphlets billow through the
aisle. Subject: the Bourgeois Nose-Wipers Union entering in matching tricolor
waistcoats and enormous kerchiefs. Dynamic wide composition, anime, cinematic
anime film still Avoid: readable text, watermark, extra limbs, photorealistic,
3d render, modern clothing, gore, text, lettering, signage, caption,
photograph, cgi, western cartoon, caricature, painterly, chibi, moe, sparkling
eyes.
```

`hand-painted` and `comic` were stripped out of the middle; the shot itself —
setting, subject, framing — is untouched. The shot's own negative leads the
merged `Avoid:` list, then the register's, deduplicated.

## The delta

**a → b is the whole failure.** In (a) the faces are caricature: bulbous noses,
lumpy jaws, the rubbery western-satire drawing the judge saw, over a soft
painterly hall. In (b) the faces are anime faces with clean ink outlines, the
shading is flat cel, and the palette collapses to three colours holding the
frame. Same model, same seed, same shot. Two words of style vocabulary in the
middle of the prompt were the difference between an anime film and a political
cartoon.

**b → c is register discipline, and it overshoots.** The reference frames pull
hard on lighting: (c) goes to near-black with one warm key from the doorway,
because all three shipped frames from *Two Claudes* are night interiors. Line
and palette control are the best of the three and the costumes finally read as
one design, but the film loses the daylight the script asked for, and the faces
stop being individuals. Refs are the right default for a film with the *Two
Claudes* register and the wrong one for a daylight comedy — which is what the
per-backend `style_refs` switch and `set_style {refs: []}` are for.

Text in frame survives all three: the pamphlets carry glyph marks even with
`text, lettering, caption` in the negative. Gemini treats a folded negative as
a preference, not a constraint. Getting that to zero needs it out of the
subject, not out of the negative.

## Cost

Measured from OpenRouter's own `usage` block (now recorded on every take):

| | prompt tokens | cost |
|---|---|---|
| register, no refs | 138 | $0.038741 |
| register + 3 refs (512 px JPEG) | 935 | $0.038983 |

**+797 input tokens, +$0.00024 per still — 0.62%.** Reference conditioning is
free in practice; the reason to turn it off is that it changes the picture, not
that it costs anything.

Whole experiment: 5 stills, about $0.19.

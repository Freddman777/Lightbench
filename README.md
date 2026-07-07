# The Light Bench

**A miniature-painting planner for light, color, and layering.**

The Light Bench helps you plan how to paint a miniature *before* you pick up the brush or airbrush. You set a light direction, build a color scheme, and a **3D figure you can rotate with your finger or mouse** shows you exactly where the highlights and shadows fall and what color goes where — on a realistic study figure, or on **your own model imported from an STL/OBJ file**.

It is a **teaching tool, not a photo of your exact model**. The point is reading the *planes* — which surfaces face the light — and applying that thinking to anything on your table.

---

## Getting started

- **Double-click `index.html`** — it runs in any browser, fully offline, no install needed.
- Or, if it's hosted on the web, **install it as an app**: on desktop Chrome/Edge click the install icon in the address bar; on Android use the install banner; on iPhone/iPad use Safari's Share → *Add to Home Screen*. Installed, it works offline and opens fullscreen like a native app.

Your saved schemes stay in that browser (see **Recipes** below for moving them between devices).

---

## The bench

You open straight onto the **study figure** — a realistic human figure, decimated to clean planes. Drag to rotate, pinch or scroll to zoom (shift-drag pans on desktop). The **faceted / smooth** button switches between plane-reading facets and smooth shading.

**Import STL** loads your own model instead: pick a detail level (Standard/High/Ultra simplify the mesh so planes read clearly; **Full** renders the actual file on the GPU, up to ~500k faces), and it becomes "**Your model**" — switchable with the study figure at any time. The import is remembered, including any materials you paint onto it.

## Brush or airbrush?

The **Airbrush** chip at the top sets which *workflow* the app coaches you through — it doesn't change the figure or colors, just the advice. In airbrush mode every step's notes switch to spray logic (thinning, PSI, distance, angle, and the airbrush-specific failure modes), and the **Spray cone** section unlocks: your light direction becomes the nozzle, and the figure shows *coverage* — which planes the spray actually hits — instead of value. Planes facing away stay bare primer; that hard cutoff is the lesson the soft light model can't teach.

## Colors & materials

Every material on the mini (skin, cloak, armor…) gets its own color scheme, all shaded by the same light. **Paint zones on the model** lets you assign faces directly — tap to grab a whole smooth patch, or brush over faces, with mirror mode and Ctrl+Z undo. The **matte / steel / gold** toggle turns any material into NMM (non-metallic metal) shading, with its compressed midtones and specular ping.

Pick a base color and 3–5 value steps and the tool builds the ladder using the rule real painters use: **highlights get lighter and warmer, shadows darker and cooler**. Tap any swatch to match a paint you own.

## Light

Orbit, height, and intensity sliders aim a single light; presets jump to Zenithal/Front/Left/Right/Back. The **Light direction** chip turns directional light off entirely to preview a flat paint scheme. **Zenithal underpainting** adds the sprayed-light-map step after priming. Extras add a cool **rim light** and an **object-source glow** (OSL) — a second colored light for power weapons, gems, glowing eyes.

## Wheel & cohesion

Your ramp is plotted on a color wheel so you can see its hue drift. Tap the wheel to set your base hue; tap a suggestion card (Complementary, Analogous, Triadic) or an accent dot on the wheel to preview that accent glazed into the shadow tiers on the model itself — the classic "opposite color in the shadows" trick before committing.

## Glaze preview

A thin wash over whatever's shown — unifying over paint, slapchop over the zenithal step. Pick the glaze color and strength; it thins on the lit tops and pools in the recesses, the way thin coats really behave. The "· glaze" tag under the figure shows when it's active.

## Real paints

Every color in your scheme is matched to the nearest real hobby paint (Citadel, Vallejo, Army Painter — filterable) by color distance, with an honesty rating from "spot on" to "mix to match". It's a shopping list, not gospel: start from that pot and adjust.

## Steps

The real painting order — Prime (your primer color), optional Zenithal, Base coats, then Shade / Highlights (when the light is on), Details & accents, Varnish. Tap a step and the figure *isolates* where it goes, with a note and a **"Watch for:"** warning of that stage's classic mistake. Check steps off as you go; notes rewrite themselves for brush or airbrush.

## Recipes (save / load)

Name a scheme and **Save**. It remembers colors, light, glaze, method, spray, glow/rim — everything except which model it's on, so one scheme works on any figure. **Export recipes** downloads them all as a JSON file and **Import recipes** merges them back in — that's how schemes move between your phone and desktop. Your whole session (model, step, materials painted onto the figure) also restores automatically next time you open the app.

**Export PNG** produces a reference card — the figure as shown, the value ramp, the paint shopping list, accents, and light settings — to take to the bench. On phones it opens the share sheet.

---

## How you'd use it — a worked example

**Goal:** plan a green-skinned orc, lit from above, with warm highlights and richer shadows than plain dark green.

1. **Set the light.** Tap the *Zenithal* preset. Rotate the figure and watch tops brighten while the jaw, neck, and undersides fall into shadow. That's your light map.
2. **Build the color.** Set the base to a mid green, 5 steps. The tool fills in a cool dark shadow, your base, warmer mids, and a pale warm highlight. Rotate to see the highlight sit on the brow, shoulders, and chest planes.
3. **Check the wheel.** Your greens drift toward yellow as they lighten — the warm-highlight rule working. Tap the *Complementary* card and watch that red glaze into the shadow tiers on the model: that's your shadow accent planned.
4. **Add a material.** *Add material*, name it "Cloak", pick a color, then *Paint zones on the model* and tap the areas it covers. Both materials now shade under the same light.
5. **Walk the steps.** Tap through Prime → Base coats → Shade → Highlight. Each step isolates its own territory and warns you about its classic mistake.
6. **Save and take it to the bench.** Save as "Orc Flesh", then *Export PNG* for a reference card with the ramp and the nearest real paints to buy.

---

## Glossary

| Term | Meaning |
|------|---------|
| **Zenithal** | Lighting/priming from straight above; pre-shades the model. |
| **Base coat** | The main midtone color over everything. |
| **Shade** | Darker color pushed into the recesses (the valleys). |
| **Highlight** | Lighter color on the top planes that face the light. |
| **Edge highlight** | Hairline lines on the hardest edges catching the light (5-step ramps). |
| **Glaze** | A thin, see-through layer of color over what's already there. |
| **NMM** | Non-metallic metal: matte paint imitating metal's compressed midtones and specular ping. |
| **OSL** | Object-source lighting: a glow cast by something on the model (gem, blade, eyes). |
| **Rim light** | A second, usually cooler light from behind/beside that outlines the form. |
| **Recess** | A valley or crevice on the model (where shadow gathers). |
| **Accent** | A small contrasting color used sparingly for interest. |
| **Complementary** | The color opposite yours on the wheel; great in shadows. |
| **Spray cone** | The airbrush's spray, aimed like the light; shows where paint lands rather than where light falls. |
| **Coverage** | Which planes a spray pass actually hits. Planes facing away from the nozzle stay bare. |
| **Tip-dry** | Paint drying on the needle tip and spitting specks into a pass; clear it and thin the mix. |

---

## For developers

`light-bench.jsx` is the source of truth; `npm install && npm run build` produces the self-contained `index.html` plus the PWA files (`sw.js`, `manifest.json`, `icons/`). See `AGENT-HANDOFF.md` for the full engineering handbook.

# The Light Bench

**A miniature-painting planner for light, color, and layering.**

The Light Bench helps you plan how to paint a miniature *before* you pick up the airbrush. You set a light direction, build a color scheme, and the tool shows you — from four angles at once — exactly where the highlights and shadows fall and what color goes where.

It is a **teaching tool, not a photo of your exact model**. The figures are kept simple and blocky on purpose, so you can read the *planes* (which surfaces face the light) and apply that thinking to any miniature on your table.

---

## Getting started

Just **double-click the `.html` file** — it runs in any web browser, with no internet needed. Your saved schemes stay in that browser on that computer.

---

## The sections, one by one

### 1. Choose a model
When you open the app you pick what you're painting — a **Bust** or a **Standing figure**. This just decides which shape you see. Everything else works the same on any model, and a color scheme you build carries over between them. Once you're in, a small **"Model: … · change"** button up top lets you switch without losing your colors.

### 2. The four views
This is the *output*, not a control. You see the model from the **front, both sides, and the back** at the same time. As you change the light or the colors, all four update together — so you can see that lighting the front means the back falls into shadow. On a computer the figure stays put while the controls scroll; on a phone it sits on top.

### 3. Light direction
Two sliders aim a single light:

- **Orbit** — move the light around the figure (front / side / back)
- **Height** — raise it overhead or drop it low

Push Height all the way up for a **zenithal** light (straight down): tops bright, undersides dark. Quick buttons (Zenithal, Front, Left, Right, Back) jump to common setups.

> Answers the question: **where does light land?**

### 4. Recipe (your colors)
Pick a base color and how many steps you want (3, 4, or 5). The tool builds the full ladder — shadow, base, midtone(s), highlight — using the rule real painters use: **highlights get lighter and warmer** (toward yellow), **shadows get darker and cooler** (toward blue). That warm-to-cool shift is what makes paint look lit instead of flat.

- Tap any swatch to change just that color (to match a paint you own).
- **Auto-generate** rebuilds the ladder from your base.

The light decides *which* band a surface is in; the recipe decides what *color* that band is.

### 5. Paint behavior (opaque vs. glaze)
A switch between two ways paint can sit on the model:

- **Opaque** — each surface is one solid color. Simple and clear.
- **Glaze** — see-through layers that stack, so the color underneath shows through, the way thin coats really behave.

When Glaze is on you get:

- **Recess pooling** — how much the glaze thins out on the bright tops and gathers in the recesses. Turn it up to make shadows show the underlayer coming through (a thin green over red reading as a warm shadow, for example). Turn it down for an even coat.
- **Layers (2–5)** — each with its own opacity slider and color. Lower opacity = more of the layer below shows through. **"Colors from recipe"** resets the layer colors to your current scheme.

> **Note:** Glaze only changes the *paint* steps. The Prime (black) and Zenithal (grey) steps stay as they are, because those happen *before* any glaze. The little **"· glaze"** tag under the figure tells you when it's active.

### 6. Wheel & cohesion
Your color ladder is plotted on a color wheel so you can see its hue drift. Two separate actions, both labeled in the app:

- **Tap the wheel** — set your base color (rebuilds the ladder)
- **Tap a card** — pin a suggested accent color (it gets a gold ring)

The suggestions (Complementary, Analogous, Triadic) are computed from your base to help the model stay cohesive. Below them, a small preview figure shows your chosen accent glazed into the shadow recesses — so you can see the classic "opposite color in the shadows" trick before committing.

> Answers the question: **do my colors work together?**

### 7. Steps
The real-world painting order: **Prime → Zenithal → Base → Shade → Highlights → Details → Varnish.** Tap any step and the figure *isolates* where that step goes (everything else dims), with a short note and a **"Watch for:"** warning of the common mistake at that stage. Check off steps as you finish.

### 8. Recipes (save / load)
Name a scheme and **Save** it. It remembers your colors, light position, glaze settings, and checklist, and survives closing the browser. Schemes are independent of the model, so the same one works on a bust or a full figure.

> Saved per browser, per computer — they won't follow you to another device.

---

## How you'd use it — a worked example

**Goal:** plan a green-skinned orc **bust**, lit from above, with warm highlights and a richer shadow than a plain dark green.

1. **Pick the model.** Open the app, click *Bust*. You now see the bust from four sides.

2. **Set the light.** Click the *Zenithal* preset (or push Height to the top). Watch the tops of the head, shoulders, and chest brighten while the underside of the chin, the neck, and the lower chest fall into shadow. That's your light map.

3. **Build the color.** In Recipe, set the base to a mid green. Choose 5 steps. The tool fills in a dark cool-green shadow, your green base, two lighter/warmer mids, and a pale warm highlight. Glance at the four views — the highlight color should be sitting on the brow, cheekbones, and shoulder tops.

4. **Check it on the wheel.** Open Wheel & Cohesion. See your greens drift slightly toward yellow as they lighten — that's the warm-highlight rule working. Tap the *Complementary* card (a red/magenta) to pin it as an accent, and look at the small preview: a touch of that opposite color in the deepest recesses makes the green read richer. That's your shadow accent planned.

5. **Try glaze layering.** In Paint Behavior, flip the toggle to *Glaze*. Switch to the *Highlight* step (so you're looking at paint, not the grey zenithal). Now slide **Recess pooling** up and down: at higher pooling, the glaze thins on the lit tops and builds in the recesses, so the shadows deepen and warm while the highlights stay clean. This is the same effect as brushing a thin green over a warmer base and letting it pool in the cracks. Set the layer opacities until the shadows look right to you.

6. **Walk the steps.** Open Steps and tap through them in order. On *Shade*, the figure shows only the recesses — that's where your shadow color (and that complementary accent) goes. On *Highlight*, only the top planes light up — that's where the pale warm green goes. Read each *Watch for:* note so you avoid the common mistake before you make it for real.

7. **Save it.** In Recipes, name it "Orc Flesh" and Save. Next time you open the app it's there — and you can load it onto the Standing figure too if you paint a full orc later.

Now you have a plan: which light, which colors in which order, where each one goes, and how the shadows should behave — all before opening a single pot.

---

## Glossary

| Term | Meaning |
|------|---------|
| **Zenithal** | Lighting/priming from straight above; pre-shades the model. |
| **Base coat** | The main midtone color over everything. |
| **Shade** | Darker color pushed into the recesses (the valleys). |
| **Highlight** | Lighter color on the top planes that face the light. |
| **Glaze** | A thin, see-through layer of color over what's already there. |
| **Recess** | A valley or crevice on the model (where shadow gathers). |
| **Accent** | A small contrasting color used sparingly for interest. |
| **Complementary** | The color opposite yours on the wheel; great in shadows. |

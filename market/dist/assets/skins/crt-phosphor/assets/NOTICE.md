# Notices - crt-phosphor

## Artwork

Every raster asset under `assets/` is AI-generated and then processed locally.

- Model / pipeline: `volcengine/doubao-seedream-5.0-pro` through the OFOX image API, then local post-processing
  (scenes: a phosphor duotone pass with halation, then baked scanlines, a vignette and grain; portraits: chroma-key matting (key estimation, alpha ramp, unmix, despill, alpha floor, connected-component despeckle)).
- No photograph, cosplay image, or other third-party picture was used as model input;
  the character was described in text.

- Portraits: the **same matted assets** as the `lucy-nightsignal` skin in this
  repository (same author, same submission, same pipeline), so the two skins carry
  identical provenance terms.
- Backgrounds: this project's own AI-generated night city, locally processed into a
  phosphor duotone.
- Bundled typeface: **Fusion Pixel Font**, OFL-1.1 - see `assets/FUSION-PIXEL-OFL.txt`
  and `assets/licenses/`. The font keeps its own licence.

## Character and rights

- Depicted character: **Lucy / Lucyna Kushinada** from **Cyberpunk: Edgerunners**.
- Rights holders: **Studio TRIGGER** and **CD PROJEKT RED** (with their respective
  licensors and successors).
- **Personal, non-commercial use only.** Unofficial fan artwork: not affiliated with,
  endorsed by, sponsored by, or licensed from the rights holders above, the
  maintainers of this repository, or the DeepSeek Harness project.
- All rights to the character and the source work remain with their rights holders.
  If a rights holder objects, this skin should be removed.

## Licence

The skin's own files (`skin.json`, `skin.css`, `patches.css`, and `hooks.mjs` where
present) are released under **CC BY-NC-SA 4.0** (see the repository `LICENSE`); that
covers only the parts authored here and grants no rights to the character or the
source work.

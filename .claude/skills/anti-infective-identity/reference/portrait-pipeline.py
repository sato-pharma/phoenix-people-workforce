# -*- coding: utf-8 -*-
"""
The portrait law for the Anti-Infective identity.

A guest list arrives as whatever people happen to have: a studio headshot, a
beach candid, a wedding table, a phone crop of a phone crop. What makes ten of
those read as ONE set is not retouching each one - it is putting every face
through the same geometry and the same single-ink grade, so the differences that
remain are the people rather than the cameras.

    crop   4:5, the frame 2.35x the brow-to-chin height, eyes on 0.405
    grade  grey-world white balance -> percentile normalise -> duotone regrade
    rescue widen() for a frame too tight to hold its own head
           highlight_knee() for a source that arrived already blown out

Nothing here invents a face. widen() paints wall and air only; the knee compresses
a highlight that was clipped before the file ever reached us.

Dependencies: numpy, opencv-python, pillow.
"""
import numpy as np
from PIL import Image, ImageFilter

# ---- the crop law -----------------------------------------------------------
AR = 4 / 5.0          # every portrait is 4:5
HEAD = 2.35           # frame height = 2.35x the brow-to-chin height
EYE_Y = 0.405         # the eye line sits 40.5% down the frame
OUT_W, OUT_H = 1180, 1475

# ---- the single ink ---------------------------------------------------------
SHADOW = (0x03, 0x0e, 0x30)      # the navy the field is cut from
LIGHT = (0xff, 0xff, 0xff)


def grey_world(pil, strength=0.85):
    """Pull ten different light sources toward one neutral."""
    a = np.asarray(pil).astype(np.float32)
    lum = a.mean(axis=2)
    m = (lum > 40) & (lum < 225)
    if m.sum() < 500:
        m = np.ones_like(lum, bool)
    means = np.array([a[..., c][m].mean() for c in range(3)])
    gain = np.clip(means.mean() / np.maximum(means, 1e-3), 0.70, 1.45)
    return Image.fromarray(np.clip(a * (1.0 + (gain - 1.0) * strength), 0, 255).astype(np.uint8))


def normalise(pil):
    from PIL import ImageEnhance
    a = np.asarray(pil).astype(np.float32)
    lum = 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]
    lo, hi = np.percentile(lum, 1.0), np.percentile(lum, 99.0)
    if hi - lo > 20:
        a = (a - lo) * (248.0 / (hi - lo)) + 3.0
    pil = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    return ImageEnhance.Contrast(ImageEnhance.Color(pil).enhance(0.94)).enhance(1.04)


def regrade(pil, local=0.55, lift=0.86, scurve=0.55):
    """
    Map luminance onto the navy->white ramp, with the three things a straight
    duotone lacks.

    A plain linear map puts every midtone in the same blue-grey, and at thumbnail
    size the subject stops reading. So: local contrast (an unsharp pass on the
    luminance only) to hold features small; a gentle S-curve with a lift so skin
    sits in the upper-mid of the ramp and clothing separates from the field; and a
    radial falloff centred above middle, which is what actually makes a beach, a
    street and a lobby read as one set - the surroundings fall away and the face
    is the brightest thing on the card.

    lift > 1 darkens, lift < 1 brightens.
    """
    a = np.asarray(pil.convert('RGB')).astype(np.float32)
    lum = (0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]) / 255.0

    lo, hi = np.percentile(lum, 1.5), np.percentile(lum, 98.5)
    lum = np.clip((lum - lo) / max(hi - lo, 1e-3), 0, 1)

    blur = np.asarray(Image.fromarray((lum * 255).astype(np.uint8))
                      .filter(ImageFilter.GaussianBlur(radius=max(2, pil.height // 90)))
                      ).astype(np.float32) / 255.0
    lum = np.clip(lum + local * (lum - blur), 0, 1)

    s = lum * lum * (3 - 2 * lum)                       # smoothstep
    lum = np.clip(scurve * s + (1 - scurve) * lum, 0, 1) ** lift

    h, w = lum.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    r = np.sqrt(((xx / w - 0.50) / 0.80) ** 2 + ((yy / h - 0.40) / 0.74) ** 2)
    t = np.clip((r - 0.46) / (1.30 - 0.46), 0, 1)
    lum = np.clip(lum * (1.0 - 0.50 * (t * t * (3 - 2 * t))), 0, 1)

    sh, li = np.array(SHADOW, np.float32), np.array(LIGHT, np.float32)
    return Image.fromarray(np.clip(sh + (li - sh) * lum[..., None], 0, 255).astype(np.uint8))


def widen(pil, face_cx=0.5, max_left=0.75):
    """
    Give a too-narrow frame the width a 4:5 crop needs.

    Some sources arrive cropped so tight that the head is TALLER than any 4:5 box
    the frame can hold, with a cheek already on the edge - so neither cutting the
    head nor narrowing is available. cv2's BORDER_REPLICATE smears each edge row
    sideways and reads as a corrupted scan; instead each side is painted from its
    own vertical colour profile, smoothed over about a seventh of the height so no
    row survives as a band, and darkened outward. The radial falloff in regrade()
    then takes those strips down to navy with the rest of the background.

    Keep the added width under about a sixth of the frame. Past that it shows.
    """
    import cv2
    w, h = pil.size
    need = int(round(h * AR))
    if need <= w:
        return pil, 0
    pad = need - w
    left = max(0, min(pad, int(round(max(0, min(pad * max_left, (0.5 - face_cx) * need))))))

    a = np.asarray(pil.convert('RGB')).astype(np.float32)
    k = max(3, (h // 7) | 1)

    def profile(cols):
        p = cols.mean(axis=1)[:, None, :]
        return cv2.GaussianBlur(p, (1, k), 0)[:, 0, :]

    out = np.empty((h, need, 3), np.float32)
    out[:, left:left + w] = a
    for side, n, x0 in (('l', left, 0), ('r', pad - left, left + w)):
        if n <= 0:
            continue
        p = profile(a[:, :24] if side == 'l' else a[:, -24:])
        t = (np.arange(n, dtype=np.float32) + 1) / n
        if side == 'l':
            t = t[::-1]
        out[:, x0:x0 + n] = p[:, None, :] * (1.0 - 0.34 * t)[None, :, None]
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)), left


def highlight_knee(pil, k=0.70, strength=0.52):
    """
    Pull the top of the ramp down for a source that arrived overexposed.

    Measure first: count pixels at 254 or above in the SOURCE crop. Under about 5%
    leave it alone. One invitation came in at 13.2% across the forehead and cheeks
    - that detail is not in the file and no grade can find it, so the job is to
    stop the hole reading as a hole. The knee settles the blown area as a bright
    highlight instead of paper white, and the eyes, beard and hair that DO carry
    detail become the strongest contrast on the face again.

    It runs AFTER regrade(): applied before, the grade's percentile normalisation
    simply stretches it back out.
    """
    sh = np.array(SHADOW, np.float32)
    li = np.array(LIGHT, np.float32)
    a = np.asarray(pil.convert('RGB')).astype(np.float32)
    t = np.clip(((a - sh) / np.maximum(li - sh, 1e-3)).mean(axis=2), 0, 1)
    hi = t >= k
    t[hi] = k + (t[hi] - k) * strength
    return Image.fromarray(np.clip(sh + (li - sh) * t[..., None], 0, 255).astype(np.uint8))


def cut(img_bgr, face_box, frame=None):
    """
    img_bgr   an OpenCV BGR array (cv2.imdecode of np.fromfile - imread chokes on
              Arabic paths)
    face_box  (x, y, w, h), brow to chin and cheek to cheek, in source pixels.
              READ IT OFF A GRID, do not trust haar: it missed a washed-out phone
              crop entirely and sat badly on a head turned away from the lens.
              Lay a 10% grid over the source and read hairline, eye line, chin and
              the two cheek edges.
    frame     (y0, y1) override for a source too tight for the 2.35x box
    """
    import cv2
    H, W = img_bgr.shape[:2]
    fx, fy, fw, fh = face_box
    cx, cy = fx + fw / 2.0, fy + fh / 2.0

    if frame is not None:
        y0, y1 = frame
        strip = Image.fromarray(cv2.cvtColor(img_bgr[y0:y1, 0:W], cv2.COLOR_BGR2RGB))
        wide, _left = widen(strip, face_cx=cx / float(W))
        return wide.resize((OUT_W, OUT_H), Image.LANCZOS)

    ch = min(fh * HEAD, H)
    cw = ch * AR
    x0 = min(max(0, cx - cw / 2.0), W - cw)
    y0 = min(max(0, cy - ch * EYE_Y), H - ch)
    crop = img_bgr[int(y0):int(y0 + ch), int(x0):int(x0 + cw)]
    return Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)).resize(
        (OUT_W, OUT_H), Image.LANCZOS)


def check(duo_png_paths):
    """
    The acceptance test. Run it over the whole set, not one portrait.

    Clipped highlights are the number that catches a bad source: a healthy set
    runs 0.9-5.6% of pixels at 253+. One at 14% is an overexposed original and
    needs highlight_knee(). Mean should land near the set's own median; an
    outlier 25 points high is a portrait that will look washed beside the others.
    """
    rows = []
    for p in duo_png_paths:
        a = np.asarray(Image.open(p).convert('L')).astype(float)
        rows.append((p, a.mean(), 100.0 * (a >= 253).mean()))
    med = float(np.median([r[1] for r in rows]))
    for p, mean, clip in rows:
        flag = ''
        if clip > 8:
            flag = '  <- blown, needs highlight_knee()'
        elif abs(mean - med) > 25:
            flag = '  <- off the set by %+.0f' % (mean - med)
        print('%-44s mean %5.1f  clip %5.2f%%%s' % (p, mean, clip, flag))
    print('set median mean %.1f' % med)

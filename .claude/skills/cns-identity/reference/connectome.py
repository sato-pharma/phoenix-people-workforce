#!/usr/bin/env python3
"""The CNS field texture — the connectome.

Every Tebofortin carton carries a dot-and-line network over a brain outline. That
network is Marcyrl's printed artwork, so this does NOT trace it: it generates a
network of the same character, deterministically, as the field texture for Sato's
own CNS pieces. Same idea, our own drawing.

Deterministic by seed, so the texture is identical on every render and a diff of
two cards never shows a moved node.

    python connectome.py --seed 11 --nodes 46 --width 1200 --height 1150 \
        --out ../assets/connectome.svg

Laws this encodes, learned off the packs:

  · the net is IRREGULAR. A lattice reads as a graphic pattern; a connectome reads
    as a nervous system. Points are jittered and never snapped.
  · every node joins its 2-3 NEAREST neighbours and nothing further, and an edge
    longer than --max-edge is dropped outright. Long chords across the field are
    what make a generated net look generated, and on a card they cut straight
    through the guest's name.
  · nodes vary in radius; a handful are hubs. A single radius reads as confetti.
  · it is drawn in ONE ink at low opacity and never in the accent colours. The
    seam owns leaf and orange; the field texture must not compete with it.
"""
import argparse
import math
import random


def build(seed: int, nodes: int, width: int, height: int, margin: int, k: int, max_edge: float):
    rng = random.Random(seed)
    # Poisson-ish: reject a candidate that lands on top of an existing node, so the
    # net stays open. A plain uniform scatter clumps and reads as noise.
    pts: list[tuple[float, float]] = []
    floor = min(width, height) / math.sqrt(nodes) * 0.62
    guard = 0
    while len(pts) < nodes and guard < nodes * 400:
        guard += 1
        x = rng.uniform(margin, width - margin)
        y = rng.uniform(margin, height - margin)
        if all((x - px) ** 2 + (y - py) ** 2 > floor ** 2 for px, py in pts):
            pts.append((x, y))

    edges: set[tuple[int, int]] = set()
    for i, (x, y) in enumerate(pts):
        order = sorted(
            range(len(pts)),
            key=lambda j: (x - pts[j][0]) ** 2 + (y - pts[j][1]) ** 2,
        )
        for j in order[1 : 1 + rng.randint(2, k)]:
            if math.dist((x, y), pts[j]) > max_edge:
                continue
            edges.add((min(i, j), max(i, j)))

    # A few hubs carry a wider dot. The pack does the same: most junctions are
    # small, three or four are plainly the centres of the thing.
    hubs = set(rng.sample(range(len(pts)), max(2, len(pts) // 12)))
    return pts, sorted(edges), hubs


def render(pts, edges, hubs, width, height, ink: str) -> str:
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="{width}" height="{height}" fill="none">',
        f'<g stroke="{ink}" stroke-width="1.1" stroke-opacity=".30">',
    ]
    for i, j in edges:
        (x1, y1), (x2, y2) = pts[i], pts[j]
        out.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}"/>')
    out.append("</g>")
    out.append(f'<g fill="{ink}">')
    for n, (x, y) in enumerate(pts):
        r = 4.6 if n in hubs else 2.3
        o = ".62" if n in hubs else ".40"
        out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r}" fill-opacity="{o}"/>')
    out.append("</g></svg>")
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--nodes", type=int, default=46)
    ap.add_argument("--width", type=int, default=1200)
    ap.add_argument("--height", type=int, default=1150)
    ap.add_argument("--margin", type=int, default=40)
    ap.add_argument("--neighbours", type=int, default=3)
    ap.add_argument("--max-edge", type=float, default=240.0)
    ap.add_argument("--ink", default="#ffffff")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    pts, edges, hubs = build(a.seed, a.nodes, a.width, a.height, a.margin, a.neighbours, a.max_edge)
    svg = render(pts, edges, hubs, a.width, a.height, a.ink)
    with open(a.out, "w", encoding="utf-8") as fh:
        fh.write(svg)
    print(f"{a.out}: {len(pts)} nodes, {len(edges)} edges, {len(hubs)} hubs, seed {a.seed}")


if __name__ == "__main__":
    main()

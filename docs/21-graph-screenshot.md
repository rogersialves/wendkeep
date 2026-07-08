# Graph screenshot guide (the money shot)

The launch hinges on one image: the Obsidian graph of a wendkeep vault, where you can *see*
sessions linking to decisions, bugs, learnings and changes. This is a manual step (yours) — this
guide makes it repeatable.

## Which vault
Use a vault with real history (e.g. `.NutriGymBrain`) — a populated graph sells it; an empty one
doesn't. If you'd rather not show a real project, `wendkeep init` a throwaway vault and `import`
a handful of sessions into it.

## Setup in Obsidian
1. Ensure the color system is installed (it is, if `wendkeep init` ran without `--no-colors`):
   the graph color groups accent notes by folder (sessions / decisions / bugs / learnings /
   changes). Settings → Appearance → CSS snippets → `wendkeep-colors` enabled.
2. Open **Graph view** (not local graph). Settings (top-right gear of the graph):
   - **Groups**: confirm the per-folder color groups are present (added by init).
   - **Filters**: `-path:.brain -path:Templates -path:_arquivo` to hide plumbing.
   - **Forces**: raise *Link force* and *Center force* a bit so clusters separate; lower
     *Repel* slightly so it's dense but readable.
   - **Display**: turn on *Arrows*; text fade so labels appear on hover, not everywhere.
3. Let it settle, then zoom so 2–4 session clusters (a session + its decisions/bugs/learnings +
   the change it touched) fill the frame. Legible node labels on the central cluster.

## Capture
- Dark theme reads best on HN/Reddit; export a light variant too for the README.
- PNG for static (README), a short GIF/MP4 for social (drag a node, let the graph breathe).
- Save to `docs/assets/graph.png` (and `graph-dark.png`) and reference it from the README
  screenshot slot (`<!-- SCREENSHOT: ... -->`).

## Caption
Pair it with a concrete stat from your own vault:
```
npx wendkeep stats --vault .NutriGymBrain
```
e.g. *"142 sessions · 4.7k prompts · $4,701 captured — every one a note in this graph."*

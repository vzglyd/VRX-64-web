# Shared Slide Repo Contract

The shared slides source is a normal directory or Git repository root that both hosts consume:

- Native reads the repo from the filesystem.
- Web preview/editor read the repo over HTTP.
- `playlist.json` is required at the repo root.
- Every `playlist.json.slides[].path` must be repo-root-relative and point to a `.vzglyd` bundle.
- The HTTP root can be a locally served checkout or a static host such as GitHub Pages.

## Layout

```text
my-slides-repo/
├── playlist.json
├── clock.vzglyd
├── weather.vzglyd
└── daily/
    └── headlines.vzglyd
```

## Example `playlist.json`

```json
{
  "defaults": {
    "duration_seconds": 12,
    "transition_in": "crossfade",
    "transition_out": "cut"
  },
  "slides": [
    {
      "path": "clock.vzglyd"
    },
    {
      "path": "daily/headlines.vzglyd",
      "duration_seconds": 20,
      "params": {
        "edition": "morning"
      }
    },
    {
      "path": "weather.vzglyd",
      "enabled": false
    }
  ]
}
```

## Serving For Web

Serve the repo root directly so the browser can fetch:

- `GET /playlist.json`
- `GET /<bundle-path>.vzglyd`

Example:

```bash
python3 -m http.server 8081 --directory /path/to/my-slides-repo
```

Then use `http://localhost:8081/` as the repo base URL in the preview or editor.

GitHub Pages-style hosting works the same way:

- `https://rodgerbenham.github.io/vzglyd/playlist.json`
- `https://rodgerbenham.github.io/vzglyd/clock.vzglyd`

In that case, use `https://rodgerbenham.github.io/vzglyd/` as the repo base URL.

## Required Bundle Artwork

Each `.vzglyd` bundle manifest must declare cassette artwork under `assets.art`.
The three paths are package-root-relative image files stored inside the archive.

```json
{
  "assets": {
    "art": {
      "j_card": { "path": "art/j-card.png" },
      "side_a_label": { "path": "art/side-a.png" },
      "side_b_label": { "path": "art/side-b.png" }
    }
  }
}
```

## Optional Bundle Params Schema

Bundles can advertise editor-friendly params inside their `manifest.json`. When present, the web
editor renders guided controls and only writes explicit overrides into `playlist.json`.

Example:

```json
{
  "name": "daily headlines",
  "params": {
    "fields": [
      {
        "key": "edition",
        "type": "string",
        "required": true,
        "label": "Edition",
        "default": "morning",
        "options": [
          { "value": "morning", "label": "Morning" },
          { "value": "evening", "label": "Evening" }
        ]
      },
      {
        "key": "refresh_seconds",
        "type": "integer",
        "label": "Refresh seconds",
        "default": 30
      },
      {
        "key": "debug",
        "type": "boolean",
        "label": "Debug overlay"
      }
    ]
  }
}
```

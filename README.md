# Shortcut

A localhost video editing application for H.264 MP4 sources. Files remain on disk and are streamed to the browser in byte ranges instead of being copied or loaded into memory.

Shortcut provides:

- Cached stream metadata and keyframe indexing
- Previous and next keyframe navigation
- Non-destructive in/out marks and multiple keep segments
- Persisted JSON edit decision lists
- Keyframe-aligned exports without re-encoding
- Frame-accurate H.264/AAC exports for arbitrary edit points

## Requirements

- Node.js 22 or newer
- FFmpeg and ffprobe available on `PATH`

## Run

The default media root is the repository's `media` directory:

```sh
npm start
```

To use an existing folder without moving its files:

```sh
MEDIA_ROOT="/path/to/videos" npm start
```

For automatic server restarts during development:

```sh
MEDIA_ROOT="/path/to/videos" npm run dev
```

Open <http://127.0.0.1:4173>, select an MP4 from the local library, and click **Load**. Files must contain an H.264 video stream.

Projects and metadata caches default to `.shortcut-data`. Exports default to `shortcut-exports` inside the media root. Override these locations with `DATA_ROOT` and `OUTPUT_ROOT`.

## Test

```sh
npm test
```

The integration test generates a short H.264 MP4 with FFmpeg and verifies registration, containment checks, `HEAD`, and HTTP byte-range responses.

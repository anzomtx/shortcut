# Shortcut

A localhost video editing application for H.264 MP4 sources. Files remain on disk and are streamed to the browser in byte ranges instead of being copied or loaded into memory.

Shortcut provides:

- Cached stream metadata and keyframe indexing
- Previous and next keyframe navigation
- Include-range editing for assembling selected source ranges
- Remove-range editing with ripple deletion and a re-timed sequence
- Undo, redo, reset, and fixed 1/3/6/10-second navigation
- Configurable keyboard shortcuts and a resizable, tabbed workspace panel
- Timeline-only playback with collapsible control and EDL drawers
- Deletable saved projects with portable JSON import and download
- Persistent single-worker export queue with progress, pause, resume, stop, and clear controls
- Persisted JSON edit decision lists
- Keyframe-aligned exports without re-encoding
- Frame-accurate H.264/AAC exports for arbitrary edit points
- "Only fast encode edits" preference that snaps every mark to a keyframe and disables frame-accurate export
- Server admin console with live activity log, force stop, reset, and shutdown controls
- A double-clickable macOS launcher that starts the server and opens the browser
- Automatic session recovery: edits are autosaved locally and restored after an unexpected crash
- Crash and client error logging under `logs/`, and a supervisor that restarts the server after a crash

## Requirements

- Node.js 22 LTS (the included `.nvmrc` pins this major version)
- FFmpeg and ffprobe available on `PATH`; FFmpeg must include the `libx264` and AAC encoders

## Run

The default media root is the repository's `media` directory:

```sh
nvm use
npm install
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

On macOS you can double-click `Shortcut Launcher.command` to start the server and open the browser automatically. The launcher runs the server under a supervisor (`scripts/supervise.mjs`) that restarts it automatically if it crashes and stops cleanly when you use the **Shut down** button (or press Ctrl+C).

## Crash recovery and logging

Edits are autosaved to the browser's local storage after every change, along with the source filename. If the previous session closed without a clean unload (a crash, the browser tab being killed, or the machine losing power), the file and edit list are reloaded automatically. If the session closed cleanly, a **Restore** bar offers to reload the last unsaved session instead.

Client errors, server crashes, and supervisor restarts are recorded as JSON Lines under `logs/` (gitignored) in the repository: `client-errors.jsonl`, `server-errors.jsonl`, and `server-supervisor.log`. The admin console also mirrors client errors as they arrive.

Open <http://127.0.0.1:4173> and click an MP4 filename in the local library, or drop an MP4 anywhere onto the video area — dropped files are located by name on disk and streamed in place, never copied. Files must contain an H.264 video stream.

Projects, preferences, shortcut mappings, and metadata caches default to `.shortcut-data`. Exports default to `shortcut-exports` inside the media root. `MEDIA_ROOT` and `OUTPUT_ROOT` set the initial paths; saving new library and export paths in Preferences applies and persists them without a restart.

Export filenames come from a configurable template such as `%o-%m-%h.%ext`, with tokens `%f` (original filename), `%o` (project name), `%m` (mode), `%h` (short id), and `%ext` (extension); Preferences shows a live example. Import search folders tell the server where to look when matching dropped filenames.

Remove mode starts with the complete source. Mark a sequence range and choose **Remove range** to subtract it; the remaining clips close the gap and retain source timestamps for export. Include mode starts empty and adds marked source ranges. Switching modes after editing requires confirmation and resets the sequence.

Deleting a saved project removes only its JSON record. Source videos and rendered exports are left untouched. Exported project JSON includes a versioned `shortcut-project` envelope and the complete edit decision list, and can be restored from the Projects tab.

New exports enter the persistent queue paused and start only after choosing Resume. Jobs are processed one at a time. Pausing an active job suspends its FFmpeg process, while stopping removes partial output and temporary segment files. Queue state survives browser and server restarts. Clearing the queue stops active work and removes queue records without deleting completed output files.

## Test

```sh
npm test
```

The integration test generates a short H.264 MP4 with FFmpeg and verifies registration, containment checks, `HEAD`, and HTTP byte-range responses.

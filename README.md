# Slingui Recording

Recording extension used by Slingui for classroom recordings.

## Features

- Record a browser tab, selected area, desktop, application, or camera.
- Capture microphone, system audio, and meeting audio chunks when available.
- Record at professor-friendly defaults: 15 FPS, 720p, camera disabled, and no countdown.
- Annotate recordings with drawing, text, arrows, shapes, zoom, blur, and cursor tools.
- Edit and export recordings as MP4 or WebM.
- Save recordings to Slingui and register them in the Classroom recording list.
- Keep recording data local until it is explicitly saved to Slingui.

## Local development

1. Check that your [Node.js](https://nodejs.org/) version is **14** or higher.
2. Install dependencies with `npm install`.
3. Run `npm start` to start the development server.
4. Build the extension with `npm run build`.
5. Open `chrome://extensions/` and enable developer mode.
6. Click **Load unpacked** and select the generated `build` folder.

## Configuration

The extension uses the Slingui API and Classroom endpoints configured by the build environment. Do not commit credentials or production secrets. For local development, use the repository's local environment configuration.

## Acknowledgements

This project includes open-source recording and media-processing components. See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) and [`LICENSE`](./LICENSE) for license and attribution information.

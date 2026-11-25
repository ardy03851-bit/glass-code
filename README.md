# Glass Code

A simple glassmorphic grey, iPad-optimised web IDE: edit, run and live-preview HTML/CSS/JS projects entirely in the browser.

- Select all, cut, copy, paste, replace whole file with copied code, find and replace all
- Import any zip (batched, multi-threaded unpacking, auto-strips root folder), add files, export one file, a folder or everything as a zip
- Live double-buffered preview; open it in a new tab or full screen
- Projects persist locally (IndexedDB)

Static site: open `index.html`. Uses [fflate](https://github.com/101arrowz/fflate) (MIT), bundled in `lib/`.

## File support
Icons: [Devicon](https://devicon.dev) logos for languages, [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) for everything else, [Lucide](https://lucide.dev) for UI.
Viewers: images, SVG, video, audio, fonts, PDF, Markdown, zip-based archives, 3D models (glb, gltf, obj, stl, ply, fbx, dae, 3mf, 3ds via three.js) and a hex dump fallback for any other file.

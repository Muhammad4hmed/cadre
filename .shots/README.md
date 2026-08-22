# Screenshot harness

`build.mjs` renders the **real** webview — `media/team.css` and `media/team.js`,
unmodified — against a scripted sequence of genuine `TeamEvent`s, then Chrome
screenshots it headlessly. The markup is extracted from `src/extension.ts` at build
time, so the harness cannot drift from what ships.

The images are therefore the actual interface with sample data, not a mockup. Two real
UI bugs were found this way: the header overlapping at sidebar width, and paths
rendering as `home/you/…` because of an `rtl` truncation trick.

```sh
node .shots/build.mjs
google-chrome --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=1180,760 \
  --screenshot=media/screenshots/team-floor.png "file://$PWD/.shots/team-floor.html"
```

`scripts/make-diagram.py` regenerates `media/screenshots/flow.png`.

# Screenshot harness

`build.mjs` renders the **real** webview — `media/team.css` and `media/team.js`,
unmodified — against a scripted sequence of genuine `TeamEvent`s, then Chrome
screenshots it headlessly. The markup is re-extracted from `src/extension.ts` on every
run, and the extraction asserts an anchor is present, so the harness cannot drift from
what ships. (It could, briefly: extraction used to be a separate step writing
`body.html`, which went stale and silently rendered an old header.)

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

# Third-party materials

Original application code is MIT-licensed; original teaching text outside CC-CEDICT-derived packages is MIT-licensed; see [LICENSE](LICENSE). Third-party materials retain their own terms.

- **Hanzi Writer:** MIT, copyright its contributors. Source: https://github.com/chanind/hanzi-writer . The retained licence is [HANZI-WRITER-MIT.txt](public/licenses/HANZI-WRITER-MIT.txt).
- **Character graphics and stroke data:** the six unchanged JSON files in `public/characters/` come from `hanzi-writer-data@2.0.1`, based on Make Me a Hanzi. They are distributed under the separate [Arphic Public License](public/licenses/ARPHICPL.TXT), which applies to the data rather than being replaced by this project's MIT licence. Sources: https://github.com/chanind/hanzi-writer-data and https://github.com/skishore/makemeahanzi .
- **Other software dependencies:** declared in `package.json` and pinned in `package-lock.json`; their upstream licences apply. Installed dependencies and compiled bundles are not committed.
- **Artwork:** `public/og.png` was generated for this project.
- **Audio:** no generated system-voice recordings are distributed in this repository. The public app requests speech at runtime from the user's browser/device, without recording or exporting it. The household's optional audio files are private and ignored by Git. Apple's macOS Tahoe Software License Agreement, section 2.F, restricts redistribution of system-voice content: https://www.apple.com/legal/sla/docs/macOSTahoe.pdf . Any replacement recordings need suitable permission and attribution.

The repository links to curriculum and research sources; it does not redistribute the downloaded curriculum PDF or private research archive.

- **CC-CEDICT-derived draft curriculum:** selected dictionary facts and adapted packages in `content/sources/`, `content/authoring/`, `content/curriculum/nature/`, `content/curriculum/everyday/` and associated corpus manifests retain **CC-BY-SA-4.0**, including original contexts integrated into those adaptations. Attribution: CC-CEDICT contributors, published by MDBG. Exact source URL, retrieval date and archive SHA-256 are in each source evidence file. Source: https://www.mdbg.net/chinese/dictionary?page=cedict ; license: https://creativecommons.org/licenses/by-sa/4.0/ . MIT does not replace those terms. Human source/content review remains pending.
- **Additional capybara art:** project-generated original illustrations in `public/mascot/` and `public/story/forest-01-v3/`; project-authored SVG/CSS/JavaScript. No private generation history or reference images are distributed.

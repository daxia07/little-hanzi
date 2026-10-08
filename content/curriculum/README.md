# Curriculum drafts

This directory holds authoring packages for the Sprint 3 content contract (internal historical specification; not distributed). It is separate from the published forest lesson and from children's saved learning.

A package passing the local structural audit is still a draft. It needs attributed Mandarin/content review, source and asset checks, an implemented renderer with integration evidence, and the relevant owner/release decision before a child can be assigned it. A JSON field or an AI-generated comment cannot supply those decisions.

Use original English instructions and supported Chinese word contexts. Include at least two distinct word associations per target character, a plain-print recognition check and a later-review prompt. Mark source checks truthfully; unresolved provenance and device audio review remain visible editorial work. Never copy tests' synthetic source records into a real publication record.

Keep versions immutable after review. A changed word, reading, prompt, asset or provenance record requires a new version and digest. The local audit reports structurally valid coverage separately from trusted review and release coverage. The starter target remains at least 1,600 distinct usable reviewed characters; pending drafts do not satisfy it.

The current authenticated forest lesson remains `forest-01-v1`. A future package here does not replace that runtime version or its release evidence automatically.

Run `npm run curriculum:check` for a local structural audit, or add `-- --dir PATH` for another directory. Only root regular JSON files are read; symlinks and subdirectories are ignored. `npm run curriculum:check -- --require-starter` checks the release gate and currently exits 1 because trusted review and renderer proof are not implemented. The audit never writes learning data or publishes content.

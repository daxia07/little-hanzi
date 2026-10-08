# Synthetic R6 scale fixtures

These 800 paired packages contain 1,600 distinct test characters, the Unicode
range U+3400–U+3A3F. Their words, pronunciation labels and contexts are synthetic
mechanical data. They are not a simplified-character curriculum or usable
Mandarin teaching. Real reviewed, prospective and committed coverage is **zero**.

The fixed corpus and sixteen batches bind every package digest. The literal
oracle binds targets from that declared codepoint range, with explicit expected
prints for all ten check templates. It never reads a grader's correctChoiceId.
The word/context literals verify mechanical consistency, not linguistic quality.
Declared Tingting speech is for controlled test events only; no device quality,
human review or owner acceptance is claimed. No stored audio files are provided.

Reproduce the fixed files with `python3 scripts/build-corpus-fixtures.py` from
the repository. The generator takes no paths/arguments and writes only the fixed
R6 draft/fixture directories; it makes no database or service requests. The closed
runner profile `stress-corpus` and synthetic installation binding are mandatory
for later verification. Do not import these fixtures or their trust into the
active family service.

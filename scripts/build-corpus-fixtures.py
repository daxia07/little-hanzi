"""Reproduce fixed R6 source fixtures; no service, database, review or release.

The twenty authored targets retain pending R5 content verbatim under new R6
identities. Stress text is invented mechanical data, never Mandarin teaching.
All destinations are fixed beneath this repository; no CLI paths are accepted.
"""
import copy
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAIRS = ["木林", "日月", "人口", "山水", "大小", "上下", "田土", "火雨", "手目", "门车"]


def read(relative):
    return json.loads((ROOT / relative).read_text())


def write(relative, value):
    target = ROOT / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def digest(value):
    canonical = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(canonical.encode()).hexdigest()


def oracle(package, literal_targets):
    """Freeze literal expected print; never inspect a correctChoiceId."""
    targets = []
    for character, expected in zip(package["characters"], literal_targets, strict=True):
        assert character["hanzi"] == expected
        reading = character["readings"][0]
        targets.append({
            "characterId": character["characterId"], "hanzi": expected,
            "reading": {k: reading[k] for k in ("readingId", "pinyin", "audioText")},
            "words": [{**{k: word[k] for k in ("wordId", "text", "pinyin", "english")},
                       "context": {k: word["context"][k] for k in ("hanzi", "english")}}
                      for word in character["wordAssociations"]],
        })
    expected_by_id = {t["characterId"]: t["hanzi"] for t in targets}
    return {
        "schemaVersion": "r6-member-oracle-1", "lessonVersion": package["lessonVersion"],
        "contentDigest": digest(package), "targets": targets,
        "checks": [{"checkId": c["checkId"], "characterId": c["characterId"],
                    "kind": c["kind"], "expectedHanzi": expected_by_id[c["characterId"]],
                    "promptHanzi": c["prompt"]["hanzi"]} for c in package["recognitionChecks"]],
    }


def corpus_files(packages, expected, *, corpus_id, corpus_version, manifest_path,
                 package_dir, batch_dir, oracle_path, synthetic):
    items, oracles, batches = [], [], {}
    for index, package in enumerate(packages):
        batch_id = f"{corpus_id}-batch-{index // 50 + 1:02}"
        batch_version = f"{batch_id}-v1"
        item = {"lessonVersion": package["lessonVersion"], "contentDigest": digest(package),
                "batchId": batch_id, "trackId": package["placement"]["trackId"],
                "sequence": package["placement"]["sequence"]}
        items.append(item)
        write(f"{package_dir}/{package['lessonVersion']}.json", package)
        oracles.append(oracle(package, expected[index]))
        if batch_id not in batches:
            batches[batch_id] = {"schemaVersion": "r6-authoring-batch-1", "batchId": batch_id,
                                 "batchVersion": batch_version, "items": [], "intendedScope": "draft",
                                 "unresolvedFields": ["UNVERIFIED_SOURCE", "UNREVIEWED_CONTENT", "UNREVIEWED_AUDIO"]}
        batches[batch_id]["items"].append({
            "lessonVersion": item["lessonVersion"], "contentDigest": item["contentDigest"],
            "characters": [{"characterId": c["characterId"], "coverageIdentity": c["hanzi"]}
                           for c in package["characters"]],
            "sourceRefs": ["SIMULATED-R6-STRESS" if synthetic else "r5-cc-cedict-evidence"],
            "licenseRefs": ["CC0-1.0-synthetic" if synthetic else "CC-BY-SA-4.0"],
            "reviewerRefs": [], "adapterId": "corpus-paired", "adapterVersion": "corpus-paired-v1",
            "trackId": item["trackId"], "sequence": item["sequence"],
        })
    manifest = {"schemaVersion": "r6-corpus-1", "corpusId": corpus_id, "corpusVersion": corpus_version,
                "canonicalizationVersion": "s3-json-1", "policyVersion": "r6-corpus-policy-1", "items": items}
    write(manifest_path, manifest)
    write(oracle_path, {"schemaVersion": "r6-member-oracles-1", "corpusVersion": corpus_version,
                        "corpusDigest": digest(manifest), "items": oracles})
    for batch in batches.values():
        write(f"{batch_dir}/{batch['batchVersion']}.json", batch)
    return digest(manifest)


def stress_package(template, index):
    a, b = [chr(0x3400 + index * 2 + offset) for offset in (0, 1)]
    raw = json.dumps(template, ensure_ascii=False)
    for old, new in [("6728", f"{ord(a):x}"), ("6797", f"{ord(b):x}"), ("木", a), ("林", b)]:
        raw = raw.replace(old, new)
    package = json.loads(raw)
    package["lessonId"] = f"corpus-stress-{index + 1:04}"
    package["lessonVersion"] = package["lessonId"] + "-v1"
    package["title"] = f"SIMULATED pair {index + 1:04}"
    package["placement"] = {"trackId": "synthetic-stress", "sequence": index + 1}
    package["renderer"].update(adapterId="corpus-paired", adapterVersion="corpus-paired-v1")
    package["instructionsEnglish"].update(welcome="SIMULATED mechanical fixture. This is not a language lesson.",
                                          objective="Exercise saved recognition mechanics with synthetic text.")
    provenance = {"source": "SIMULATED R6 mechanical stress fixture; no linguistic or human review",
                  "license": "CC0-1.0 synthetic test data", "evidenceRef": "SIMULATED/r6/stress",
                  "sourceChecked": True}
    for target_index, character in enumerate(package["characters"]):
        target = [a, b][target_index]
        character["readings"][0].update(pinyin="SIMULATED", audioText=target, provenance=copy.deepcopy(provenance))
        character["meanings"] = [{"english": f"SIMULATED target {target_index + 1}", "provenance": copy.deepcopy(provenance)}]
        character["teaching"].update(hintEnglish="SIMULATED shape clue for a mechanical test.",
                                      demonstrationEnglish=f"SIMULATED target print: {target}")
        for word_index, word in enumerate(character["wordAssociations"]):
            text = target + ["甲", "乙"][word_index]
            word.update(text=text, pinyin="SIMULATED", english=f"SIMULATED word {target_index + 1}-{word_index + 1}",
                        context={"hanzi": text + "。", "english": "SIMULATED context; not Mandarin teaching.", "targetCharacter": target},
                        provenance=copy.deepcopy(provenance))
    targets = {c["characterId"]: c for c in package["characters"]}
    words = {w["wordId"]: w for c in package["characters"] for w in c["wordAssociations"]}
    practice_words = {p["checkId"]: words[p["wordId"]] for t in package["pairedStory"]["targets"] for p in t["practice"]}
    for check in package["recognitionChecks"]:
        check["prompt"]["hanzi"] = practice_words[check["checkId"]]["text"] if check["checkId"] in practice_words else targets[check["characterId"]]["hanzi"]
    checks = {c["checkId"]: c for c in package["recognitionChecks"]}
    readings = {r["readingId"]: r for c in package["characters"] for r in c["readings"]}
    for asset in package["assets"]:
        asset.update(source=provenance["source"], license=provenance["license"], evidenceRef=provenance["evidenceRef"],
                     sourceChecked=True, sourceCheckStatus="mechanically-checked")
    story = package["pairedStory"]
    story["welcome"] = {"title": package["title"], "instructionEnglish": package["instructionsEnglish"]["welcome"]}
    story["reader"]["title"] = "SIMULATED reader"
    story["playback"]["voices"] = [{"name": "Tingting", "lang": "zh-CN", "localService": True}]
    for cue in story["playback"]["cues"]:
        cue["transcript"] = (checks[cue["checkId"]]["prompt"]["hanzi"] if cue["checkId"] else
                             words[cue["wordId"]]["context"]["hanzi"] if cue["wordId"] else readings[cue["readingId"]]["audioText"])
    return package, [a, b]


if __name__ == "__main__":
    import sys
    if len(sys.argv) != 1:
        raise SystemExit("This fixed source generator takes no paths or arguments.")
    drafts = []
    for index in range(10):
        package = read(f"content/curriculum/collection/path-{index + 1:02}-v1.json")
        package["lessonId"] = f"corpus-path-{index + 1:02}"
        package["lessonVersion"] = package["lessonId"] + "-v1"
        package["renderer"].update(adapterId="corpus-paired", adapterVersion="corpus-paired-v1")
        drafts.append(package)
    draft_digest = corpus_files(drafts, PAIRS, corpus_id="hanzi-starter-draft", corpus_version="hanzi-starter-draft-v1",
                               manifest_path="content/corpora/hanzi-starter-draft-v1.json", package_dir="content/curriculum/corpus",
                               batch_dir="content/corpora/batches", oracle_path="tests/fixtures/curriculum/corpus-draft/oracles.json", synthetic=False)
    template = read("content/curriculum/collection/path-01-v1.json")
    pairs = [stress_package(template, index) for index in range(800)]
    stress_digest = corpus_files([p[0] for p in pairs], [p[1] for p in pairs], corpus_id="hanzi-stress", corpus_version="hanzi-stress-v1",
                                manifest_path="tests/fixtures/curriculum/corpus-stress/corpus.json", package_dir="tests/fixtures/curriculum/corpus-stress/packages",
                                batch_dir="tests/fixtures/curriculum/corpus-stress/batches", oracle_path="tests/fixtures/curriculum/corpus-stress/oracles.json", synthetic=True)
    print(json.dumps({"draft": draft_digest, "stress": stress_digest, "realReviewed": 0}))

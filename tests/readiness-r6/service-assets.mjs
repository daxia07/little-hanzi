/** Unauthenticated actual served bytes and AST literal grader objects. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
export async function runServedAssets(h, manifest) {
  const origin = new URL(h.ordinaryNegativeBaseURL);
  assert.equal(origin.hostname, '127.0.0.1');
  const html = await fetch(origin, { signal: AbortSignal.timeout(15000) });
  assert.equal(html.status, 200);
  const files = manifest.artifactFiles.filter(
    (x) => x.startsWith('.output/public/') && x.endsWith('.js'),
  );
  assert(files.length);
  const records = [];
  for (const file of files) {
    const url = new URL('/' + file.slice('.output/public/'.length), origin),
      response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer()),
      expected = fs.readFileSync(path.join(manifest.snapshot, file));
    assert.equal(
      crypto.createHash('sha256').update(bytes).digest('hex'),
      crypto.createHash('sha256').update(expected).digest('hex'),
    );
    const source = ts.createSourceFile(
      file,
      bytes.toString('utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    let literalKeys = 0;
    function visit(node) {
      if (ts.isPropertyAssignment(node)) {
        const name =
          ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
            ? node.name.text
            : null;
        if (
          ['correctChoiceId', 'correctAnswer'].includes(name) &&
          ts.isStringLiteral(node.initializer)
        )
          literalKeys++;
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    assert.equal(
      literalKeys,
      0,
      'Public literal authoritative grader key leaked',
    );
    records.push({
      file,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      byteCount: bytes.length,
      literalAuthoritativeKeys: literalKeys,
    });
  }
  return {
    unauthenticatedRequests: files.length + 1,
    javascriptFiles: files.length,
    records,
    limitations: [
      'AST literal key scan and exact served bytes; generic schema labels are not classified as answer leaks.',
      'No arbitrary dynamic-string reconstruction or physical network acceptance claimed.',
    ],
  };
}

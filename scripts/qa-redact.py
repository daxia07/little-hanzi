"""Remove the ephemeral harness token from retained synthetic QA evidence."""
import io
import os
from pathlib import Path
import sys
import zipfile

token = os.environ.get('HANZI_REDACT_TOKEN', '').encode()
if not token:
    raise SystemExit('A harness token is required for evidence redaction')
for file in Path(sys.argv[1]).rglob('*'):
    if not file.is_file():
        continue
    if file.suffix == '.zip':
        output = io.BytesIO()
        with zipfile.ZipFile(file) as source, zipfile.ZipFile(output, 'w') as destination:
            for entry in source.infolist():
                destination.writestr(entry, source.read(entry.filename).replace(token, b'[redacted]'))
        file.write_bytes(output.getvalue())
    elif file.suffix in {'.json', '.log', '.txt', '.html', '.trace', '.network'}:
        content = file.read_bytes()
        if token in content:
            file.write_bytes(content.replace(token, b'[redacted]'))

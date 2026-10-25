"""Exercise installer transport and integrity checks without network or installation."""
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class InstallerSecurityTests(unittest.TestCase):
    def run_installer(self, checksum):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / "bin"
            binary.mkdir()
            archive = b"fixture release archive"
            (root / "archive").write_bytes(archive)
            shims = {
                "uname": 'import sys; print("Linux" if sys.argv[1] == "-s" else "x86_64")',
                "curl": '''import os, pathlib, sys
args = sys.argv[1:]
assert args[args.index('--proto')+1] == '=https'
assert args[args.index('--proto-redir')+1] == '=https'
url = next(x for x in args if x.startswith('https://'))
if url.endswith('/releases/latest'):
    print('{"tag_name": "v0.0.0"}')
else:
    target = pathlib.Path(args[args.index('-o')+1])
    if url.endswith('/checksums.txt'):
        target.write_text(os.environ['AUDIT_INSTALL_CHECKSUM'] + '  tsq_Linux_x86_64.tar.gz\\n')
    else:
        target.write_bytes(pathlib.Path(os.environ['AUDIT_INSTALL_ARCHIVE']).read_bytes())
''',
                "tar": '''import os, pathlib, sys
with open(os.environ['AUDIT_INSTALL_ACTIONS'], 'a') as f: f.write('extract\\n')
pathlib.Path(sys.argv[sys.argv.index('-C')+1], 'tsq').write_text('fixture')
''',
                "mv": '''import os
with open(os.environ['AUDIT_INSTALL_ACTIONS'], 'a') as f: f.write('install\\n')
''',
                "sudo": '''import os, pathlib, sys
assert sys.argv[1] == 'mv'
os.execv(str(pathlib.Path(__file__).with_name('mv')), ['mv'] + sys.argv[2:])
''',
            }
            for name, source in shims.items():
                path = binary / name
                path.write_text(f"#!{sys.executable}\n{source}\n")
                path.chmod(0o755)
            actions = root / "actions"
            env = dict(os.environ, PATH=str(binary) + os.pathsep + os.environ["PATH"],
                       AUDIT_INSTALL_ARCHIVE=str(root / "archive"),
                       AUDIT_INSTALL_CHECKSUM=checksum(archive),
                       AUDIT_INSTALL_ACTIONS=str(actions))
            result = subprocess.run(["/bin/sh", str(Path(__file__).resolve().parents[1] / "install.sh")],
                                    env=env, capture_output=True, text=True, timeout=15)
            return result, actions.read_text() if actions.exists() else ""

    def test_verified_archive_can_be_installed(self):
        result, actions = self.run_installer(lambda archive: hashlib.sha256(archive).hexdigest())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(actions, "extract\ninstall\n")

    def test_tampered_archive_is_rejected_before_extraction(self):
        result, actions = self.run_installer(lambda _: "0" * 64)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(actions, "")

    def test_missing_checksum_is_rejected_before_extraction(self):
        result, actions = self.run_installer(lambda _: "")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(actions, "")


if __name__ == "__main__":
    unittest.main()

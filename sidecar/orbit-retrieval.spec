# PyInstaller specification for the dependency-free local retrieval executable.
from PyInstaller.utils.hooks import collect_submodules

a = Analysis(["sidecar/retrieval.py"], pathex=[], binaries=[], datas=[], hiddenimports=collect_submodules("sqlite3"), hookspath=[], hooksconfig={}, runtime_hooks=[], excludes=[], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, a.binaries, a.datas, [], name="orbit-retrieval", debug=False, bootloader_ignore_signals=False, strip=False, upx=False, console=True)

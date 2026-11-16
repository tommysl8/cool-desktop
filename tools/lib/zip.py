"""Zip a folder for Lively (or any consumer that needs clean archive names).

Usage: python tools/lib/zip.py <srcDir> <outZip>

- Python standard library only (zipfile), ZIP_DEFLATED.
- Entry names are path.relative_to(src).as_posix(): forward slashes, no "./", no top folder.
- Files only (no directory entries), sorted for a stable order.
- Never use Compress-Archive or [IO.Compression.ZipFile] in PowerShell 5.1: they write
  backslash names and Lively then rejects the package.
"""
import pathlib
import sys
import zipfile


def fail(msg, code=1):
    sys.stderr.write("zip.py: " + msg + "\n")
    return code


def main(argv):
    try:
        sys.stdout.reconfigure(errors="backslashreplace")
    except (AttributeError, ValueError):
        pass
    if len(argv) != 3:
        return fail("usage: python tools/lib/zip.py <srcDir> <outZip>", 2)
    src = pathlib.Path(argv[1]).resolve()
    out = pathlib.Path(argv[2]).resolve()
    if not src.is_dir():
        return fail("source is not a folder: " + str(src), 2)
    if out == src or src in out.parents:
        return fail("output zip must not be inside the source folder: " + str(out), 2)

    files = sorted((p for p in src.rglob("*") if p.is_file()), key=lambda p: p.relative_to(src).as_posix())
    if not files:
        return fail("source folder has no files: " + str(src), 2)

    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()

    total = 0
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, strict_timestamps=False) as zf:
        for p in files:
            arcname = p.relative_to(src).as_posix()
            zf.write(p, arcname)
            size = p.stat().st_size
            total += size
            print("add %s (%d bytes)" % (arcname, size))

    with zipfile.ZipFile(out) as zf:
        names = zf.namelist()
        bad = [n for n in names if "\\" in n or n.startswith("./") or n.startswith("/") or n.endswith("/")]
        if bad:
            return fail("bad entry names: " + ", ".join(bad))
        broken = zf.testzip()
        if broken is not None:
            return fail("CRC check failed for " + broken)

    print("wrote %s (%d files, %d bytes in, %d bytes zipped)" % (out, len(names), total, out.stat().st_size))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
